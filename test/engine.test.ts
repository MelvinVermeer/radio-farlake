// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeTemplates,
  combinedWeights,
  fillQueue,
  isTriggerActive,
  matchMood,
  MOOD_MIN_TRACKS,
  weightedPick,
  type Template,
  type Track,
} from '../src/engine.ts'

const at = (s: string) => new Date(s)

test('weekly window, including one that runs past midnight', () => {
  const sunMorning = { type: 'weekly', days: [0], from: '08:00', to: '12:00' } as const
  assert.equal(isTriggerActive(sunMorning, at('2026-10-18T09:00')), true) // Sunday
  assert.equal(isTriggerActive(sunMorning, at('2026-10-18T12:00')), false)
  assert.equal(isTriggerActive(sunMorning, at('2026-10-19T09:00')), false) // Monday

  const friNight = { type: 'weekly', days: [5], from: '19:00', to: '01:00' } as const
  assert.equal(isTriggerActive(friNight, at('2026-10-16T20:00')), true) // Friday
  assert.equal(isTriggerActive(friNight, at('2026-10-17T00:30')), true) // Saturday early
  assert.equal(isTriggerActive(friNight, at('2026-10-17T20:00')), false)
  const toMidnight = { type: 'weekly', days: [5], from: '19:00', to: '00:00' } as const
  assert.equal(isTriggerActive(toMidnight, at('2026-10-16T23:59')), true)
})

test('date range, also across new year', () => {
  const xmas = { type: 'dateRange', from: '12-01', to: '12-26' } as const
  assert.equal(isTriggerActive(xmas, at('2026-12-26T23:00')), true)
  assert.equal(isTriggerActive(xmas, at('2026-12-27T01:00')), false)
  const winter = { type: 'dateRange', from: '12-20', to: '01-05' } as const
  assert.equal(isTriggerActive(winter, at('2027-01-03T10:00')), true)
  assert.equal(isTriggerActive(winter, at('2026-06-01T10:00')), false)
})

test('templates stack, default only when nothing else is active, tuning on top', () => {
  const templates: Template[] = [
    { id: 'def', name: 'Standaard', weights: { rustig: 10 }, triggers: [] },
    { id: 'zo', name: 'Zondag', weights: { akoe: 80, rustig: 20 }, triggers: [{ type: 'weekly', days: [0], from: '08:00', to: '12:00' }] },
    { id: 'kerst', name: 'Kerst', weights: { kerst: 30 }, triggers: [{ type: 'dateRange', from: '12-01', to: '12-26' }] },
  ]
  const names = (d: string) => activeTemplates(templates, 'def', at(d)).map(t => t.id)
  assert.deepEqual(names('2026-10-19T09:00'), ['def'])
  assert.deepEqual(names('2026-12-06T09:00'), ['zo', 'kerst']) // a Sunday in December

  const ids = ['akoe', 'rustig', 'kerst']
  const active = activeTemplates(templates, 'def', at('2026-12-06T09:00'))
  assert.deepEqual(combinedWeights(active, {}, ids), { akoe: 80, rustig: 20, kerst: 30 })
  assert.deepEqual(combinedWeights(active, { rustig: -20, kerst: 10 }, ids), { akoe: 80, kerst: 40 })
  assert.deepEqual(combinedWeights([], {}, ['a', 'b']), { a: 1, b: 1 })
})

test('weighted pick follows relative weights', () => {
  let seed = 1
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  const counts: Record<string, number> = { a: 0, b: 0 }
  for (let i = 0; i < 13000; i++) counts[weightedPick({ a: 100, b: 30 }, rand)!]++
  assert.ok(Math.abs(counts.a / 13000 - 100 / 130) < 0.02, JSON.stringify(counts))
})

test('queue respects song and artist rules, relaxes instead of going silent', () => {
  const track = (n: number, artist: string): Track => ({
    uri: `t${n}`,
    name: `T${n}`,
    durationMs: 3 * 60 * 1000,
    artists: [{ id: artist, name: artist }],
  })
  const tracks = { p: Array.from({ length: 40 }, (_, i) => track(i, `a${i % 20}`)) }
  const q = fillQueue([], { p: 1 }, tracks, [], 0)
  assert.equal(q.length, 10)
  assert.equal(new Set(q.map(i => i.track.uri)).size, 10)
  assert.equal(new Set(q.map(i => i.track.artists[0].id)).size, 10) // 30 min of music: artists unique
  assert.ok(q.every(i => !i.relaxed))

  const tiny = { p: [track(1, 'x'), track(2, 'x')] }
  const q2 = fillQueue([], { p: 1 }, tiny, [], 0)
  assert.equal(q2.length, 10)
  assert.ok(q2.some(i => i.relaxed))
})

test('mood keeps tracks near the targets, closest first, never fewer than the minimum', () => {
  const base = { energy: 0.5, instrumentalness: 0, liveness: 0.1, loudness: -8, speechiness: 0.05, tempo: 120, valence: 0.5 }
  const t = (n: number, danceability: number, acousticness: number): Track => ({
    uri: `t${n}`, name: `T${n}`, durationMs: 1, artists: [], features: { ...base, danceability, acousticness },
  })
  const pool = [
    ...Array.from({ length: 30 }, (_, i) => t(i, 0.8 + (i % 5) / 100, 0.1)), // dancy, electronic
    ...Array.from({ length: 30 }, (_, i) => t(100 + i, 0.3, 0.9)), // calm, acoustic
    { uri: 'nofeat', name: '?', durationMs: 1, artists: [] },
  ]
  assert.equal(matchMood(pool, {}).length, pool.length)
  const dancy = matchMood(pool, { danceability: 0.8 })
  assert.equal(dancy.length, 30)
  assert.equal(dancy[0].features!.danceability, 0.8)
  assert.equal(matchMood(pool, { danceability: 0.8, acousticness: 0.9 }).length, MOOD_MIN_TRACKS) // nothing fits both
  assert.ok(matchMood(pool, { acousticness: 1 }).every(x => x.features!.acousticness === 0.9))
  // Distance is a share of the range: 40 BPM off is 0.16 of 0..250, inside the 0.2 tolerance; 60 BPM is not.
  assert.equal(matchMood(pool, { tempo: 160 }).length, 60)
  assert.equal(matchMood(pool, { tempo: 180 }).length, MOOD_MIN_TRACKS)
})
