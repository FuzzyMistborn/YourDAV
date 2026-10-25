import type {
  AddressBook,
  ApiError,
  Calendar,
  CalendarObject,
  Contact,
  CreateAddressBookInput,
  CreateCalendarInput,
  ContactInput,
  CreateEventInput,
  DeleteEventInput,
  GroupMembersInput,
  GroupMembersResult,
  ImportResult,
  LoginConfig,
  LoginRequest,
  OwnedShare,
  PendingShare,
  RenameGroupResult,
  SessionInfo,
  ShareCalendarInput,
  ShareCalendarResult,
  SharePermission,
  TransferContactInput,
  UnsubscribeResult,
  UpdateCalendarInput,
  UpdateContactInput,
  UpdateEventInput,
} from '@yourdav/shared'

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public body: ApiError,
  ) {
    super(body.message)
  }
}

// Fired whenever a request 401s outside of the login/whoami calls
// themselves -- the app is a single-view SPA (see router.ts), so nothing
// else re-checks auth once the initial route guard has passed, and a
// session that expires mid-tab (default 24h, see SESSION_TTL_DAYS)
// would otherwise just fail every subsequent save/delete/drag with a
// generic error and no indication the user needs to sign in again.
// main.ts/App.vue owns the actual redirect so this module doesn't need to
// import the router.
export const SESSION_EXPIRED_EVENT = 'yourdav:session-expired'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Normalised through Headers rather than object-spread, which silently
  // mangles the Headers / [name, value][] forms of HeadersInit.
  const headers = new Headers(init?.headers)
  // A JSON content-type with no body (e.g. DELETE /session, which takes no
  // request body) makes the browser reject the request outright -- only
  // send it when there's actually a body to describe.
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers,
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: 'unknown', message: res.statusText }))) as ApiError
    // Exclude /session itself -- a 401 there is either "not logged in yet"
    // (the router's own initial whoami check) or "wrong password" (the
    // login form), neither of which should bounce back to /login.
    if (res.status === 401 && path !== '/session') {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
    }
    throw new ApiRequestError(res.status, body)
  }

  if (res.status === 204) {
    return undefined as T
  }
  return (await res.json()) as T
}

export interface StoredSubscription {
  id: string
  name: string
  url: string
  color: string
}

