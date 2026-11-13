import type { EventFields, EventShift } from '@yourdav/shared'
import ICAL from 'ical.js'
import { buildVeventComponent } from './mapper.js'
import { registerEmbeddedTimezones } from './timezones.js'

function parseCalendar(ics: string): ICAL.Component {
  const comp = new ICAL.Component(ICAL.parse(ics))
  registerEmbeddedTimezones(comp)
  return comp
}

function getMaster(comp: ICAL.Component): ICAL.Component {
  const master = comp.getAllSubcomponents('vevent').find((v) => !v.hasProperty('recurrence-id'))
  if (!master) throw new Error('No master VEVENT found in recurring series')
  return master
}

function getRecurrenceId(vevent: ICAL.Component): ICAL.Time | null {
  return vevent.getFirstPropertyValue('recurrence-id') as ICAL.Time | null
}

/** Whether the master's own DTSTART is DATE-typed (all-day) -- the value type a
 * RECURRENCE-ID/boundary must match, regardless of what an edit's new fields say. */
function masterIsAllDay(master: ICAL.Component): boolean {
  return (master.getFirstPropertyValue('dtstart') as ICAL.Time).isDate
}

// For all-day (DATE-typed) instants, fromJSDate would convert through the
// JS Date first (shifting across a UTC/local boundary depending on the
// server's own timezone) -- fromDateString builds a real DATE-typed value
// directly from the date portion of the ISO string, with no conversion to
// go wrong. Same fix as buildVeventComponent's dtstart/dtend (mapper.ts).
function icalTimeFromIso(iso: string, allDay: boolean): ICAL.Time {
  return allDay ? ICAL.Time.fromDateString(iso.slice(0, 10)) : ICAL.Time.fromJSDate(new Date(iso), true)
}

/** Number of `recur`'s own occurrences (starting at `dtstart`) that fall strictly before `boundary`. */
function countOccurrencesBefore(recur: ICAL.Recur, dtstart: ICAL.Time, boundary: ICAL.Time): number {
  const iterator = recur.iterator(dtstart)
  let count = 0
  let occurrence = iterator.next()
  while (occurrence && occurrence.compare(boundary) < 0) {
    count++
    occurrence = iterator.next()
  }
  return count
}

/** Bounds a master's RRULE so it produces no occurrence at or after `boundary`. */
function truncateRrule(master: ICAL.Component, boundary: ICAL.Time): void {
  const rrule = master.getFirstProperty('rrule')
  if (!rrule) return
  const recur = rrule.getFirstValue() as ICAL.Recur
  const until = boundary.clone()
  // RFC 5545 requires UNTIL's value type to match DTSTART's. For an all-day
  // (DATE-typed) boundary, subtracting a sub-day duration is meaningless --
  // step back a whole day instead so the boundary occurrence itself is
  // excluded. For a DATE-TIME boundary, one second back is enough.
  if (until.isDate) {
    until.addDuration(ICAL.Duration.fromString('-P1D'))
  } else {
    until.addDuration(ICAL.Duration.fromString('-P0DT0H0M1S'))
  }
  recur.until = until
  recur.count = null
  rrule.setValue(recur)
}

/** this-occurrence edit: replace/insert an override VEVENT with RECURRENCE-ID. */
export function applyThisOccurrence(ics: string, recurrenceId: string, fields: EventFields): string {
  const comp = parseCalendar(ics)
  const master = getMaster(comp)
  const uid = master.getFirstPropertyValue('uid') as string
  const target = icalTimeFromIso(recurrenceId, masterIsAllDay(master))

  for (const v of comp.getAllSubcomponents('vevent')) {
    const rid = getRecurrenceId(v)
    // Compare as ICAL.Time, not stringified instants: recurrenceId may
    // arrive as a bare YYYY-MM-DD (all-day series) or a full ISO instant,
    // and rid.toJSDate().toISOString() is server-TZ-dependent for DATE values.
    if (rid && rid.compare(target) === 0) comp.removeSubcomponent(v)
  }

  // An override (RECURRENCE-ID) VEVENT must never carry its own RRULE per
  // RFC 5545 -- but the client can't tell "editing a single occurrence"
  // apart from "editing the master" when populating its repeat picker (it
  // only ever sees one CalendarObject, whose .rrule reflects whatever
  // VEVENT it was actually built from -- the master's, for a not-yet-
  // overridden occurrence), so it currently reconstructs and resends the
  // inherited RRULE even for a `scope: 'this'` edit. Defensively strip it
  // here regardless of what the client sent, rather than trusting it.
  const override = buildVeventComponent(uid, { ...fields, rrule: null })
  override.updatePropertyWithValue('recurrence-id', icalTimeFromIso(recurrenceId, masterIsAllDay(master)))
  comp.addSubcomponent(override)
  ICAL.helpers.updateTimezones(comp)
  return comp.toString()
}

