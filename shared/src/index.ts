export interface TimeRange {
  start: string // ISO 8601
  end: string // ISO 8601
}

export interface CreateCalendarInput {
  displayName: string
  color?: string
}

export interface UpdateCalendarInput {
  displayName?: string
  color?: string
}

export interface Calendar {
  id: string
  displayName: string
  color: string
  readOnly: boolean
  supportsEvents: boolean
  supportsTasks: boolean
  ctag: string | null
  // True if this calendar was shared to the current user by someone else,
  // as opposed to one they own. Detected differently per server -- see
  // DavCalendarStore.discoverCalendars.
  isShared: boolean
}

export interface CalendarObject {
  uid: string
  etag: string
  href: string // opaque resource locator; echoed back verbatim on writes, never parsed by the client
  calendarId: string
  summary: string
  description: string | null
  location: string | null
  start: string // ISO 8601
  end: string // ISO 8601
  allDay: boolean
  timezone: string | null
  recurrenceId: string | null // ISO 8601 if this is an override occurrence
  isRecurring: boolean
  rrule: string | null
  // RFC 7986 COLOR -- per-event override of the owning calendar's color.
  // null/absent means "use the calendar's color."
  color: string | null
  alarms: AlarmFields[]
  rdate: string[]
}

export type EditScope = 'this' | 'thisAndFuture' | 'all'

// v1 scope: a single relative-before-start DISPLAY alarm per entry. Does
// not model TRIGGER relative to DTEND, ACTION other than DISPLAY, or
// repeating alarms (VALARM's own REPEAT/DURATION) -- those are simply not
// read back as AlarmFields (see mapper.ts), same "unsupported, falls back
// silently" posture EventEditDialog.vue already takes for exotic RRULEs.
export interface AlarmFields {
  minutesBefore: number
}

export interface EventFields {
  summary: string
  description: string | null
  location: string | null
  start: string // ISO 8601
  end: string // ISO 8601
  allDay: boolean
  timezone: string | null
  rrule: string | null
  color: string | null
  alarms: AlarmFields[]
  // Explicit one-off occurrence dates on top of rrule (ISO 8601). Only
  // meaningful alongside a non-null rrule; ignored/empty for non-recurring
  // events.
  rdate: string[]
}

export type CreateEventInput = EventFields

export interface UpdateEventInput {
  href: string
  etag: string
  fields: EventFields
  scope: EditScope
  recurrenceId: string | null // required when scope is 'this' or 'thisAndFuture'
  // Target calendar for the event. Omitted/unchanged from the current
  // calendar for a normal edit; a different id moves the event (only
  // supported for scope 'all' -- see routes/calendars.ts).
  calendarId?: string
}

export interface DeleteEventInput {
  href: string
  etag: string
  scope: EditScope
  recurrenceId: string | null
}

export interface SyncResult {
  syncToken: string
  changed: CalendarObject[]
  // hrefs, not UIDs -- a sync-collection REPORT's deleted entries only
  // ever carry the object's href, never its UID (the object is gone, so
  // there's nothing left to parse a UID out of).
  deletedHrefs: string[]
}

export interface SessionInfo {
  serverUrl: string
  username: string
  // Server-configured fallback timezone (DEFAULT_TIMEZONE env var), or null
  // if unset -- the client falls back further to the browser's own zone.
  defaultTimezone: string | null
  // Running release: the git tag (e.g. "v0.4.0") for a tagged image build,
  // or "dev" for anything else (untagged main builds, local runs).
  version: string
  // Whether the account also has CardDAV address books; the Contacts half of
  // the app is hidden when it does not.
  hasContacts: boolean
}

/** Pre-login settings; serverUrl is non-null when the admin fixed it via DAV_SERVER_URL. */
export interface LoginConfig {
  serverUrl: string | null
}

export interface LoginRequest {
  serverUrl?: string
  username: string
  password: string
}

export interface ApiError {
  error: string
  message: string
}

export type SharePermission = 'read' | 'readwrite'

export interface ShareCalendarInput {
  // Radicale shares match this against the recipient's exact username;
  // Baikal shares match it as a `mailto:` calendar-user-address, which
  // must equal the recipient's actual registered email. The two servers
  // use unrelated identifiers -- the app tries this value against
  // whichever mechanism the server supports.
  recipient: string
  permission: SharePermission
}

// An existing share the current user, as owner, has created for a
// calendar -- distinct from PendingShare, which is the recipient-side view
// of an unaccepted Radicale share.
export interface OwnedShare {
  recipient: string
  permission: SharePermission
  // Radicale: recipient has enabled+unhidden their own side. Baikal: always
  // true (its shares auto-accept, no separate acceptance step).
  accepted: boolean
  mechanism: 'radicale-map' | 'baikal-caldav-sharing'
  // Opaque; echoed back verbatim to update/revoke this specific share.
  // Never parsed by the client.
  token: string
}

