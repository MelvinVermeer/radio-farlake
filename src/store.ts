// All config lives in localStorage: one user, small data, survives restarts.
// ponytail: playlist track cache shares localStorage's ~5 MB; move tracks to IndexedDB if you link ~20k+ tracks.
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { Mood, Play, Template, Track } from './engine'

export type LinkedPlaylist = { id: string; name: string; snapshot: string; tracks: Track[] }

export type State = {
  playlists: LinkedPlaylist[]
  templates: Template[]
  defaultTemplateId: string
  tuning: Record<string, number> // added on top of the active templates until reset
  mood: Mood // filters the ReccoBeats recommendations until reset
  history: Play[]
}

export type SetState = Dispatch<SetStateAction<State>>

const KEY ='radio-farlake:state'
const DAY = 24 * 60 * 60 * 1000

const initial = (): State => ({
  playlists: [],
  templates: [{ id: 'default', name: 'Standaard', weights: {}, triggers: [] }],
  defaultTemplateId: 'default',
  tuning: {},
  mood: {},
  history: [],
})

function load(): State {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...initial(), ...JSON.parse(raw) } : initial()
  } catch {
    return initial()
  }
}

export function useStore() {
  const [state, setState] = useState(load)
  useEffect(() => {
    const pruned = { ...state, history: state.history.filter(p => p.at > Date.now() - DAY) }
    localStorage.setItem(KEY, JSON.stringify(pruned))
  }, [state])
  return [state, setState] as const
}