/**
 * Shifts an override VEVENT's RECURRENCE-ID/DTSTART/DTEND by `delta` in
 * place -- used to carry an override forward when the master's own DTSTART
 * moves (applyAll) or a series is split (applyThisAndFuture). Preserves the
 * override's own field values (summary/description/color/alarms/etc)
 * completely untouched, and preserves its *relative* time offset from the
 * master (e.g. "this occurrence starts 2h later than the rest of the
 * series") by shifting both the recurrence-id (which slot it fills) and its
 * own dtstart/dtend (its actual time) by the same amount the master moved.
 */
function shiftOverride(override: ICAL.Component, delta: ICAL.Duration): void {
  const rid = getRecurrenceId(override)
  if (rid) {
    const shifted = rid.clone()
    shifted.addDuration(delta)
    override.updatePropertyWithValue('recurrence-id', shifted)
  }
  for (const prop of ['dtstart', 'dtend'] as const) {
    const value = override.getFirstPropertyValue(prop) as ICAL.Time | null
    if (!value) continue
    const shifted = value.clone()
    shifted.addDuration(delta)
    override.updatePropertyWithValue(prop, shifted)
  }
}

/**
 * all-events edit: rewrite the master with the new fields.
 *
 * Existing per-occurrence overrides are preserved (not dropped) when
 * possible: their own fields are left completely untouched, and their
 * recurrence-id/time are shifted by however much the master's own DTSTART
 * moved, so "this one occurrence was moved +2h" survives an edit that
 * changes the series's own time. Best-effort: if the edit toggles
 * all-day-ness (DTSTART's value type changes between DATE and DATE-TIME),
 * there's no sensible delta to compute, so overrides are dropped in that
 * one case only, same as the old blanket behavior.
 */
export function applyAll(ics: string, fields: EventFields, shift?: EventShift): string {
  const comp = parseCalendar(ics)
  const master = getMaster(comp)
  const uid = master.getFirstPropertyValue('uid') as string
  const oldMasterDtstart = master.getFirstPropertyValue('dtstart') as ICAL.Time
  const overrides = comp.getAllSubcomponents('vevent').filter((v) => v !== master)

  for (const v of comp.getAllSubcomponents('vevent')) {
    comp.removeSubcomponent(v)
  }
  const newMaster = buildVeventComponent(uid, fields)
  comp.addSubcomponent(newMaster)

  if (shift && !oldMasterDtstart.isDate === !fields.allDay) {
    // `fields` describe the dragged occurrence, not the master: move the
    // master's own start by the drag delta (wall-clock, so it survives DST)
    // and keep the duration `fields` carries.
    const fieldStart = newMaster.getFirstPropertyValue('dtstart') as ICAL.Time
    const fieldEnd = newMaster.getFirstPropertyValue('dtend') as ICAL.Time
    const duration = fieldEnd.subtractDate(fieldStart)
    const movedStart = oldMasterDtstart.clone()
    movedStart.addDuration(
      new ICAL.Duration({ days: shift.days, seconds: Math.trunc(shift.milliseconds / 1000) }),
    )
    const movedEnd = movedStart.clone()
    movedEnd.addDuration(duration)
    newMaster.updatePropertyWithValue('dtstart', movedStart)
    newMaster.updatePropertyWithValue('dtend', movedEnd)
  }

  const newMasterDtstart = newMaster.getFirstPropertyValue('dtstart') as ICAL.Time
  if (oldMasterDtstart.isDate === newMasterDtstart.isDate) {
    const delta = newMasterDtstart.subtractDate(oldMasterDtstart)
    for (const override of overrides) {
      shiftOverride(override, delta)
      comp.addSubcomponent(override)
    }
  }

  ICAL.helpers.updateTimezones(comp)
  return comp.toString()
}

/**
 * this-and-future edit: truncates the existing series with UNTIL just
 * before `recurrenceId`, and returns a fresh ICS for a brand new series
 * (new UID) starting at recurrenceId with the edited fields.
 *
 * Overrides at/after the split point are migrated onto the new series
 * (not dropped): each is re-keyed onto `newUid` (ical.js associates an
 * override to its master purely by shared UID) and its recurrence-id/time
 * shifted by however much the split's own instant differs from the new
 * series's actual start -- e.g. splitting off a series and changing its
 * time from 10am to 2pm shifts every migrated override by the same +4h, so
 * a occurrence that was "+30min late" relative to the old series stays
 * +30min late relative to the new one. Best-effort: if the split also
 * toggles all-day-ness, there's no sensible delta, so those overrides are
 * dropped instead (same fallback as applyAll).
 *
 * A COUNT-based RRULE has its count reduced by however many occurrences
 * the original series already produced before the split point, so the
 * carried rule continues the original series's remaining occurrence
 * budget instead of restarting it (a COUNT=6 series split at occurrence 4
 * ends up with COUNT=2 on the new series, six total, not nine).
 */