export const api = {
  login: (body: LoginRequest) => request<SessionInfo>('/session', { method: 'POST', body: JSON.stringify(body) }),
  loginConfig: () => request<LoginConfig>('/session/config'),
  logout: () => request<void>('/session', { method: 'DELETE' }),
  whoami: () => request<SessionInfo>('/session'),
  listCalendars: () => request<Calendar[]>('/calendars'),
  createCalendar: (body: CreateCalendarInput) =>
    request<Calendar>('/calendars', { method: 'POST', body: JSON.stringify(body) }),
  updateCalendar: (calendarId: string, body: UpdateCalendarInput) =>
    request<Calendar>(`/calendars/${calendarId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  shareCalendar: (calendarId: string, body: ShareCalendarInput) =>
    request<ShareCalendarResult>(`/calendars/${calendarId}/share`, { method: 'POST', body: JSON.stringify(body) }),
  deleteCalendar: (calendarId: string) => request<void>(`/calendars/${calendarId}`, { method: 'DELETE' }),
  unsubscribeCalendar: (calendarId: string) =>
    request<UnsubscribeResult>(`/calendars/${calendarId}/unsubscribe`, { method: 'POST' }),
  listPendingShares: () => request<PendingShare[]>('/sharing/pending'),
  listShares: (calendarId: string) => request<OwnedShare[]>(`/sharing/calendars/${calendarId}/shares`),
  updateSharePermission: (calendarId: string, token: string, permission: SharePermission) =>
    request<void>(`/sharing/calendars/${calendarId}/shares/${encodeURIComponent(token)}`, {
      method: 'PATCH',
      body: JSON.stringify({ permission }),
    }),
  revokeShare: (calendarId: string, token: string) =>
    request<void>(`/sharing/calendars/${calendarId}/shares/${encodeURIComponent(token)}`, { method: 'DELETE' }),
  acceptPendingShare: (pathOrToken: string) =>
    request<void>('/sharing/pending/accept', { method: 'POST', body: JSON.stringify({ pathOrToken }) }),
  listEvents: (calendarId: string, start: string, end: string) =>
    request<CalendarObject[]>(
      `/calendars/${calendarId}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    ),
  createEvent: (calendarId: string, body: CreateEventInput) =>
    request<CalendarObject>(`/calendars/${calendarId}/events`, { method: 'POST', body: JSON.stringify(body) }),
  updateEvent: (calendarId: string, uid: string, body: UpdateEventInput) =>
    request<CalendarObject | { updatedSeries: CalendarObject; newSeries: CalendarObject }>(
      `/calendars/${calendarId}/events/${encodeURIComponent(uid)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  deleteEvent: (calendarId: string, uid: string, body: DeleteEventInput) =>
    request<CalendarObject | void>(`/calendars/${calendarId}/events/${encodeURIComponent(uid)}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    }),
  // Raw ICS for one event, as text (the export route sets a
  // Content-Disposition but still returns the body). Used to snapshot an
  // event before deleting it so the deletion can be undone.
  exportEventIcs: async (calendarId: string, uid: string, href: string): Promise<string> => {
    const res = await fetch(
      `/api/calendars/${calendarId}/events/${encodeURIComponent(uid)}/export?href=${encodeURIComponent(href)}`,
      { credentials: 'include' },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: 'unknown', message: res.statusText }))) as ApiError
      throw new ApiRequestError(res.status, body)
    }
    return res.text()
  },
  restoreEvent: (calendarId: string, uid: string, ics: string) =>
    request<CalendarObject>(`/calendars/${calendarId}/events/${encodeURIComponent(uid)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ ics }),
    }),
  search: (q: string) => request<CalendarObject[]>(`/search?q=${encodeURIComponent(q)}`),
  importIcs: (calendarId: string, ics: string) =>
    request<{ imported: number; total: number; skipped: number }>(`/calendars/${calendarId}/import`, {
      method: 'POST',
      body: JSON.stringify({ ics }),
    }),
  // Export endpoints are plain browser-navigated downloads (Content-Disposition:
  // attachment), not fetch() calls -- the session cookie already goes along
  // for a same-origin navigation, and this sidesteps request()'s built-in
  // assumption that every response is JSON.
  eventExportUrl: (calendarId: string, uid: string, href: string) =>
    `/api/calendars/${calendarId}/events/${encodeURIComponent(uid)}/export?href=${encodeURIComponent(href)}`,
  calendarExportUrl: (calendarId: string, start?: string, end?: string) => {
    const params = new URLSearchParams()
    if (start) params.set('start', start)
    if (end) params.set('end', end)
    const qs = params.toString()
    return `/api/calendars/${calendarId}/export${qs ? `?${qs}` : ''}`
  },
  getStoredSubscriptions: () =>
    request<{ subscriptions: StoredSubscription[] | null; invalid?: boolean }>('/subscriptions'),
  putStoredSubscriptions: (subscriptions: StoredSubscription[]) =>
    request<void>('/subscriptions', { method: 'PUT', body: JSON.stringify({ subscriptions }) }),
  getHolidayCountries: () => request<{ code: string; name: string }[]>('/subscriptions/holiday-countries'),
  getSubscriptionEvents: (url: string, start: string, end: string) =>
    request<CalendarObject[]>(
      `/subscriptions/events?url=${encodeURIComponent(url)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    ),

  // Address books & contacts
  getAddressBooks: () => request<AddressBook[]>('/addressbooks'),
  createAddressBook: (input: CreateAddressBookInput) =>
    request<AddressBook>('/addressbooks', { method: 'POST', body: JSON.stringify(input) }),
  deleteAddressBook: (bookId: string) => request<void>(`/addressbooks/${bookId}`, { method: 'DELETE' }),
  getContacts: (bookId: string) => request<Contact[]>(`/addressbooks/${bookId}/contacts`),
  createContact: (bookId: string, body: ContactInput) =>
    request<Contact>(`/addressbooks/${bookId}/contacts`, { method: 'POST', body: JSON.stringify(body) }),
  updateContact: (bookId: string, body: UpdateContactInput) =>
    request<Contact>(`/addressbooks/${bookId}/contacts`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteContact: (bookId: string, href: string, etag: string) =>
    request<void>(`/addressbooks/${bookId}/contacts?href=${encodeURIComponent(href)}&etag=${encodeURIComponent(etag)}`, {
      method: 'DELETE',
    }),
  transferContact: (bookId: string, body: TransferContactInput) =>
    request<Contact>(`/addressbooks/${bookId}/contacts/transfer`, { method: 'POST', body: JSON.stringify(body) }),
  setGroupMembers: (bookId: string, body: GroupMembersInput) =>
    request<GroupMembersResult>(`/addressbooks/${bookId}/groups/members`, { method: 'POST', body: JSON.stringify(body) }),
  renameGroup: (bookId: string, from: string, to: string) =>
    request<RenameGroupResult>(`/addressbooks/${bookId}/groups/rename`, {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),
  importVcf: (bookId: string, vcf: string) =>
    request<ImportResult>(`/addressbooks/${bookId}/import`, {
      method: 'POST',
      body: vcf,
      headers: { 'Content-Type': 'text/vcard' },
    }),
  // Plain URLs for <img src> / navigated downloads; the session cookie rides along same-origin.
  photoUrl: (bookId: string, href: string, etag: string) =>
    `/api/addressbooks/${bookId}/photo?href=${encodeURIComponent(href)}&v=${encodeURIComponent(etag)}`,
  exportUrl: (bookId: string) => `/api/addressbooks/${bookId}/export`,
}
