// ReccoBeats: recommendations and audio features. Spotify closed both endpoints for apps without extended
// access from before November 2024. Public API, no key, CORS open; it takes and returns Spotify ids.
import { weightedPick, type Track } from './engine'

const BASE = 'https://api.reccobeats.com/v1'
export const RECCO_ID = 'reccobeats' // pseudo playlist id; weighted like any linked playlist
const BATCHES = 4 // x 100 recommendations, each batch from 5 fresh seeds
const spotifyId = (href: string) => href.split('/').pop()!

async function get<T>(path: string): Promise<T[]> {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`ReccoBeats ${path.split('?')[0]}: ${res.status} ${await res.text()}`)
  return (await res.json()).content
}

type RTrack = { trackTitle: string; durationMs: number; href: string; artists: { name: string; href: string }[] }
type RFeatures = { href: string; danceability: number; acousticness: number }

// A broad pool of recommendations seeded from what the radio plays now (`weights`), with audio features attached.
// Mood filtering happens later, in matchMood, so moving a slider needs no new requests.
export async function fetchPool(weights: Record<string, number>, tracks: Record<string, Track[]>): Promise<Track[]> {
  const own = new Set(Object.entries(tracks).flatMap(([id, list]) => (id === RECCO_ID ? [] : list.map(t => t.uri))))
  const seedWeights = Object.fromEntries(Object.entries(weights).filter(([id]) => id !== RECCO_ID))
  const seed = () => {
    const list = tracks[weightedPick(seedWeights, Math.random) ?? ''] ?? []
    return list[Math.floor(Math.random() * list.length)]
  }
  const pool = new Map<string, Track>()
  let lastError: unknown
  for (let b = 0; b < BATCHES; b++) {
    const seeds = Array.from({ length: 5 }, seed).filter(Boolean).map(t => t.uri.split(':').pop())
    if (!seeds.length) throw new Error('Geen nummers om aanbevelingen op te baseren: koppel eerst playlists.')
    // Seeds ReccoBeats doesn't know are skipped; a batch only fails when it knows none of them.
    const recs = await get<RTrack>(`/track/recommendation?size=100&seeds=${[...new Set(seeds)].join(',')}`).catch(e => {
      lastError = e
      return []
    })
    for (const r of recs) {
      const uri = `spotify:track:${spotifyId(r.href)}`
      if (own.has(uri)) continue
      const artists = r.artists.map(a => ({ id: spotifyId(a.href), name: a.name }))
      pool.set(uri, { uri, name: r.trackTitle, durationMs: r.durationMs, artists })
    }
  }
  if (!pool.size) throw lastError ?? new Error('ReccoBeats gaf geen aanbevelingen.')

  const list = [...pool.values()]
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40)
    const features = await get<RFeatures>(`/audio-features?ids=${chunk.map(t => t.uri.split(':').pop()).join(',')}`)
    for (const f of features) {
      const t = pool.get(`spotify:track:${spotifyId(f.href)}`)
      if (t) t.features = { danceability: f.danceability, acousticness: f.acousticness }
    }
  }
  return list
}