export function applyThisAndFuture(
  ics: string,
  recurrenceId: string,
  fields: EventFields,
): { updatedIcs: string; newSeriesIcs: string; newUid: string } {
  const comp = parseCalendar(ics)
  const master = getMaster(comp)
  const boundary = icalTimeFromIso(recurrenceId, masterIsAllDay(master))

  // getFirstPropertyValue returns the underlying Recur object by reference, not
  // a copy -- truncateRrule mutates it in place, so this must be cloned before
  // truncating or the "carried" rule silently ends up truncated too.
  const originalRrule = master.getFirstPropertyValue('rrule') as ICAL.Recur | null
  const carriedRrule = originalRrule ? originalRrule.clone() : null
  if (carriedRrule?.count) {
    const masterDtstart = master.getFirstPropertyValue('dtstart') as ICAL.Time
    const occurrencesBefore = countOccurrencesBefore(originalRrule as ICAL.Recur, masterDtstart, boundary)
    carriedRrule.count = Math.max(1, carriedRrule.count - occurrencesBefore)
  }

  const migratedOverrides: ICAL.Component[] = []
  for (const v of comp.getAllSubcomponents('vevent')) {
    if (v === master) continue
    const rid = getRecurrenceId(v)
    if (rid && rid.compare(boundary) >= 0) {
      comp.removeSubcomponent(v)
      migratedOverrides.push(v)
    }
  }
  truncateRrule(master, boundary)

  const newUid = crypto.randomUUID()
  const newFields: EventFields = {
    ...fields,
    rrule: fields.rrule ?? (carriedRrule ? carriedRrule.toString() : null),
  }

  const newComp = new ICAL.Component(['vcalendar', [], []])
  newComp.updatePropertyWithValue('prodid', '-//calendar//standalone//EN')
  newComp.updatePropertyWithValue('version', '2.0')
  const newMaster = buildVeventComponent(newUid, newFields)
  newComp.addSubcomponent(newMaster)

  const newMasterDtstart = newMaster.getFirstPropertyValue('dtstart') as ICAL.Time
  if (boundary.isDate === newMasterDtstart.isDate) {
    const delta = newMasterDtstart.subtractDate(boundary)
    for (const override of migratedOverrides) {
      override.updatePropertyWithValue('uid', newUid)
      shiftOverride(override, delta)
      newComp.addSubcomponent(override)
    }
  }

  ICAL.helpers.updateTimezones(comp)
  ICAL.helpers.updateTimezones(newComp)

  return { updatedIcs: comp.toString(), newSeriesIcs: newComp.toString(), newUid }
}

/** this-occurrence delete: remove any override for it and EXDATE it out of the master. */
export function deleteThisOccurrence(ics: string, recurrenceId: string): string {
  const comp = parseCalendar(ics)
  const master = getMaster(comp)
  const target = icalTimeFromIso(recurrenceId, masterIsAllDay(master))

  for (const v of comp.getAllSubcomponents('vevent')) {
    const rid = getRecurrenceId(v)
    // See applyThisOccurrence: match on ICAL.Time, not stringified instants.
    if (rid && rid.compare(target) === 0) comp.removeSubcomponent(v)
  }

  // Build a fresh ICAL.Time for the EXDATE rather than reusing `target`,
  // which the compare loop above holds -- no shared reference into the
  // serialized component.
  master.addPropertyWithValue('exdate', icalTimeFromIso(recurrenceId, masterIsAllDay(master)))
  return comp.toString()
}

/** this-and-future delete: truncate the master's RRULE and drop overrides at/after the boundary. */
export function deleteThisAndFuture(ics: string, recurrenceId: string): string {
  const comp = parseCalendar(ics)
  const master = getMaster(comp)
  const boundary = icalTimeFromIso(recurrenceId, masterIsAllDay(master))

  for (const v of comp.getAllSubcomponents('vevent')) {
    if (v === master) continue
    const rid = getRecurrenceId(v)
    if (rid && rid.compare(boundary) >= 0) comp.removeSubcomponent(v)
  }
  truncateRrule(master, boundary)

  return comp.toString()
}
