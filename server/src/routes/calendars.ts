import type {
  CreateCalendarInput,
  CreateEventInput,
  DeleteEventInput,
  ShareCalendarInput,
  UpdateCalendarInput,
  UpdateEventInput,
} from '@yourdav/shared'
import type { Calendar } from '@yourdav/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import ICAL from 'ical.js'
import { assertHrefSameHost } from '../dav/hostAllowlist.js'
import { shareCalendar, ShareFailedError } from '../dav/sharing.js'
import type { DavContext } from '../dav/context.js'
import * as editScope from '../ical/editScope.js'
import { mergeIcsObjects } from '../ical/exportIcs.js'
import { splitImportIcsCapped } from '../ical/importIcs.js'
import { DAV_WRITE_CONCURRENCY, mapConcurrent } from '../concurrency.js'
import { config } from '../config.js'
import { calendarObjectToIcs } from '../ical/mapper.js'
import { eventFieldsError, timeRangeError } from '../ical/validate.js'
import { decodeId } from '../store/idCodec.js'
import { EtagConflictError } from '../store/errors.js'
import type { RawObject } from '../store/CalendarStore.js'
import { store } from '../store/index.js'
import { requireSession } from './requireSession.js'

/**
 * Server-side gate for write routes: looks up the calendar via
 * discoverCalendars (which now does real current-user-privilege-set
 * discovery) and 403s if it's read-only. Hiding the edit UI client-side
 * isn't sufficient on its own -- same principle as the ownership checks
 * added for delete/unsubscribe/PATCH. Returns null (having already sent a
 * reply) when the write should be rejected.
 */
async function requireWritableCalendar(
  dav: DavContext,
  calendarId: string,
  reply: FastifyReply,
): Promise<Calendar | null> {
  const calendars = await store.discoverCalendars(dav)
  const calendar = calendars.find((c) => c.id === calendarId)
  if (!calendar) {
    reply.code(404).send({ error: 'not_found', message: 'Calendar not found' })
    return null
  }
  if (calendar.readOnly) {
    reply.code(403).send({ error: 'forbidden', message: 'This calendar is read-only' })
    return null
  }
  return calendar
}

/**
 * Server-side gate against cross-calendar event mutation: a request can
 * carry a writable calendarId paired with a client-supplied href/uid for a
 * *different* calendar (e.g. one the caller can't otherwise write to). This
 * fetches the raw object and verifies both that its href actually lives
 * under this calendar's own collection URL and that its UID matches the
 * one in the route -- not just that the href resolves to *some* object the
 * caller's DAV credentials can read. 403s (having already sent a reply)
 * when either check fails.
 */
async function loadOwnedRawObject(
  dav: DavContext,
  calendar: Calendar,
  href: string,
  uid: string,
  reply: FastifyReply,
): Promise<RawObject | null> {
  const calendarUrl = decodeId(calendar.id)
  assertHrefSameHost(dav.baseUrl, href)
  // Normalize the collection path to a trailing slash so the prefix test
  // is a real segment-boundary check: without it, a collection URL served
  // without a trailing slash would let `/calendars/foo` prefix-match
  // `/calendars/foobar/...`. Defense-in-depth -- the DAV server enforces
  // real permissions underneath.
  const rawCalPath = new URL(calendarUrl).pathname
  const calPath = rawCalPath.endsWith('/') ? rawCalPath : `${rawCalPath}/`
  const hrefPath = new URL(href, calendarUrl).pathname
  if (!hrefPath.startsWith(calPath)) {
    reply.code(403).send({ error: 'forbidden', message: 'Event does not belong to this calendar' })
    return null
  }

  const raw = await store.getRawObject(dav, href)
  const comp = new ICAL.Component(ICAL.parse(raw.ics))
  const vevent = comp.getFirstSubcomponent('vevent')
  const rawUid = vevent?.getFirstPropertyValue('uid') as string | null
  if (rawUid !== uid) {
    reply.code(403).send({ error: 'forbidden', message: 'Event does not belong to this calendar' })
    return null
  }
  return raw
}

