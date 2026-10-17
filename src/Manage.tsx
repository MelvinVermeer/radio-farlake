import { useEffect, useState } from 'react'
import type { Template, Trigger } from './engine'
import { getMyPlaylists, getPlaylistTracks, type PlaylistInfo } from './spotify'
import type { SetState, State } from './store'

type Props = { state: State; setState: SetState }

export function Playlists({ state, setState }: Props) {
  const [mine, setMine] = useState<PlaylistInfo[]>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    getMyPlaylists().then(setMine, e => setError(String(e)))
  }, [])

  const linked = (id: string) => state.playlists.some(p => p.id === id)

  async function link(p: PlaylistInfo) {
    setBusy(p.id)
    try {
      const tracks = await getPlaylistTracks(p.id)
      setState(s => ({
        ...s,
        playlists: [...s.playlists.filter(x => x.id !== p.id), { id: p.id, name: p.name, snapshot: p.snapshot, tracks }],
      }))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(undefined)
    }
  }

  const unlink = (id: string) => setState(s => ({ ...s, playlists: s.playlists.filter(p => p.id !== id) }))

  // Track lists are cached; only refetch playlists whose snapshot changed on Spotify.
  async function refresh() {
    const fresh = await getMyPlaylists()
    setMine(fresh)
    for (const p of fresh) {
      const cached = state.playlists.find(x => x.id === p.id)
      if (cached && cached.snapshot !== p.snapshot) await link(p)
    }
  }

  return (
    <section>
      <h2>Playlists</h2>
      <p>
        Alleen playlists die je zelf hebt gemaakt of waaraan je meewerkt (beperking van Spotify).{' '}
        <button onClick={() => refresh().catch(e => setError(String(e)))}>Vernieuwen</button>
      </p>
      {error && <p className="error">{error}</p>}
      {!mine && !error && <p>Laden…</p>}
      <ul className="plain">
        {mine?.map(p => (
          <li key={p.id}>
            <label>
              <input
                type="checkbox"
                checked={linked(p.id)}
                disabled={busy === p.id}
                onChange={() => (linked(p.id) ? unlink(p.id) : link(p))}
              />{' '}
              {p.name} <small>({busy === p.id ? 'ophalen…' : `${p.total} nummers`})</small>
            </label>
          </li>
        ))}
      </ul>
    </section>
  )
}

const DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za']

export function Templates({ state, setState }: Props) {
  const update = (id: string, patch: Partial<Template>) =>
    setState(s => ({ ...s, templates: s.templates.map(t => (t.id === id ? { ...t, ...patch } : t)) }))

  const add = () =>
    setState(s => ({
      ...s,
      templates: [...s.templates, { id: crypto.randomUUID(), name: 'Nieuw template', weights: {}, triggers: [] }],
    }))

  return (
    <section>
      <h2>Templates</h2>
      <p>
        Gewichten zijn relatieve getallen. Actieve templates tellen bij elkaar op; de standaard geldt alleen als er geen
        ander actief is.
      </p>
      {state.templates.map(t => {
        const isDefault = t.id === state.defaultTemplateId
        const setTrigger = (i: number, tr: Trigger) => update(t.id, { triggers: t.triggers.map((x, j) => (j === i ? tr : x)) })
        return (
          <article key={t.id} className="card">
            <div className="row">
              <input value={t.name} onChange={e => update(t.id, { name: e.target.value })} aria-label="Naam" />
              <label>
                <input
                  type="radio"
                  checked={isDefault}
                  onChange={() => setState(s => ({ ...s, defaultTemplateId: t.id }))}
                />{' '}
                standaard
              </label>
              {!isDefault && (
                <button onClick={() => setState(s => ({ ...s, templates: s.templates.filter(x => x.id !== t.id) }))}>
                  Verwijderen
                </button>
              )}
            </div>

            <table>
              <tbody>
                {state.playlists.map(p => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        value={t.weights[p.id] ?? 0}
                        onChange={e => update(t.id, { weights: { ...t.weights, [p.id]: Math.max(0, Number(e.target.value)) } })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!state.playlists.length && <p>Koppel eerst playlists.</p>}

            {isDefault ? (
              <p>
                <small>De standaard heeft geen tijdvensters.</small>
              </p>
            ) : (
              <>
                <h3>Actief wanneer</h3>
                {!t.triggers.length && <p><small>Nog geen tijdvenster: dit template wordt nooit actief.</small></p>}
                {t.triggers.map((tr, i) => (
                  <div key={i} className="row">
                    <TriggerEditor trigger={tr} onChange={x => setTrigger(i, x)} />
                    <button onClick={() => update(t.id, { triggers: t.triggers.filter((_, j) => j !== i) })}>×</button>
                  </div>
                ))}
                <div className="row">
                  <button
                    onClick={() =>
                      update(t.id, { triggers: [...t.triggers, { type: 'weekly', days: [0], from: '08:00', to: '12:00' }] })
                    }
                  >
                    + Wekelijks venster
                  </button>
                  <button
                    onClick={() => update(t.id, { triggers: [...t.triggers, { type: 'dateRange', from: '12-01', to: '12-26' }] })}
                  >
                    + Datumbereik
                  </button>
                </div>
              </>
            )}
          </article>
        )
      })}
      <button onClick={add}>+ Template</button>
    </section>
  )
}

function TriggerEditor({ trigger, onChange }: { trigger: Trigger; onChange: (t: Trigger) => void }) {
  if (trigger.type === 'weekly')
    return (
      <span className="row">
        {DAYS.map((d, i) => (
          <label key={d}>
            <input
              type="checkbox"
              checked={trigger.days.includes(i)}
              onChange={e =>
                onChange({ ...trigger, days: e.target.checked ? [...trigger.days, i] : trigger.days.filter(x => x !== i) })
              }
            />
            {d}
          </label>
        ))}
        <input type="time" value={trigger.from} onChange={e => onChange({ ...trigger, from: e.target.value })} />
        –
        <input type="time" value={trigger.to} onChange={e => onChange({ ...trigger, to: e.target.value })} />
      </span>
    )
  // Stored as MM-DD (every year); the date input needs a year, so show it on 2000 (a leap year, so 29 Feb fits).
  return (
    <span className="row">
      elk jaar van
      <input type="date" value={`2000-${trigger.from}`} onChange={e => onChange({ ...trigger, from: e.target.value.slice(5) })} />
      t/m
      <input type="date" value={`2000-${trigger.to}`} onChange={e => onChange({ ...trigger, to: e.target.value.slice(5) })} />
    </span>
  )
}
