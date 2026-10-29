import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  activeTemplates,
  combinedWeights,
  fillQueue,
  FEATURES,
  matchMood,
  toPlay,
  type Feature,
  type QueueItem,
  type Template,
  type Track,
} from "./engine";
import { fetchPool, RECCO_ID } from "./reccobeats";
import { createPlayer, initAuth, login, logout, type Player } from "./spotify";
import { useStore, type SetState, type State } from "./store";
import { Playlists, Templates } from "./Manage";

type Tab = "radio" | "playlists" | "templates";


export default function App() {
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  const [error, setError] = useState<string>();
  useEffect(() => {
    initAuth().then(
      (ok) => setAuth(ok ? "in" : "out"),
      (e) => {
        setError(String(e));
        setAuth("out");
      },
    );
  }, []);

  if (auth === "loading") return <main>Laden…</main>;
  if (auth === "out")
    return (
      <main className="center">
        <h1>Radio Farlake</h1>
        {error && <p className="error">{error}</p>}
        <button onClick={login}>Inloggen met Spotify</button>
      </main>
    );
  return <Radio />;
}

function Radio() {
  const [state, setState] = useStore();
  const [tab, setTab] = useState<Tab>("radio");
  const [now, setNow] = useState(() => new Date());
  const [player, setPlayer] = useState<Player>();
  const [current, setCurrent] = useState<{
    item: QueueItem;
    startedAt: number;
  }>();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [drag, setDrag] = useState<{ from: number; to: number }>();
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const active = useMemo(
    () => activeTemplates(state.templates, state.defaultTemplateId, now),
    [state.templates, state.defaultTemplateId, now],
  );
  const tracks = useMemo(
    () =>
      Object.fromEntries(
        state.playlists.map((p) => [
          p.id,
          p.id === RECCO_ID ? matchMood(p.tracks, state.mood) : p.tracks,
        ]),
      ),
    [state.playlists, state.mood],
  );
  const playlistIds = state.playlists
    .filter((p) => p.tracks.length)
    .map((p) => p.id);
  const weights = combinedWeights(active, state.tuning, playlistIds);
  const weightsKey = JSON.stringify(weights);

  // The SDK callback outlives renders; it reads the latest values through this ref.
  const latest = useRef({ state, weights, tracks, queue, current, player });
  latest.current = { state, weights, tracks, queue, current, player };
  const progressed = useRef(false);
  const advancing = useRef(false);

  const queueStart = (cur = latest.current.current) =>
    cur ? cur.startedAt + cur.item.track.durationMs : Date.now();

  async function advance(from: QueueItem[]) {
    const { weights, tracks, state, player } = latest.current;
    if (!player || advancing.current) return;
    advancing.current = true;
    try {
      const [next, ...rest] = from.length
        ? from
        : fillQueue([], weights, tracks, state.history, Date.now());
      if (!next)
        return setError(
          "Geen nummers om te draaien: koppel een playlist met nummers.",
        );
      const startedAt = Date.now();
      const play = toPlay(next, startedAt);
      progressed.current = false;
      const cur = { item: next, startedAt };
      latest.current.current = cur;
      setCurrent(cur);
      setState((s) => ({ ...s, history: [...s.history, play] }));
      setQueue(
        fillQueue(
          rest,
          weights,
          tracks,
          [...state.history, play],
          startedAt + next.track.durationMs,
        ),
      );
      await player.play(next.track.uri);
      setPaused(false);
    } catch (e) {
      setError(String(e));
    } finally {
      advancing.current = false;
    }
  }

  useEffect(() => {
    createPlayer((s) => {
      const cur = latest.current.current;
      if (!s || !cur) return;
      setPaused(s.paused);
      const uri = s.track_window.current_track?.uri;
      if (uri === cur.item.track.uri && s.position > 0)
        progressed.current = true;
      // A single-uri play ends by stopping at 0, or by Spotify autoplay moving on to another track.
      // ponytail: uri compare misfires if Spotify relinks a track to another uri; compare by name if that shows up.
      const ended =
        progressed.current &&
        ((s.paused && s.position === 0) ||
          (!!uri && uri !== cur.item.track.uri));
      if (ended) void advance(latest.current.queue);
    }, setError).then(setPlayer, (e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New ratio (tuning, a template window opening or closing, linked playlists): redraw the whole queue.
  // The track that plays now stays.
  useEffect(() => {
    setQueue(
      fillQueue(
        [],
        weights,
        tracks,
        latest.current.state.history,
        queueStart(),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weightsKey, tracks]);

  const skipQueued = (item: QueueItem) =>
    setQueue((q) =>
      fillQueue(
        q.filter((x) => x !== item),
        weights,
        tracks,
        state.history,
        queueStart(),
      ),
    );

  // Slide the track off its row, revealing the remove indicator; the rows below then glide up via the FLIP effect.
  async function removeQueued(li: HTMLElement, item: QueueItem, dir: number) {
    li.classList.add("swiping", "armed");
    const track = li.querySelector(".track")!;
    await track.animate(
      { transform: `translateX(${dir * 100}%)` },
      { duration: 180, easing: "ease-in", fill: "forwards" },
    ).finished;
    skipQueued(item);
  }

  // Manual order wins: the anti-repeat rules only apply to newly drawn tracks.
  const moveQueued = (from: number, to: number) =>
    setQueue((q) => {
      if (to < 0 || to >= q.length) return q;
      const n = [...q];
      n.splice(to, 0, ...n.splice(from, 1));
      return n;
    });

  // FLIP: rows that changed position since the last render animate from their old spot.
  const listRef = useRef<HTMLOListElement>(null);
  const tops = useRef(new Map<Element, number>());
  useLayoutEffect(() => {
    const prev = tops.current;
    tops.current = new Map();
    for (const li of listRef.current?.children ?? []) {
      const top = (li as HTMLElement).offsetTop;
      const old = prev.get(li);
      tops.current.set(li, top);
      if (old !== undefined && old !== top)
        li.animate(
          { transform: [`translateY(${old - top}px)`, "none"] },
          { duration: 200, easing: "ease-out" },
        );
    }
  }, [queue]);

  // Pointer events instead of HTML5 drag-and-drop so it also works on touch screens.
  // A ghost copy follows the pointer and a drop marker shows the target; the move happens on release.
  // ponytail: indices are fixed at drag start; if a track ends mid-drag the drop lands one slot off.
  function startDrag(li: HTMLElement, x0: number, y0: number, from: number) {
    let to = from;
    setDrag({ from, to });
    const r = li.getBoundingClientRect();
    const ghost = li.cloneNode(true) as HTMLElement;
    ghost.className = "ghost";
    Object.assign(ghost.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
    });
    document.body.append(ghost);
    const move = (ev: PointerEvent) => {
      ghost.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`;
      const t = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>(".queue li");
      if (t && Number(t.dataset.i) !== to)
        setDrag({ from, to: (to = Number(t.dataset.i)) });
    };
    // A long-press drag starts on an element that still allows panning; block the scroll from here on.
    const noScroll = (ev: TouchEvent) => ev.preventDefault();
    const end = (ev: PointerEvent) => {
      removeEventListener("touchmove", noScroll);
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      ghost.remove();
      if (ev.type === "pointerup") moveQueued(from, to);
      setDrag(undefined);
    };
    addEventListener("touchmove", noScroll, { passive: false });
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  }

  // Horizontal swipe removes the row. Vertical: mouse drags right away, touch drags after a long press
  // (so a normal vertical swipe still scrolls).
  function pressItem(e: React.PointerEvent<HTMLLIElement>, i: number) {
    if (e.button) return;
    const li = e.currentTarget;
    const track = li.querySelector<HTMLElement>(".track")!;
    const item = queue[i];
    const far = (dx: number) => Math.abs(dx) > li.offsetWidth / 3;
    const { clientX: x0, clientY: y0 } = e;
    const mouse = e.pointerType === "mouse";
    let swiping = false;
    const timer = setTimeout(() => {
      if (mouse) return;
      stop();
      navigator.vibrate?.(10);
      startDrag(li, x0, y0, i);
    }, 400);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (swiping) {
        track.style.transform = `translateX(${dx}px)`;
        li.classList.toggle("armed", far(dx));
        return;
      }
      if (Math.hypot(dx, dy) < 8) return;
      clearTimeout(timer);
      if (Math.abs(dx) > Math.abs(dy)) {
        swiping = true;
        li.classList.add("swiping");
      } else {
        stop();
        if (mouse) startDrag(li, x0, y0, i);
      }
    };
    const up = (ev: PointerEvent) => {
      clearTimeout(timer);
      stop();
      if (!swiping) return;
      const dx = ev.clientX - x0;
      if (ev.type === "pointerup" && far(dx))
        return void removeQueued(li, item, Math.sign(dx));
      li.classList.remove("armed");
      track.animate(
        { transform: [track.style.transform, "none"] },
        { duration: 150, easing: "ease-out" },
      ).onfinish = () => li.classList.remove("swiping");
      track.style.transform = "";
    };
    const stop = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  }

  const name = (id: string) =>
    state.playlists.find((p) => p.id === id)?.name ?? "?";
  const relaxed = [current?.item, ...queue].some((i) => i?.relaxed);

  return (
    <main>
      {error && (
        <p
          className="error"
          onClick={() => setError(undefined)}
          title="Klik om te sluiten"
        >
          {error}
        </p>
      )}

      {tab === "playlists" && <Playlists state={state} setState={setState} />}
      {tab === "templates" && <Templates state={state} setState={setState} />}
      {tab === "radio" && (
        <>
          {!state.playlists.length && (
            <p>Koppel eerst een paar playlists onder "Playlists".</p>
          )}
          <section className="now">
            {current ? (
              <>
                <small>
                  Nu speelt
                  {active.length > 0 && (
                    <span> · {active.map((t) => t.name).join(" + ")}</span>
                  )}
                </small>
                <div className="track">
                  <strong>
                    {current.item.track.artists.map((a) => a.name).join(", ")}
                  </strong>
                  <div>{current.item.track.name}</div>
                </div>
                <div className="row">
                  <button
                    onClick={() => player?.sdk.togglePlay()}
                    aria-label={paused ? "Afspelen" : "Pauze"}
                  >
                    {paused ? playIcon : pauseIcon}
                  </button>
                  <button
                    className="next"
                    onClick={() => advance(queue)}
                    aria-label="Overslaan"
                  >
                    {skipIcon}
                  </button>
                </div>
              </>
            ) : (
              <button
                disabled={!player || !queue.length}
                onClick={async () => {
                  await player?.sdk.activateElement();
                  void advance(queue);
                }}
              >
                {player ? "Start radio" : "Speler verbinden…"}
              </button>
            )}
          </section>

          {relaxed && (
            <p className="notice">
              Te weinig keuze: de anti-herhaalregels zijn tijdelijk versoepeld.
            </p>
          )}

          <h2>Straks</h2>
          <ol className="queue" ref={listRef}>
            {queue.map((item, i) => (
              <li
                key={keyOf(item)}
                data-i={i}
                tabIndex={0}
                aria-keyshortcuts="ArrowUp ArrowDown Delete"
                onPointerDown={(e) => pressItem(e, i)}
                onKeyDown={(e) => {
                  const d = { ArrowUp: -1, ArrowDown: 1 }[e.key];
                  if (d) moveQueued(i, i + d);
                  else if (e.key === "Delete" || e.key === "Backspace")
                    void removeQueued(e.currentTarget, item, 1);
                  else return;
                  e.preventDefault();
                }}
                className={
                  drag?.from === i
                    ? "dragging"
                    : drag && drag.to === i
                      ? drag.to < drag.from
                        ? "drop-before"
                        : "drop-after"
                      : undefined
                }
              >
                <TrackRow item={item} playlist={name(item.playlistId)} />
                <span className="swipe-icon l">{trashIcon}</span>
                <span className="swipe-icon r">{trashIcon}</span>
              </li>
            ))}
          </ol>

          <Tuning
            state={state}
            setState={setState}
            active={active}
            weights={weights}
            tracks={tracks}
            name={name}
          />
        </>
      )}
      <nav className="tabs">
        {(["radio", "playlists", "templates"] as const).map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {
              {
                radio: "Radio",
                playlists: "Playlists",
                templates: "Templates",
              }[t]
            }
          </button>
        ))}
        <button onClick={logout}>Uitloggen</button>
      </nav>
    </main>
  );
}

function TrackRow({ item, playlist }: { item: QueueItem; playlist: string }) {
  return (
    <div className="track">
      <strong>{item.track.artists.map((a) => a.name).join(", ")}</strong> –{" "}
      {item.track.name} <small>({playlist})</small>
    </div>
  );
}

function Tuning(props: {
  state: State;
  setState: SetState;
  active: Template[];
  weights: Record<string, number>;
  tracks: Record<string, Track[]>;
  name: (id: string) => string;
}) {
  const { state, setState, active, weights, tracks, name } = props;
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  const tuned =
    Object.values(state.tuning).some(Boolean) ||
    Object.keys(state.mood).length > 0;
  const base = (id: string) =>
    active.reduce((s, t) => s + (t.weights[id] ?? 0), 0);
  const nudge = (id: string, delta: number) =>
    setState((s) => ({
      ...s,
      tuning: {
        ...s.tuning,
        [id]: Math.max((s.tuning[id] ?? 0) + delta, -base(id)),
      },
    }));

  return (
    <section>
      {tuned && (
        <p className="notice">
          Tuning actief, blijft staan tot je reset.{" "}
          <button
            onClick={() => setState((s) => ({ ...s, tuning: {}, mood: {} }))}
          >
            Reset
          </button>
        </p>
      )}
      <details>
        <summary>Tuning</summary>
        <ul className="tuning">
          {state.playlists.map((p) => (
            <li key={p.id}>
              <span>{p.name}</span>
              <button
                onClick={() => nudge(p.id, -1)}
                aria-label={`${p.name} minder`}
              >
                -
              </button>
              <b>{weights[p.id] ?? 0}</b>
              <button
                onClick={() => nudge(p.id, 1)}
                aria-label={`${p.name} meer`}
              >
                +
              </button>
            </li>
          ))}
        </ul>
      </details>
      <Mood state={state} setState={setState} weights={weights} tracks={tracks} />
      <details>
        <summary>Waarom speelt dit?</summary>
        <p>Actieve templates: {active.map((t) => t.name).join(" + ")}</p>
        <ul>
          {Object.entries(weights).map(([id, w]) => (
            <li key={id}>
              {name(id)}: {w} ({Math.round((w / total) * 100)}%)
              {state.tuning[id]
                ? `, tuning ${state.tuning[id] > 0 ? "+" : ""}${state.tuning[id]}`
                : ""}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

const LABELS: Record<Feature, string> = {
  acousticness: "Akoestisch",
  danceability: "Dansbaar",
  energy: "Energiek",
  instrumentalness: "Instrumentaal",
  liveness: "Live",
  loudness: "Luidheid",
  speechiness: "Gesproken",
  tempo: "Tempo",
  valence: "Vrolijk",
};
const format = (k: Feature, v: number) =>
  k === "loudness"
    ? `${Math.round(v)} dB`
    : k === "tempo"
      ? `${Math.round(v)} BPM`
      : `${Math.round(v * 100)}%`;

// Recommendations from ReccoBeats as one extra source. One fetch gives a broad pool with audio features;
// the sliders only filter that pool, so they react instantly.
function Mood(props: {
  state: State;
  setState: SetState;
  weights: Record<string, number>;
  tracks: Record<string, Track[]>;
}) {
  const { state, setState, weights, tracks } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pool = state.playlists.find((p) => p.id === RECCO_ID)?.tracks;

  async function refresh() {
    setBusy(true);
    setError(undefined);
    try {
      const fresh = await fetchPool(weights, tracks);
      setState((s) => {
        // First time: give the new source a weight in the default template, else it would never play.
        const weighted = s.templates.some((t) => t.weights[RECCO_ID] !== undefined);
        const avg = (w: Record<string, number>) => {
          const v = Object.values(w).filter(Boolean);
          return Math.round(v.reduce((a, b) => a + b, 0) / v.length) || 1;
        };
        return {
          ...s,
          playlists: [
            ...s.playlists.filter((p) => p.id !== RECCO_ID),
            { id: RECCO_ID, name: "ReccoBeats-aanbevelingen", snapshot: "", tracks: fresh },
          ],
          templates: weighted
            ? s.templates
            : s.templates.map((t) =>
                t.id === s.defaultTemplateId
                  ? { ...t, weights: { ...t.weights, [RECCO_ID]: avg(t.weights) } }
                  : t,
              ),
        };
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Switching a feature on starts at the pool's average, so it filters nothing until you move it.
  const average = (k: Feature) => {
    const v = (pool ?? []).map((t) => t.features?.[k]).filter((x) => x !== undefined);
    const [min, max] = FEATURES[k];
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : (min + max) / 2;
  };

  const setMood = (k: Feature, v: number | undefined) =>
    setState((s) => {
      const mood = { ...s.mood };
      if (v === undefined) delete mood[k];
      else mood[k] = v;
      return { ...s, mood };
    });

  return (
    <details>
      <summary>Sfeer (aanbevelingen)</summary>
      <p>
        <small>
          {pool
            ? `${tracks[RECCO_ID]?.length ?? 0} van ${pool.length} aanbevelingen passen bij de sfeer. `
            : "Nog geen aanbevelingen. "}
          Gebaseerd op wat nu draait.
        </small>{" "}
        <button disabled={busy} onClick={refresh}>
          {busy ? "Ophalen…" : pool ? "Nieuwe aanbevelingen" : "Aanbevelingen ophalen"}
        </button>
      </p>
      {error && <p className="error">{error}</p>}
      <ul className="tuning">
        {(Object.keys(FEATURES) as Feature[]).map((k) => {
          const v = state.mood[k];
          const [min, max] = FEATURES[k];
          const label = LABELS[k];
          return (
            <li key={k}>
              <label>
                <input
                  type="checkbox"
                  checked={v !== undefined}
                  onChange={(e) => setMood(k, e.target.checked ? average(k) : undefined)}
                />{" "}
                {label}
              </label>
              <input
                type="range"
                min={min}
                max={max}
                step={(max - min) / 100}
                value={v ?? average(k)}
                disabled={v === undefined}
                onChange={(e) => setMood(k, Number(e.target.value))}
                aria-label={label}
              />
              <b>{v === undefined ? "–" : format(k, v)}</b>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// Stable React keys per queue item (object identity survives reorders), so rows can animate.
const ids = new WeakMap<QueueItem, number>();
let nextId = 0;
const keyOf = (item: QueueItem) =>
  ids.get(item) ?? (ids.set(item, ++nextId), nextId);

const icon = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const playIcon = icon("M7 5v14l12-7z");
const pauseIcon = icon("M6 5h4v14H6zM14 5h4v14h-4z");
const skipIcon = icon("M5 5l10 7-10 7zM17 5h2v14h-2z");
const trashIcon = icon(
  "M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7zM10 11v8h1.5v-8zM12.5 11v8H14v-8z",
);