// Wide-enough default range for a "whole calendar" export when no
// start/end is given -- broad but bounded, rather than an unbounded query
// some CalDAV servers may not handle well.
const EXPORT_DEFAULT_START = '1970-01-01T00:00:00.000Z'
const EXPORT_DEFAULT_END = '2100-01-01T00:00:00.000Z'

/** Strips characters that would break out of a Content-Disposition filename. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"]/g, '').slice(0, 100) || 'export'
}

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return

    const calendars = await store.discoverCalendars(dav)
    return reply.send(calendars)
  })

  app.post<{ Body: CreateCalendarInput }>('/', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return

    if (!req.body?.displayName?.trim()) {
      return reply.code(400).send({ error: 'bad_request', message: 'displayName is required' })
    }

    const created = await store.createCalendar(dav, req.body)
    return reply.code(201).send(created)
  })

  app.post<{ Params: { id: string }; Body: ShareCalendarInput }>('/:id/share', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return

    if (!req.body?.recipient?.trim() || (req.body.permission !== 'read' && req.body.permission !== 'readwrite')) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'recipient and a valid permission are required' })
    }

    const calendars = await store.discoverCalendars(dav)
    const calendar = calendars.find((c) => c.id === req.params.id)
    if (!calendar) {
      return reply.code(404).send({ error: 'not_found', message: 'Calendar not found' })
    }
    if (calendar.isShared) {
      return reply.code(403).send({ error: 'forbidden', message: 'Only the calendar owner can manage its shares' })
    }

    const calendarUrl = decodeId(req.params.id)
    assertHrefSameHost(dav.baseUrl, calendarUrl)

    try {
      const result = await shareCalendar(dav, calendarUrl, req.body)
      return reply.send(result)
    } catch (err) {
      if (err instanceof ShareFailedError) {
        return reply.code(422).send({ error: 'share_failed', message: err.message })
      }
      throw err
    }
  })

  app.patch<{ Params: { id: string }; Body: UpdateCalendarInput }>('/:id', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return

    if (req.body?.displayName !== undefined && !req.body.displayName.trim()) {
      return reply.code(400).send({ error: 'bad_request', message: 'displayName cannot be empty' })
    }

    const calendars = await store.discoverCalendars(dav)
    const calendar = calendars.find((c) => c.id === req.params.id)
    if (!calendar) {
      return reply.code(404).send({ error: 'not_found', message: 'Calendar not found' })
    }
    // A recipient may rename a shared calendar for themselves: both Radicale
    // and Baikal keep the recipient's displayname private to their own mount
    // (verified: the owner's name is untouched, and the recipient's name
    // survives a later owner rename on Radicale). Color stays an owner
    // property -- recipients recolor locally in the browser instead.
    if (calendar.isShared && req.body?.color !== undefined) {
      return reply.code(403).send({ error: 'forbidden', message: 'Only the owner can recolor this calendar' })
    }

    try {
      const updated = await store.updateCalendar(dav, req.params.id, req.body ?? {})
      return reply.send(updated)
    } catch (err) {
      if (err instanceof ShareFailedError) {
        return reply.code(422).send({ error: 'update_failed', message: err.message })
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return

    // Server-side ownership check: DELETE issues a raw DAV DELETE against
    // the underlying collection, which for a Radicale-mounted share
    // deletes the *owner's* real calendar, not just this user's view of
    // it. Without this, any authenticated user could delete a calendar
    // shared to them (or, via unsubscribe below, one they don't even have
    // a share record for) -- the UI only hides the button, it doesn't
    // stop the request.
    const calendars = await store.discoverCalendars(dav)
    const calendar = calendars.find((c) => c.id === req.params.id)
    if (!calendar) {
      return reply.code(404).send({ error: 'not_found', message: 'Calendar not found' })
    }
    if (calendar.isShared) {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'Only the owner can delete this calendar; use unsubscribe instead' })
    }

    try {
      await store.deleteCalendar(dav, req.params.id)
      return reply.code(204).send()
    } catch (err) {
      if (err instanceof ShareFailedError) {
        return reply.code(422).send({ error: 'delete_failed', message: err.message })
      }
      throw err
    }
  })

  app.post<{ Params: { id: string } }>('/:id/unsubscribe', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return

    // Mirror image of the delete check above: unsubscribeCalendar()'s
    // fallback path issues a plain DAV DELETE for any calendar it can't
    // positively confirm is a Radicale share, so calling this on a
    // normal owned calendar would delete it outright. Require the
    // calendar to actually be shared-to-this-user first.
    const calendars = await store.discoverCalendars(dav)
    const calendar = calendars.find((c) => c.id === req.params.id)
    if (!calendar) {
      return reply.code(404).send({ error: 'not_found', message: 'Calendar not found' })
    }
    if (!calendar.isShared) {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'Only calendars shared with you can be unsubscribed from' })
    }

    try {
      const result = await store.unsubscribeCalendar(dav, req.params.id)
      return reply.send(result)
    } catch (err) {
      if (err instanceof ShareFailedError) {
        return reply.code(422).send({ error: 'unsubscribe_failed', message: err.message })
      }
      throw err
    }
  })

  app.get<{ Params: { id: string }; Querystring: { start?: string; end?: string } }>(
    '/:id/events',
    async (req, reply) => {
      const dav = requireSession(req, reply)
      if (!dav) return

      const { start, end } = req.query
      const rangeError = timeRangeError(start, end)
      if (rangeError) {
        return reply.code(400).send({ error: 'bad_request', message: rangeError })
      }

      const events = await store.getEvents(dav, req.params.id, { start: start as string, end: end as string })
      return reply.send(events)
    },
  )

  app.get<{ Params: { id: string }; Querystring: { start?: string; end?: string } }>(
    '/:id/export',
    async (req, reply) => {
      const dav = requireSession(req, reply)
      if (!dav) return

      const start = req.query.start ?? EXPORT_DEFAULT_START
      const end = req.query.end ?? EXPORT_DEFAULT_END
      const rangeError = timeRangeError(start, end)
      if (rangeError) {
        return reply.code(400).send({ error: 'bad_request', message: rangeError })
      }

      // getEvents returns one expanded CalendarObject per *occurrence* --
      // dedupe by href (all occurrences of a recurring series share the
      // master object's href) before fetching raw ICS, so a recurring
      // series isn't fetched/merged once per occurrence.
      const events = await store.getEvents(dav, req.params.id, { start, end })
      const hrefs = [...new Set(events.map((e) => e.href))]
      const raw = await store.getRawObjects(dav, hrefs)
      const ics = mergeIcsObjects(raw.map((r) => r.ics))

      const calendars = await store.discoverCalendars(dav)
      const name = calendars.find((c) => c.id === req.params.id)?.displayName ?? 'calendar'

      reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${sanitizeFilename(name)}.ics"`)
        .send(ics)
    },
  )

  app.post<{ Params: { id: string }; Body: CreateEventInput }>('/:id/events', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    if (!(await requireWritableCalendar(dav, req.params.id, reply))) return

    const fieldsError = eventFieldsError(req.body)
    if (fieldsError) {
      return reply.code(400).send({ error: 'bad_request', message: fieldsError })
    }

    const uid = crypto.randomUUID()
    const ics = calendarObjectToIcs(uid, req.body)
    const created = await store.createObject(dav, req.params.id, ics)
    return reply.code(201).send(created)
  })

  // Re-create a CalDAV object from a full ICS blob, preserving the UID (and
  // RRULE, EXDATEs, per-occurrence overrides) it carries. Backs the "Undo"
  // on an event deletion: the client snapshots the raw ICS via the export
  // route before deleting, then POSTs it back here. A fresh href/filename is
  // fine -- same as the plain create path. The client is responsible for
  // removing any object that still holds this UID (a 'this'/'thisAndFuture'
  // delete only modifies the object in place) before calling this.
  app.post<{ Params: { id: string; uid: string }; Body: { ics: string } }>(
    '/:id/events/:uid/restore',
    { bodyLimit: 5 * 1024 * 1024 },
    async (req, reply) => {
      const dav = requireSession(req, reply)
      if (!dav) return
      if (!(await requireWritableCalendar(dav, req.params.id, reply))) return

      if (!req.body?.ics || typeof req.body.ics !== 'string') {
        return reply.code(400).send({ error: 'bad_request', message: 'ics is required' })
      }
      try {
        new ICAL.Component(ICAL.parse(req.body.ics))
      } catch {
        return reply.code(400).send({ error: 'bad_request', message: 'Could not parse ICS' })
      }

      const created = await store.createObject(dav, req.params.id, req.body.ics)
      return reply.code(201).send(created)
    },
  )

  // ICS exports of a few thousand events run well past Fastify's default
  // 1MB body limit; without this a large but legitimate import 413s before
  // the handler (and its maxImportEvents cap) ever runs.
  app.post<{ Params: { id: string }; Body: { ics: string } }>(
    '/:id/import',
    { bodyLimit: 25 * 1024 * 1024 },
    async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    if (!(await requireWritableCalendar(dav, req.params.id, reply))) return

    if (!req.body?.ics) {
      return reply.code(400).send({ error: 'bad_request', message: 'ics is required' })
    }

    let icsGroups: string[]
    let skipped: number
    try {
      ;({ groups: icsGroups, skipped } = splitImportIcsCapped(req.body.ics))
    } catch {
      return reply.code(400).send({ error: 'bad_request', message: 'Could not parse ICS file' })
    }
    if (icsGroups.length === 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'No events found in file' })
    }

    let imported = 0
    await mapConcurrent(icsGroups, DAV_WRITE_CONCURRENCY, async (ics) => {
      try {
        await store.createObject(dav, req.params.id, ics)
        imported++
      } catch (err) {
        req.log.warn({ err }, 'Failed to import one event from ICS file; continuing with the rest')
      }
    })
    if (skipped > 0) req.log.warn({ skipped, limit: config.maxImportEvents }, 'ICS import hit MAX_IMPORT_EVENTS; events skipped')
    return reply.send({ imported, total: icsGroups.length + skipped, skipped })
  })

  app.put<{ Params: { id: string; uid: string }; Body: UpdateEventInput }>(
    '/:id/events/:uid',
    async (req, reply) => {
      const dav = requireSession(req, reply)
      if (!dav) return
      const calendar = await requireWritableCalendar(dav, req.params.id, reply)
      if (!calendar) return

      if (!req.body || typeof req.body.href !== 'string' || typeof req.body.etag !== 'string') {
        return reply.code(400).send({ error: 'bad_request', message: 'href and etag are required' })
      }
      const { href, etag, fields, scope, recurrenceId } = req.body
      const calendarId = req.params.id
      const uid = req.params.uid

      const fieldsError = eventFieldsError(fields)
      if (fieldsError) {
        return reply.code(400).send({ error: 'bad_request', message: fieldsError })
      }

      try {
        if (scope === 'this' || scope === 'thisAndFuture') {
          if (!recurrenceId) {
            return reply
              .code(400)
              .send({ error: 'bad_request', message: 'recurrenceId is required for this scope' })
          }

          const raw = await loadOwnedRawObject(dav, calendar, href, uid, reply)
          if (!raw) return

          if (scope === 'this') {
            const newIcs = editScope.applyThisOccurrence(raw.ics, recurrenceId, fields)
            const updated = await store.updateObject(dav, { calendarId, uid, href, etag }, newIcs)
            return reply.send(updated)
          }

          // Create the new (future) series before truncating the old one --
          // if creation fails, the old series is untouched rather than
          // silently losing every future occurrence. The reverse order risks
          // a duplicate/orphaned new series on truncate failure instead,
          // which is recoverable by hand; losing the future occurrences
          // outright is not.
          const split = editScope.applyThisAndFuture(raw.ics, recurrenceId, fields)
          const newSeries = await store.createObject(dav, calendarId, split.newSeriesIcs)
          const updated = await store.updateObject(dav, { calendarId, uid, href, etag }, split.updatedIcs)
          return reply.send({ updatedSeries: updated, newSeries })
        }

        // scope === 'all'
        const raw = await loadOwnedRawObject(dav, calendar, href, uid, reply)
        if (!raw) return
        const newIcs = editScope.applyAll(raw.ics, fields)

        const targetCalendarId = req.body.calendarId
        if (targetCalendarId && targetCalendarId !== calendarId) {
          // Moving calendars: CalDAV has no rename/move verb, so re-create the
          // object on the target calendar and delete the original -- if the
          // create fails, the original is untouched rather than losing the event.
          if (!(await requireWritableCalendar(dav, targetCalendarId, reply))) return
          const created = await store.createObject(dav, targetCalendarId, newIcs)
          await store.deleteObject(dav, { calendarId, uid, href, etag })
          return reply.send(created)
        }

        const updated = await store.updateObject(dav, { calendarId, uid, href, etag }, newIcs)
        return reply.send(updated)
      } catch (err) {
        if (err instanceof EtagConflictError) {
          return reply.code(412).send({ error: 'conflict', message: err.message })
        }
        throw err
      }
    },
  )

  app.get<{ Params: { id: string; uid: string }; Querystring: { href?: string } }>(
    '/:id/events/:uid/export',
    async (req, reply) => {
      const dav = requireSession(req, reply)
      if (!dav) return

      if (!req.query.href) {
        return reply.code(400).send({ error: 'bad_request', message: 'href query param is required' })
      }

      // Apply the same ownership discipline the write routes get
      // (href-under-calendar-path + UID match) rather than fetching any
      // same-host href the caller's credentials can read.
      const calendars = await store.discoverCalendars(dav)
      const calendar = calendars.find((c) => c.id === req.params.id)
      if (!calendar) {
        return reply.code(404).send({ error: 'not_found', message: 'Calendar not found' })
      }
      const raw = await loadOwnedRawObject(dav, calendar, req.query.href, req.params.uid, reply)
      if (!raw) return
      reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${sanitizeFilename(req.params.uid)}.ics"`)
        .send(raw.ics)
    },
  )

  app.delete<{ Params: { id: string; uid: string }; Body: DeleteEventInput }>(
    '/:id/events/:uid',
    async (req, reply) => {
      const dav = requireSession(req, reply)
      if (!dav) return
      const calendar = await requireWritableCalendar(dav, req.params.id, reply)
      if (!calendar) return

      if (!req.body || typeof req.body.href !== 'string' || typeof req.body.etag !== 'string') {
        return reply.code(400).send({ error: 'bad_request', message: 'href and etag are required' })
      }
      const { href, etag, scope, recurrenceId } = req.body
      const calendarId = req.params.id
      const uid = req.params.uid

      try {
        if (scope === 'all' || !recurrenceId) {
          if (!(await loadOwnedRawObject(dav, calendar, href, uid, reply))) return
          await store.deleteObject(dav, { calendarId, uid, href, etag })
          return reply.code(204).send()
        }

        const raw = await loadOwnedRawObject(dav, calendar, href, uid, reply)
        if (!raw) return
        const newIcs =
          scope === 'this'
            ? editScope.deleteThisOccurrence(raw.ics, recurrenceId)
            : editScope.deleteThisAndFuture(raw.ics, recurrenceId)
        const updated = await store.updateObject(dav, { calendarId, uid, href, etag }, newIcs)
        return reply.send(updated)
      } catch (err) {
        if (err instanceof EtagConflictError) {
          return reply.code(412).send({ error: 'conflict', message: err.message })
        }
        throw err
      }
    },
  )
}
