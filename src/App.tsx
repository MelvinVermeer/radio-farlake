import { useEffect, useMemo, useRef, useState } from 'react'
import { activeTemplates, combinedWeights, fillQueue, toPlay, type QueueItem, type Template } from './engine'
import { createPlayer, initAuth, login, logout, type Player } from './spotify'
import { useStore, type SetState, type State } from './store'
import { Playlists, Templates } from './Manage'

type Tab = 'radio' | 'playlists' | 'templates'

export default function App() {
  const [auth, setAuth] = useState<'loading' | 'in' | 'out'>('loading')
  const [error, setError] = useState<string>()
  useEffect(() => {
    initAuth().then(
      ok => setAuth(ok ? 'in' : 'out'),
      e => {
        setError(String(e))
        setAuth('out')
      },
    )
  }, [])

  if (auth === 'loading') return <main>Laden…</main>
  if (auth === 'out')
    return (
      <main className="center">
        <h1>Radio Farlake</h1>
        {error && <p className="error">{error}</p>}
        <button onClick={login}>Inloggen met Spotify</button>
      </main>
    )
  return <Radio />
}

function Radio() {
  const [state, setState] = useStore()
  const [tab, setTab] = useState<Tab>('radio')
  const [now, setNow] = useState(() => new Date())
  const [player, setPlayer] = useState<Player>()
  const [current, setCurrent] = useState<{ item: QueueItem; startedAt: number }>()
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  const active = useMemo(
    () => activeTemplates(state.templates, state.defaultTemplateId, now),
    [state.templates, state.defaultTemplateId, now],
  )
  const tracks = useMemo(() => Object.fromEntries(state.playlists.map(p => [p.id, p.tracks])), [state.playlists])
  const playlistIds = state.playlists.filter(p => p.tracks.length).map(p => p.id)
  const weights = combinedWeights(active, state.tuning, playlistIds)
  const weightsKey = JSON.stringify(weights)

  // The SDK callback outlives renders; it reads the latest values through this ref.
  const latest = useRef({ state, weights, tracks, queue, current, player })
  latest.current = { state, weights, tracks, queue, current, player }
  const progressed = useRef(false)
  const advancing = useRef(false)

  const queueStart = (cur = latest.current.current) => (cur ? cur.startedAt + cur.item.track.durationMs : Date.now())

  async function advance(from: QueueItem[]) {
    const { weights, tracks, state, player } = latest.current
    if (!player || advancing.current) return
    advancing.current = true
    try {
      const [next, ...rest] = from.length ? from : fillQueue([], weights, tracks, state.history, Date.now())
      if (!next) return setError('Geen nummers om te draaien: koppel een playlist met nummers.')
      const startedAt = Date.now()
      const play = toPlay(next, startedAt)
      progressed.current = false
      const cur = { item: next, startedAt }
      latest.current.current = cur
      setCurrent(cur)
      setState(s => ({ ...s, history: [...s.history, play] }))
      setQueue(fillQueue(rest, weights, tracks, [...state.history, play], startedAt + next.track.durationMs))
      await player.play(next.track.uri)
      setPaused(false)
    } catch (e) {
      setError(String(e))
    } finally {
      advancing.current = false
    }
  }

  useEffect(() => {
    createPlayer(
      s => {
        const cur = latest.current.current
        if (!s || !cur) return
        setPaused(s.paused)
        const uri = s.track_window.current_track?.uri
        if (uri === cur.item.track.uri && s.position > 0) progressed.current = true
        // A single-uri play ends by stopping at 0, or by Spotify autoplay moving on to another track.
        // ponytail: uri compare misfires if Spotify relinks a track to another uri; compare by name if that shows up.
        const ended = progressed.current && ((s.paused && s.position === 0) || (!!uri && uri !== cur.item.track.uri))
        if (ended) void advance(latest.current.queue)
      },
      setError,
    ).then(setPlayer, e => setError(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // New ratio (tuning, a template window opening or closing, linked playlists): redraw the whole queue.
  // The track that plays now stays.
  useEffect(() => {
    setQueue(fillQueue([], weights, tracks, latest.current.state.history, queueStart()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weightsKey, tracks])

  const skipQueued = (i: number) =>
    setQueue(q => fillQueue(q.filter((_, j) => j !== i), weights, tracks, state.history, queueStart()))

  const name = (id: string) => state.playlists.find(p => p.id === id)?.name ?? '?'
  const relaxed = [current?.item, ...queue].some(i => i?.relaxed)

  return (
    <main>
      <header>
        <h1>Radio Farlake</h1>
        <nav>
          {(['radio', 'playlists', 'templates'] as const).map(t => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {{ radio: 'Radio', playlists: 'Playlists', templates: 'Templates' }[t]}
            </button>
          ))}
          <button onClick={logout}>Uitloggen</button>
        </nav>
      </header>
      {error && (
        <p className="error" onClick={() => setError(undefined)} title="Klik om te sluiten">
          {error}
        </p>
      )}

      {tab === 'playlists' && <Playlists state={state} setState={setState} />}
      {tab === 'templates' && <Templates state={state} setState={setState} />}
      {tab === 'radio' && (
        <>
          {!state.playlists.length && <p>Koppel eerst een paar playlists onder "Playlists".</p>}
          <section className="now">
            {current ? (
              <>
                <small>Nu speelt</small>
                <TrackRow item={current.item} playlist={name(current.item.playlistId)} />
                <div className="row">
                  <button onClick={() => player?.sdk.togglePlay()}>{paused ? 'Afspelen' : 'Pauze'}</button>
                  <button onClick={() => advance(queue)}>Overslaan</button>
                </div>
              </>
            ) : (
              <button
                disabled={!player || !queue.length}
                onClick={async () => {
                  await player?.sdk.activateElement()
                  void advance(queue)
                }}
              >
                {player ? 'Start radio' : 'Speler verbinden…'}
              </button>
            )}
          </section>

          {relaxed && <p className="notice">Te weinig keuze: de anti-herhaalregels zijn tijdelijk versoepeld.</p>}

          <h2>Straks</h2>
          <ol className="queue">
            {queue.map((item, i) => (
              <li key={`${i}-${item.track.uri}`}>
                <TrackRow item={item} playlist={name(item.playlistId)} />
                <button onClick={() => skipQueued(i)}>Overslaan</button>
              </li>
            ))}
          </ol>

          <Tuning state={state} setState={setState} active={active} weights={weights} name={name} />
        </>
      )}
    </main>
  )
}

function TrackRow({ item, playlist }: { item: QueueItem; playlist: string }) {
  return (
    <div className="track">
      <strong>{item.track.name}</strong>
      <span>{item.track.artists.map(a => a.name).join(', ')}</span>
      <small>uit {playlist}</small>
    </div>
  )
}

function Tuning(props: {
  state: State
  setState: SetState
  active: Template[]
  weights: Record<string, number>
  name: (id: string) => string
}) {
  const { state, setState, active, weights, name } = props
  const total = Object.values(weights).reduce((s, w) => s + w, 0)
  const tuned = Object.values(state.tuning).some(Boolean)
  const base = (id: string) => active.reduce((s, t) => s + (t.weights[id] ?? 0), 0)
  const nudge = (id: string, delta: number) =>
    setState(s => ({ ...s, tuning: { ...s.tuning, [id]: Math.max((s.tuning[id] ?? 0) + delta, -base(id)) } }))

  return (
    <section>
      <h2>Tuning</h2>
      {tuned && (
        <p className="notice">
          Tuning actief, blijft staan tot je reset.{' '}
          <button onClick={() => setState(s => ({ ...s, tuning: {} }))}>Reset</button>
        </p>
      )}
      <ul className="tuning">
        {state.playlists.map(p => (
          <li key={p.id}>
            <span>{p.name}</span>
            <button onClick={() => nudge(p.id, -10)} aria-label={`${p.name} minder`}>
              −
            </button>
            <b>{weights[p.id] ?? 0}</b>
            <button onClick={() => nudge(p.id, 10)} aria-label={`${p.name} meer`}>
              +
            </button>
          </li>
        ))}
      </ul>
      <details>
        <summary>Waarom speelt dit?</summary>
        <p>Actieve templates: {active.map(t => t.name).join(' + ')}</p>
        <ul>
          {Object.entries(weights).map(([id, w]) => (
            <li key={id}>
              {name(id)}: {w} ({Math.round((w / total) * 100)}%)
              {state.tuning[id] ? `, tuning ${state.tuning[id] > 0 ? '+' : ''}${state.tuning[id]}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
