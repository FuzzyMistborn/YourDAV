import type { FastifyInstance, FastifyReply } from 'fastify'
import { assertHrefSameHost } from '../dav/hostAllowlist.js'
import type { DavContext } from '../dav/context.js'
import {
  acceptRadicaleShare,
  listPendingRadicaleShares,
  listSharesForCalendar,
  revokeShare,
  ShareFailedError,
  updateSharePermission,
} from '../dav/sharing.js'
import { decodeUrlId } from '../store/idCodec.js'
import { store } from '../store/index.js'
import { requireSession } from './requireSession.js'

/** Owner-only: 403s if the calendar isn't one the caller owns. */
async function requireOwnedCalendar(dav: DavContext, calendarId: string, reply: FastifyReply): Promise<boolean> {
  const calendars = await store.discoverCalendars(dav)
  const calendar = calendars.find((c) => c.id === calendarId)
  if (!calendar) {
    reply.code(404).send({ error: 'not_found', message: 'Calendar not found' })
    return false
  }
  if (calendar.isShared) {
    reply.code(403).send({ error: 'forbidden', message: 'Only the calendar owner can manage its shares' })
    return false
  }
  return true
}

export async function sharingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pending', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return

    const pending = await listPendingRadicaleShares(dav)
    return reply.send(pending)
  })

  app.post<{ Body: { pathOrToken: string } }>('/pending/accept', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return

    if (!req.body?.pathOrToken) {
      return reply.code(400).send({ error: 'bad_request', message: 'pathOrToken is required' })
    }

    try {
      await acceptRadicaleShare(dav, req.body.pathOrToken)
      return reply.code(204).send()
    } catch (err) {
      if (err instanceof ShareFailedError) {
        return reply.code(422).send({ error: 'accept_failed', message: err.message })
      }
      throw err
    }
  })

  app.get<{ Params: { id: string } }>('/calendars/:id/shares', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    if (!(await requireOwnedCalendar(dav, req.params.id, reply))) return

    const calendarUrl = decodeUrlId(req.params.id)
    assertHrefSameHost(dav.baseUrl, calendarUrl)
    const shares = await listSharesForCalendar(dav, calendarUrl)
    return reply.send(shares)
  })

  app.patch<{ Params: { id: string; token: string }; Body: { permission: 'read' | 'readwrite' } }>(
    '/calendars/:id/shares/:token',
    async (req, reply) => {
      const dav = requireSession(req, reply)
      if (!dav) return
      if (!(await requireOwnedCalendar(dav, req.params.id, reply))) return

      if (req.body?.permission !== 'read' && req.body?.permission !== 'readwrite') {
        return reply.code(400).send({ error: 'bad_request', message: 'a valid permission is required' })
      }

      const calendarUrl = decodeUrlId(req.params.id)
      assertHrefSameHost(dav.baseUrl, calendarUrl)

      try {
        await updateSharePermission(dav, calendarUrl, req.params.token, req.body.permission)
        return reply.code(204).send()
      } catch (err) {
        if (err instanceof ShareFailedError) {
          return reply.code(422).send({ error: 'update_failed', message: err.message })
        }
        throw err
      }
    },
  )

  app.delete<{ Params: { id: string; token: string } }>('/calendars/:id/shares/:token', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    if (!(await requireOwnedCalendar(dav, req.params.id, reply))) return

    const calendarUrl = decodeUrlId(req.params.id)
    assertHrefSameHost(dav.baseUrl, calendarUrl)

    try {
      await revokeShare(dav, calendarUrl, req.params.token)
      return reply.code(204).send()
    } catch (err) {
      if (err instanceof ShareFailedError) {
        return reply.code(422).send({ error: 'revoke_failed', message: err.message })
      }
      throw err
    }
  })
}
