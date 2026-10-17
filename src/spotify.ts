// Spotify auth (Authorization Code + PKCE, no backend), Web API calls and the Web Playback SDK.
import type { Track } from './engine'

const CLIENT_ID = 'c1fc61acf7bd4fa3adef74e45d41d3a8'
const REDIRECT_URI = `${location.origin}/callback`
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ')
const TOKEN_KEY = 'radio-farlake:token'
const VERIFIER_KEY = 'radio-farlake:verifier'

type Token = { access: string; refresh: string; expiresAt: number }

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function login() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)))
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  localStorage.setItem(VERIFIER_KEY, verifier)
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  })
  location.assign(`https://accounts.spotify.com/authorize?${params}`)
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY)
  location.assign('/')
}

async function requestToken(body: Record<string, string>): Promise<Token> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  })
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`)
  const json = await res.json()
  const token = {
    access: json.access_token,
    refresh: json.refresh_token ?? body.refresh_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  return token
}

// Call once on startup: finishes the redirect from Spotify. Returns whether we are logged in.
export async function initAuth(): Promise<boolean> {
  const params = new URLSearchParams(location.search)
  const code = params.get('code')
  if (location.pathname === '/callback' && code) {
    await requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: localStorage.getItem(VERIFIER_KEY) ?? '',
    })
    localStorage.removeItem(VERIFIER_KEY)
    history.replaceState(null, '', '/')
  }
  return !!localStorage.getItem(TOKEN_KEY)
}

let refreshing: Promise<Token> | undefined

export async function getAccessToken(): Promise<string> {
  const raw = localStorage.getItem(TOKEN_KEY)
  if (!raw) throw new Error('Not logged in')
  const token: Token = JSON.parse(raw)
  if (Date.now() < token.expiresAt) return token.access
  refreshing ??= requestToken({ grant_type: 'refresh_token', refresh_token: token.refresh }).finally(
    () => (refreshing = undefined),
  )
  return (await refreshing).access
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith('https://') ? path : `https://api.spotify.com/v1${path}`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json', ...init.headers },
    })
    if (res.status === 429 && attempt < 3) {
      await new Promise(r => setTimeout(r, Number(res.headers.get('Retry-After') ?? 1) * 1000))
      continue
    }
    if (!res.ok) throw new Error(`Spotify ${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
}

type Page<T> = { items: T[]; next: string | null }

async function all<T>(path: string): Promise<T[]> {
  const out: T[] = []
  for (let next: string | null = path; next; ) {
    const page: Page<T> = await api<Page<T>>(next)
    out.push(...page.items)
    next = page.next
  }
  return out
}

export type PlaylistInfo = { id: string; name: string; snapshot: string; total: number }

// Spotify only returns playlist contents for playlists you own or collaborate on, so list only those.
export async function getMyPlaylists(): Promise<PlaylistInfo[]> {
  const me = await api<{ id: string }>('/me')
  type P = { id: string; name: string; snapshot_id: string; collaborative: boolean; owner: { id: string }; items?: { total: number }; tracks?: { total: number } }
  const playlists = await all<P>('/me/playlists?limit=50')
  return playlists
    .filter(p => p.owner.id === me.id || p.collaborative)
    .map(p => ({ id: p.id, name: p.name, snapshot: p.snapshot_id, total: (p.items ?? p.tracks)?.total ?? 0 }))
}

export async function getPlaylistTracks(id: string): Promise<Track[]> {
  type T = { type: string; uri: string; name: string; duration_ms: number; is_local: boolean; artists: { id: string; name: string }[] }
  // Feb 2026: /tracks became /items and each entry's `track` became `item`.
  const entries = await all<{ item?: T | null; track?: T | null }>(`/playlists/${id}/items?limit=100`)
  return entries
    .map(e => e.item ?? e.track)
    .filter((t): t is T => !!t && t.type === 'track' && !t.is_local && !!t.uri)
    .map(t => ({ uri: t.uri, name: t.name, durationMs: t.duration_ms, artists: t.artists.map(a => ({ id: a.id, name: a.name })) }))
}

// --- Web Playback SDK ---

type SdkState = { paused: boolean; position: number; track_window: { current_track: { uri: string } | null } }
type SdkPlayer = {
  connect(): Promise<boolean>
  activateElement(): Promise<void>
  addListener(event: string, cb: (arg: never) => void): void
  togglePlay(): Promise<void>
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void
    Spotify: { Player: new (opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SdkPlayer }
  }
}

export type Player = {
  deviceId: string
  sdk: SdkPlayer
  play(uri: string): Promise<void>
}

export function createPlayer(onState: (s: SdkState | null) => void, onError: (msg: string) => void): Promise<Player> {
  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      const sdk = new window.Spotify.Player({
        name: 'Radio Farlake',
        getOAuthToken: cb => void getAccessToken().then(cb),
        volume: 0.8,
      })
      for (const e of ['initialization_error', 'authentication_error', 'account_error', 'playback_error'])
        sdk.addListener(e, ({ message }: { message: string }) => onError(`${e}: ${message}`))
      sdk.addListener('player_state_changed', (s: SdkState | null) => onState(s))
      sdk.addListener('ready', ({ device_id }: { device_id: string }) =>
        resolve({
          deviceId: device_id,
          sdk,
          play: uri => api(`/me/player/play?device_id=${device_id}`, { method: 'PUT', body: JSON.stringify({ uris: [uri] }) }),
        }),
      )
      sdk.connect().then(ok => ok || reject(new Error('Could not connect the Spotify player')))
    }
    const script = document.createElement('script')
    script.src = 'https://sdk.scdn.co/spotify-player.js'
    document.body.appendChild(script)
  })
}