export interface ShareCalendarResult {
  mechanism: 'radicale-map' | 'baikal-caldav-sharing'
  // Radicale requires the recipient to separately enable+unhide their own
  // side before the share is usable -- see PendingShare below for how the
  // recipient does that in-app. Baikal auto-accepts immediately.
  // `pending: true` means the owner's half is done but the recipient
  // still needs to accept.
  pending: boolean
}

// A Radicale map share the current user is the recipient of but hasn't yet
// enabled+unhidden their own side of -- see AGENTS.md "Calendar sharing"
// for why this step can't be skipped or automated on the owner's behalf.
// Baikal has no equivalent concept (its shares auto-accept), so this is
// always empty on Baikal.
export interface PendingShare {
  // Opaque; echoed back verbatim to accept this share. Never parsed by the client.
  pathOrToken: string
  owner: string
  // Best-effort label (derived from the shared collection's path) since
  // Radicale's sharing API doesn't expose the owner's display name for it.
  label: string
  // Radicale's TimestampUpdated (unix ms) for this share entry. Lets the
  // client tell "the owner changed something since I last dismissed this"
  // apart from an unsubscribe/hide simply resurfacing unchanged -- see
  // UnsubscribeResult.dismissedPending and PendingSharesList.vue.
  updatedAt: number
}

export interface UnsubscribeResult {
  // Set only when the recipient's own "hide" action was used to leave a
  // Radicale map share (rather than a real DAV delete, which Baikal uses
  // and which needs no client-side bookkeeping). Radicale's sharing model
  // has no separate "declined" state -- a hidden-but-still-owner-enabled
  // share is otherwise indistinguishable from one never accepted, so
  // without this the same share would immediately resurface in the
  // pending list on the next load. The client stores this to suppress
  // that specific share until its `updatedAt` moves past `dismissedAt`
  // (i.e. the owner actually does something new with it).
  dismissedPending: { pathOrToken: string; dismissedAt: number } | null
}

// --- Contacts (CardDAV) ---

export interface AddressBook {
  /** Opaque id; the client echoes it back and never parses it. */
  id: string
  /** The collection's CardDAV URL, for pointing other clients at it. */
  url: string
  displayName: string
  description: string | null
  readOnly: boolean
  ctag: string | null
}

export interface CreateAddressBookInput {
  displayName: string
}

export interface LabeledValue {
  value: string
  /** Lowercased vCard TYPE tokens, e.g. ['home'], ['work', 'voice'], ['cell']. */
  types: string[]
  pref: boolean
}

export interface PostalAddress {
  types: string[]
  poBox: string
  extended: string
  street: string
  locality: string
  region: string
  postalCode: string
  country: string
}

export interface StructuredName {
  family: string
  given: string
  additional: string
  prefix: string
  suffix: string
}

export interface Contact {
  /** Opaque id; the client echoes it back and never parses it. */
  id: string
  addressBookId: string
  /** Opaque locator of the .vcf resource; echoed back on write. */
  href: string
  etag: string
  uid: string
  version: '3.0' | '4.0'
  fullName: string
  name: StructuredName
  nickname: string
  org: string
  title: string
  emails: LabeledValue[]
  phones: LabeledValue[]
  urls: LabeledValue[]
  addresses: PostalAddress[]
  /** YYYY-MM-DD, or --MM-DD when the year is unknown. Empty when unset. */
  birthday: string
  anniversary: string
  notes: string
  categories: string[]
  hasPhoto: boolean
}

/** Editable subset of a Contact; everything else on the card is preserved server-side. */
export interface ContactInput {
  name: StructuredName
  fullName?: string
  nickname: string
  org: string
  title: string
  emails: LabeledValue[]
  phones: LabeledValue[]
  urls: LabeledValue[]
  addresses: PostalAddress[]
  birthday: string
  anniversary: string
  notes: string
  categories: string[]
  /** data: URI to set the photo, null to remove it, omitted to leave it alone. */
  photo?: string | null
}

export interface UpdateContactInput extends ContactInput {
  href: string
  etag: string
}

export interface DeleteContactInput {
  href: string
  etag: string
}

export interface ImportResult {
  imported: number
  skipped: number
}

export interface RenameGroupInput {
  from: string
  to: string
}

export interface RenameGroupResult {
  updated: number
  failed: number
}

export interface TransferContactInput {
  href: string
  etag: string
  targetBookId: string
  /** 'move' deletes the original; 'copy' leaves it and gives the copy a new UID. */
  mode: 'move' | 'copy'
}

export interface GroupMembersInput {
  items: { href: string; etag: string }[]
  /** Exactly one of add / remove. */
  add?: string
  remove?: string
}

export interface GroupMembersResult {
  updated: number
  /** Cards that were already in (or not in) the group. */
  unchanged: number
  failed: number
}
