// Pure radio logic: template activation, weight stacking, weighted draws and anti-repeat rules.

export type Trigger =
  | { type: 'weekly'; days: number[]; from: string; to: string } // days: 0 = Sunday, times "HH:MM"
  | { type: 'dateRange'; from: string; to: string } // "MM-DD", repeats every year

export type Template = { id: string; name: string; weights: Record<string, number>; triggers: Trigger[] }
export type Track = { uri: string; name: string; durationMs: number; artists: { id: string; name: string }[] }
export type QueueItem = { track: Track; playlistId: string; relaxed?: boolean }
export type Play = { uri: string; artistIds: string[]; at: number }

export const SONG_GAP = 4 * 60 * 60 * 1000
export const ARTIST_GAP = 60 * 60 * 1000
export const QUEUE_SIZE = 10

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
const pad = (n: number) => String(n).padStart(2, '0')

// New trigger types: add a case here and to the Trigger union.
export function isTriggerActive(t: Trigger, now: Date): boolean {
  switch (t.type) {
    case 'weekly': {
      const day = now.getDay()
      const min = now.getHours() * 60 + now.getMinutes()
      const from = toMinutes(t.from)
      const to = toMinutes(t.to)
      if (from < to) return t.days.includes(day) && min >= from && min < to
      // Window runs past midnight (e.g. Fri 19:00–00:00): part after `from` today, part before `to` the day after.
      return (t.days.includes(day) && min >= from) || (t.days.includes((day + 6) % 7) && min < to)
    }
    case 'dateRange': {
      const md = `${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      return t.from <= t.to ? md >= t.from && md <= t.to : md >= t.from || md <= t.to
    }
  }
}

export function activeTemplates(templates: Template[], defaultId: string, now: Date): Template[] {
  const active = templates.filter(t => t.id !== defaultId && t.triggers.some(tr => isTriggerActive(tr, now)))
  if (active.length) return active
  return templates.filter(t => t.id === defaultId)
}

// Sum template weights per playlist, add tuning on top, keep only playlists that have tracks.
export function combinedWeights(
  templates: Template[],
  tuning: Record<string, number>,
  playlistIds: string[],
): Record<string, number> {
  const sum: Record<string, number> = {}
  for (const t of templates) for (const [id, w] of Object.entries(t.weights)) sum[id] = (sum[id] ?? 0) + w
  for (const [id, w] of Object.entries(tuning)) sum[id] = (sum[id] ?? 0) + w
  const out: Record<string, number> = {}
  for (const id of playlistIds) if ((sum[id] ?? 0) > 0) out[id] = sum[id]
  // Nothing weighted yet: give every linked playlist an equal chance so the radio still plays.
  if (!Object.keys(out).length) for (const id of playlistIds) out[id] = 1
  return out
}

export function weightedPick(weights: Record<string, number>, rand: () => number): string | undefined {
  const entries = Object.entries(weights)
  const total = entries.reduce((s, [, w]) => s + w, 0)
  let r = rand() * total
  for (const [id, w] of entries) {
    r -= w
    if (r < 0) return id
  }
  return entries[entries.length - 1]?.[0]
}

function violates(track: Track, at: number, plays: Play[], checkArtist: boolean): boolean {
  return plays.some(
    p =>
      (p.uri === track.uri && Math.abs(at - p.at) < SONG_GAP) ||
      (checkArtist && Math.abs(at - p.at) < ARTIST_GAP && track.artists.some(a => p.artistIds.includes(a.id))),
  )
}

const MAX_DRAWS = 200

// Draw one track for a slot starting at `at`. `plays` = history plus what is already planned.
// If the rules can't be met, relax them (artist rule first, then all) so the radio never stops.
export function drawTrack(
  weights: Record<string, number>,
  tracks: Record<string, Track[]>,
  plays: Play[],
  at: number,
  rand: () => number = Math.random,
): QueueItem | undefined {
  for (const checkArtist of [true, false]) {
    for (let i = 0; i < MAX_DRAWS; i++) {
      const playlistId = weightedPick(weights, rand)
      const list = playlistId ? tracks[playlistId] : undefined
      if (!playlistId || !list?.length) continue
      const track = list[Math.floor(rand() * list.length)]
      if (!violates(track, at, plays, checkArtist)) return { track, playlistId, relaxed: !checkArtist }
    }
  }
  const playlistId = weightedPick(weights, rand)
  const list = playlistId ? tracks[playlistId] : undefined
  if (!playlistId || !list?.length) return undefined
  return { track: list[Math.floor(rand() * list.length)], playlistId, relaxed: true }
}

export const toPlay = (item: QueueItem, at: number): Play => ({
  uri: item.track.uri,
  artistIds: item.track.artists.map(a => a.id),
  at,
})

// Top `queue` up to QUEUE_SIZE. Each slot is checked against its estimated start time.
export function fillQueue(
  queue: QueueItem[],
  weights: Record<string, number>,
  tracks: Record<string, Track[]>,
  history: Play[],
  firstStart: number,
  rand: () => number = Math.random,
): QueueItem[] {
  const out = [...queue]
  let at = firstStart
  const plays = [...history]
  for (const item of out) {
    plays.push(toPlay(item, at))
    at += item.track.durationMs
  }
  while (out.length < QUEUE_SIZE) {
    const item = drawTrack(weights, tracks, plays, at, rand)
    if (!item) break
    out.push(item)
    plays.push(toPlay(item, at))
    at += item.track.durationMs
  }
  return out
}
