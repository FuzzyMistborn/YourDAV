import ICAL from 'ical.js'
import { config } from '../config.js'

// The cap on events a single import can create lives in
// config.maxImportEvents (MAX_IMPORT_EVENTS) -- each accepted group becomes
// its own createObject() call against the DAV server, so an unbounded file
// could turn one request into thousands of upstream writes.

/**
 * Splits an uploaded .ics file (which may contain many events, e.g. an
 * export from another calendar) into one importable VCALENDAR string per
 * event -- grouping a master VEVENT together with any of its own
 * RECURRENCE-ID overrides sharing the same original UID, then assigning
 * every event a fresh UID so it can't collide with anything already in the
 * target calendar.
 */
/** TZIDs referenced by any of a VEVENT's properties (DTSTART/DTEND/EXDATE/RDATE TZID params). */
function referencedTzids(vevent: ICAL.Component): Set<string> {
  const tzids = new Set<string>()
  for (const prop of vevent.getAllProperties()) {
    const tzid = prop.getParameter('tzid') as string | undefined
    if (tzid) tzids.add(tzid)
  }
  return tzids
}

/** Deep-clones a component independently of its original parent/siblings (jCal round-trip). */
function cloneComponent(c: ICAL.Component): ICAL.Component {
  return new ICAL.Component(JSON.parse(JSON.stringify(c.toJSON())))
}

export function splitImportIcs(icsText: string, limit = config.maxImportEvents): string[] {
  return splitImportIcsCapped(icsText, limit).groups
}

/** Like splitImportIcs, but also reports how many events were dropped by the cap. */
export function splitImportIcsCapped(
  icsText: string,
  limit = config.maxImportEvents,
): { groups: string[]; skipped: number } {
  const jcal = ICAL.parse(icsText)
  const comp = new ICAL.Component(jcal)
  const vevents = comp.getAllSubcomponents('vevent')
  if (vevents.length === 0) return { groups: [], skipped: 0 }

  // Imported VEVENTs keep referencing their original TZIDs (e.g.
  // DTSTART;TZID=America/New_York:...), but each import group becomes its
  // own standalone VCALENDAR -- without also carrying along the source
  // file's matching VTIMEZONE definition, those TZID references are
  // dangling and the receiving server/client has no way to resolve the
  // actual UTC offset.
  const vtimezonesByTzid = new Map<string, ICAL.Component>()
  for (const vtimezone of comp.getAllSubcomponents('vtimezone')) {
    const tzid = vtimezone.getFirstPropertyValue('tzid') as string | null
    if (tzid) vtimezonesByTzid.set(tzid, vtimezone)
  }

  const groups = new Map<string, ICAL.Component[]>()
  for (const vevent of vevents) {
    const uid = vevent.getFirstPropertyValue('uid') as string | null
    if (!uid) continue
    const group = groups.get(uid) ?? []
    group.push(vevent)
    groups.set(uid, group)
  }

  const results: string[] = []
  for (const components of Array.from(groups.values()).slice(0, limit)) {
    const newUid = crypto.randomUUID()
    const newCal = new ICAL.Component(['vcalendar', [], []])
    newCal.updatePropertyWithValue('prodid', '-//calendar//standalone//EN')
    newCal.updatePropertyWithValue('version', '2.0')

    const neededTzids = new Set<string>()
    for (const vevent of components) {
      for (const tzid of referencedTzids(vevent)) neededTzids.add(tzid)
    }
    for (const tzid of neededTzids) {
      const vtimezone = vtimezonesByTzid.get(tzid)
      if (vtimezone) newCal.addSubcomponent(cloneComponent(vtimezone))
    }

    for (const vevent of components) {
      vevent.updatePropertyWithValue('uid', newUid)
      newCal.addSubcomponent(vevent)
    }
    results.push(newCal.toString())
  }
  return { groups: results, skipped: Math.max(0, groups.size - limit) }
}
