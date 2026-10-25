import type {
  Calendar,
  CalendarObject,
  CreateCalendarInput,
  SyncResult,
  TimeRange,
  UnsubscribeResult,
  UpdateCalendarInput,
} from '@yourdav/shared'
import type { DavContext } from '../dav/context.js'

export interface ObjectRef {
  calendarId: string
  uid: string
  href: string
  etag: string
}

export interface RawObject {
  ics: string
  etag: string
}

export interface RawObjectWithHref extends RawObject {
  href: string
}

export interface CalendarStore {
  discoverCalendars(ctx: DavContext): Promise<Calendar[]>
  createCalendar(ctx: DavContext, input: CreateCalendarInput): Promise<Calendar>
  /** Renames/recolors a calendar via PROPPATCH (a recipient's change stays on their own mount). */
  updateCalendar(ctx: DavContext, calendarId: string, input: UpdateCalendarInput): Promise<Calendar>
  getEvents(ctx: DavContext, calendarId: string, range: TimeRange): Promise<CalendarObject[]>
  /**
   * Optional: full-history substring search backed by a real index.
   * Present only on stores that maintain one (SqliteCalendarStore) -- the
   * plain DAV store has no server-side text search, so the search route
   * falls back to its own bounded getEvents sweep when this is absent.
   * Returns one CalendarObject per matching stored object (the series
   * master for a recurring event, not every occurrence); the caller sorts
   * and caps.
   */
  searchEvents?(ctx: DavContext, query: string): Promise<CalendarObject[]>
  getRawObject(ctx: DavContext, href: string): Promise<RawObject>
  /**
   * Batched form of getRawObject -- one CalDAV round trip for many hrefs,
   * instead of one per href. Exists for SqliteCalendarStore's sync path,
   * which needs raw ICS for every object syncCalendar() reports as
   * changed (SyncResult.changed only carries already-parsed
   * CalendarObjects, not raw ICS) without doing N logins for N objects.
   */
  getRawObjects(ctx: DavContext, hrefs: string[]): Promise<RawObjectWithHref[]>
  syncCalendar(ctx: DavContext, calendarId: string, syncToken?: string): Promise<SyncResult>
  createObject(ctx: DavContext, calendarId: string, ics: string): Promise<CalendarObject>
  updateObject(ctx: DavContext, obj: ObjectRef, ics: string): Promise<CalendarObject>
  deleteObject(ctx: DavContext, obj: ObjectRef): Promise<void>
  /** Owner-only: deletes the whole calendar collection, which also revokes it for every recipient it was shared with. */
  deleteCalendar(ctx: DavContext, calendarId: string): Promise<void>
  /** Recipient-only: removes a shared calendar from just the current user's own view, leaving the owner's calendar and any other recipients untouched. */
  unsubscribeCalendar(ctx: DavContext, calendarId: string): Promise<UnsubscribeResult>
}
