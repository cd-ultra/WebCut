/**
 * WebCut — timeline state store.
 *
 * Performance architecture (60 FPS scrubbing):
 *
 *  1. STRUCTURAL state (tracks, clips, selection, zoom) lives in a Zustand
 *     store and flows through React normally — these mutate at human speed.
 *
 *  2. TEMPORAL state (the playhead frame) mutates at up to display refresh
 *     rate during scrubs/playback. Routing it through React reconciliation
 *     would re-render the component tree every frame. Instead it lives in a
 *     side-channel `transport`: a mutable cell with its own subscriber list.
 *     The renderer and the playhead DOM node subscribe directly and write
 *     style/canvas output imperatively; React components that only need a
 *     coarse frame readout opt in via `useTransportFrame` (rAF-throttled).
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import {
  createEmptyProject,
  createId,
  MARKER_COLORS,
  type ClipItem,
  type Effect,
  type Marker,
  type MarkerId,
  type MediaAsset,
  type Project,
  type ProjectSettings,
  type Track,
  type TrackId,
  type TrackItem,
  type TrackItemId,
} from "../types/timeline";
import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Transport: transient, render-decoupled playhead
// ---------------------------------------------------------------------------

export type TransportListener = (frame: number) => void;

export interface Transport {
  /** Read the live playhead frame (always current, never stale). */
  getFrame(): number;
  /** Move the playhead. Notifies imperative subscribers synchronously. */
  setFrame(frame: number): void;
  /** Subscribe outside React. Returns an unsubscribe function. */
  subscribe(listener: TransportListener): () => void;
  isPlaying(): boolean;
  play(): void;
  pause(): void;
  togglePlayback(): void;
}

const createTransport = (getFps: () => number, getDuration: () => number): Transport => {
  let currentFrame = 0;
  let playing = false;
  let rafHandle = 0;
  let playStartTimestamp = 0;
  let playStartFrame = 0;
  const listeners = new Set<TransportListener>();

  const notify = () => {
    for (const listener of listeners) listener(currentFrame);
  };

  const tick = (timestamp: number) => {
    if (!playing) return;
    const elapsedSeconds = (timestamp - playStartTimestamp) / 1000;
    const nextFrame = playStartFrame + elapsedSeconds * getFps();
    const duration = getDuration();
    if (duration > 0 && nextFrame >= duration) {
      currentFrame = duration;
      playing = false;
      notify();
      return;
    }
    currentFrame = nextFrame;
    notify();
    rafHandle = requestAnimationFrame(tick);
  };

  return {
    getFrame: () => currentFrame,
    setFrame: (frame: number) => {
      const clamped = Math.max(0, frame);
      if (clamped === currentFrame) return;
      currentFrame = clamped;
      if (playing) {
        playStartFrame = clamped;
        playStartTimestamp = performance.now();
      }
      notify();
    },
    subscribe: (listener: TransportListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isPlaying: () => playing,
    play: () => {
      if (playing) return;
      playing = true;
      playStartFrame = currentFrame;
      playStartTimestamp = performance.now();
      rafHandle = requestAnimationFrame(tick);
    },
    pause: () => {
      playing = false;
      cancelAnimationFrame(rafHandle);
      currentFrame = Math.round(currentFrame);
      notify();
    },
    togglePlayback() {
      if (playing) this.pause();
      else this.play();
    },
  };
};

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export type EditorTool = "select" | "razor" | "hand";

/** A clipboard entry remembers which track an item came from for paste targeting. */
interface ClipboardEntry {
  readonly item: TrackItem;
  readonly trackId: TrackId;
}

export interface TimelineState {
  project: Project;
  selectedItemIds: readonly TrackItemId[];
  /** Track targeted for media-pool inserts; new clips land here at the playhead. */
  armedTrackId: TrackId | null;
  /** Horizontal zoom: how many screen pixels one frame occupies. */
  pixelsPerFrame: number;
  activeTool: EditorTool;
  /** Bumped on every structural edit; renderer uses it as a dirty flag. */
  revision: number;
  /** In-app clipboard for copy/cut/paste of timeline items. */
  clipboard: readonly ClipboardEntry[];
  /** Undo/redo stacks — full project snapshots (structural edits only). */
  past: readonly Project[];
  future: readonly Project[];

  // -- actions --
  setProject(project: Project): void;
  armTrack(trackId: TrackId): void;
  addTrack(kind: "video" | "audio"): TrackId;
  setActiveTool(tool: EditorTool): void;
  setPixelsPerFrame(ppf: number): void;
  zoomBy(factor: number): void;
  addAsset(asset: MediaAsset): void;
  addClipToTrack(trackId: TrackId, clip: Omit<ClipItem, "id">): TrackItemId;
  addItemToTrack(trackId: TrackId, item: Omit<TrackItem, "id">): TrackItemId;
  moveItem(itemId: TrackItemId, deltaFrames: number, targetTrackId?: TrackId): void;
  trimItem(itemId: TrackItemId, edge: "start" | "end", newFrame: number): void;
  splitItemAtFrame(itemId: TrackItemId, frame: number): void;
  removeItems(itemIds: readonly TrackItemId[]): void;
  rippleDelete(itemIds: readonly TrackItemId[]): void;
  setSelection(itemIds: readonly TrackItemId[]): void;
  updateItemEffects(itemId: TrackItemId, effects: readonly Effect[]): void;
  updateItem(itemId: TrackItemId, updater: (item: TrackItem) => TrackItem, coalesceKey?: string): void;
  setProjectSettings(patch: Partial<ProjectSettings>): void;
  addMarker(frame: number): void;
  updateMarker(markerId: MarkerId, patch: Partial<Pick<Marker, "label" | "color" | "frame">>): void;
  removeMarker(markerId: MarkerId): void;
  toggleTrackFlag(trackId: TrackId, flag: "muted" | "soloed" | "locked" | "hidden"): void;
  // clipboard + history
  copySelection(): void;
  cutSelection(): void;
  duplicateSelection(): void;
  pasteClipboard(): void;
  undo(): void;
  redo(): void;
}

const MIN_PPF = 0.02;
const MAX_PPF = 60;
const HISTORY_LIMIT = 100;
const COALESCE_MS = 600;

const mapItems = (project: Project, fn: (item: TrackItem, track: Track) => TrackItem): Project => ({
  ...project,
  tracks: project.tracks.map((track) => ({
    ...track,
    items: track.items.map((item) => fn(item, track)),
  })),
});

// -- Undo/redo history bookkeeping -------------------------------------------
// Continuous gestures (drags, slider scrubs) would otherwise flood the undo
// stack with one entry per pointer event. A coalesce key + time window folds a
// burst into the single pre-burst snapshot.
let lastCoalesceKey = "";
let lastCoalesceTime = 0;

type HistoryPatch = Pick<TimelineState, "past" | "future">;

/** Always push the current project as an undo checkpoint (discrete edits). */
const pushPast = (state: TimelineState): HistoryPatch => {
  lastCoalesceKey = "";
  return { past: [...state.past, state.project].slice(-HISTORY_LIMIT), future: [] };
};

/** Push a checkpoint unless this gesture already pushed one recently. */
const pushPastCoalesced = (state: TimelineState, key: string): HistoryPatch => {
  const now = Date.now();
  if (key === lastCoalesceKey && now - lastCoalesceTime < COALESCE_MS) {
    lastCoalesceTime = now;
    return { past: state.past, future: [] };
  }
  lastCoalesceKey = key;
  lastCoalesceTime = now;
  return { past: [...state.past, state.project].slice(-HISTORY_LIMIT), future: [] };
};

/**
 * Resolve the paste target track for an item, preferring its origin track and
 * falling back to the first video track (overlays and visual clips), then any
 * unlocked track.
 */
const targetTrackFor = (tracks: readonly Track[], originId: TrackId, _item: TrackItem): Track | undefined =>
  tracks.find((t) => t.id === originId && !t.locked) ??
  tracks.find((t) => t.kind === "video" && !t.locked) ??
  tracks.find((t) => !t.locked);

export const useTimelineStore = create<TimelineState>()(
  subscribeWithSelector((set, get) => ({
    project: createEmptyProject(),
    selectedItemIds: [],
    armedTrackId: null,
    pixelsPerFrame: 2,
    activeTool: "select",
    revision: 0,
    clipboard: [],
    past: [],
    future: [],

    setProject: (project) =>
      set({ project, selectedItemIds: [], armedTrackId: null, revision: get().revision + 1, past: [], future: [] }),

    armTrack: (trackId) => set({ armedTrackId: trackId }),

    addTrack: (kind) => {
      const id = createId<TrackId>();
      set((state) => {
        const sameKindCount = state.project.tracks.filter((track) => track.kind === kind).length;
        const maxIndex = state.project.tracks.reduce((max, track) => Math.max(max, track.index), -1);
        const newTrack: Track = {
          id,
          kind,
          name: `${kind === "video" ? "V" : "A"}${sameKindCount + 1}`,
          index: maxIndex + 1,
          items: [],
          muted: false,
          soloed: false,
          locked: false,
          hidden: false,
          heightPx: kind === "video" ? 56 : 40,
        };
        // Video tracks stack on top (compositing order = index, 0 = bottom);
        // the UI lists top-of-stack first, so prepend video, append audio.
        const tracks = kind === "video" ? [newTrack, ...state.project.tracks] : [...state.project.tracks, newTrack];
        return {
          project: { ...state.project, tracks },
          armedTrackId: id,
          revision: state.revision + 1,
          ...pushPast(state),
        };
      });
      return id;
    },

    setActiveTool: (activeTool) => set({ activeTool }),

    setPixelsPerFrame: (ppf) => set({ pixelsPerFrame: Math.min(MAX_PPF, Math.max(MIN_PPF, ppf)) }),

    zoomBy: (factor) => {
      const { pixelsPerFrame, setPixelsPerFrame } = get();
      setPixelsPerFrame(pixelsPerFrame * factor);
    },

    addAsset: (asset) =>
      set((state) => ({
        project: { ...state.project, assets: [...state.project.assets, asset] },
        revision: state.revision + 1,
        ...pushPast(state),
      })),

    addClipToTrack: (trackId, clip) => {
      const id = createId<TrackItemId>();
      set((state) => ({
        project: {
          ...state.project,
          tracks: state.project.tracks.map((track) =>
            track.id === trackId ? { ...track, items: [...track.items, { ...clip, id }] } : track,
          ),
        },
        revision: state.revision + 1,
        ...pushPast(state),
      }));
      return id;
    },

    addItemToTrack: (trackId, item) => {
      const id = createId<TrackItemId>();
      set((state) => ({
        project: {
          ...state.project,
          tracks: state.project.tracks.map((track) =>
            track.id === trackId ? { ...track, items: [...track.items, { ...item, id } as TrackItem] } : track,
          ),
        },
        selectedItemIds: [id],
        revision: state.revision + 1,
        ...pushPast(state),
      }));
      return id;
    },

    moveItem: (itemId, deltaFrames, targetTrackId) =>
      set((state) => {
        let moved: TrackItem | undefined;
        const stripped = state.project.tracks.map((track) => {
          const found = track.items.find((item) => item.id === itemId);
          if (!found) return track;
          moved = { ...found, startFrame: Math.max(0, found.startFrame + deltaFrames) };
          return { ...track, items: track.items.filter((item) => item.id !== itemId) };
        });
        if (!moved) return state;
        const destinationId =
          targetTrackId ?? state.project.tracks.find((t) => t.items.some((i) => i.id === itemId))?.id;
        const finalItem = moved;
        return {
          project: {
            ...state.project,
            tracks: stripped.map((track) =>
              track.id === (targetTrackId ?? destinationId) ? { ...track, items: [...track.items, finalItem] } : track,
            ),
          },
          revision: state.revision + 1,
          ...pushPastCoalesced(state, "move"),
        };
      }),

    trimItem: (itemId, edge, newFrame) =>
      set((state) => ({
        project: mapItems(state.project, (item) => {
          if (item.id !== itemId) return item;
          if (edge === "start") {
            const maxStart = item.startFrame + item.durationFrames - 1;
            const clampedStart = Math.max(0, Math.min(newFrame, maxStart));
            const consumed = clampedStart - item.startFrame;
            const next = {
              ...item,
              startFrame: clampedStart,
              durationFrames: item.durationFrames - consumed,
            };
            if (next.type === "clip") {
              return { ...next, sourceInFrame: Math.max(0, next.sourceInFrame + consumed) };
            }
            return next;
          }
          const newDuration = Math.max(1, newFrame - item.startFrame);
          return { ...item, durationFrames: newDuration };
        }),
        revision: state.revision + 1,
        ...pushPastCoalesced(state, "trim"),
      })),

    splitItemAtFrame: (itemId, frame) =>
      set((state) => {
        const wholeFrame = Math.round(frame);
        return {
          project: {
            ...state.project,
            tracks: state.project.tracks.map((track) => {
              const target = track.items.find((item) => item.id === itemId);
              if (
                !target ||
                wholeFrame <= target.startFrame ||
                wholeFrame >= target.startFrame + target.durationFrames
              ) {
                return track;
              }
              const leftDuration = wholeFrame - target.startFrame;
              const left: TrackItem = { ...target, durationFrames: leftDuration };
              const rightBase: TrackItem = {
                ...target,
                id: createId<TrackItemId>(),
                startFrame: wholeFrame,
                durationFrames: target.durationFrames - leftDuration,
              };
              const right: TrackItem =
                rightBase.type === "clip"
                  ? { ...rightBase, sourceInFrame: rightBase.sourceInFrame + leftDuration * rightBase.speed }
                  : rightBase;
              return {
                ...track,
                items: track.items.flatMap((item) => (item.id === itemId ? [left, right] : [item])),
              };
            }),
          },
          revision: state.revision + 1,
          ...pushPast(state),
        };
      }),

    removeItems: (itemIds) =>
      set((state) => ({
        project: {
          ...state.project,
          tracks: state.project.tracks.map((track) => ({
            ...track,
            items: track.items.filter((item) => !itemIds.includes(item.id)),
          })),
        },
        selectedItemIds: state.selectedItemIds.filter((id) => !itemIds.includes(id)),
        revision: state.revision + 1,
        ...pushPast(state),
      })),

    rippleDelete: (itemIds) =>
      set((state) => {
        const removed = new Set(itemIds);
        return {
          project: {
            ...state.project,
            tracks: state.project.tracks.map((track) => {
              const gone = track.items.filter((item) => removed.has(item.id));
              if (gone.length === 0) return track;
              const kept = track.items.filter((item) => !removed.has(item.id));
              // Each surviving item shifts left by the total duration of removed
              // items that started before it, closing every gap on the track.
              const shifted = kept.map((item) => {
                const delta = gone.reduce(
                  (sum, g) => (g.startFrame < item.startFrame ? sum + g.durationFrames : sum),
                  0,
                );
                return delta > 0 ? { ...item, startFrame: Math.max(0, item.startFrame - delta) } : item;
              });
              return { ...track, items: shifted };
            }),
          },
          selectedItemIds: state.selectedItemIds.filter((id) => !removed.has(id)),
          revision: state.revision + 1,
          ...pushPast(state),
        };
      }),

    setSelection: (selectedItemIds) => set({ selectedItemIds }),

    updateItemEffects: (itemId, effects) =>
      set((state) => ({
        project: mapItems(state.project, (item) => (item.id === itemId ? { ...item, effects } : item)),
        revision: state.revision + 1,
        ...pushPastCoalesced(state, `effects:${itemId}`),
      })),

    updateItem: (itemId, updater, coalesceKey) =>
      set((state) => ({
        project: mapItems(state.project, (item) => (item.id === itemId ? updater(item) : item)),
        revision: state.revision + 1,
        ...(coalesceKey ? pushPastCoalesced(state, `${coalesceKey}:${itemId}`) : pushPast(state)),
      })),

    setProjectSettings: (patch) =>
      set((state) => ({
        project: { ...state.project, settings: { ...state.project.settings, ...patch } },
        revision: state.revision + 1,
        ...pushPastCoalesced(state, "settings"),
      })),

    addMarker: (frame) =>
      set((state) => {
        const wholeFrame = Math.max(0, Math.round(frame));
        const marker: Marker = {
          id: createId<MarkerId>(),
          frame: wholeFrame,
          label: "",
          color: MARKER_COLORS[state.project.markers.length % MARKER_COLORS.length],
        };
        const markers = [...state.project.markers, marker].sort((a, b) => a.frame - b.frame);
        return {
          project: { ...state.project, markers },
          revision: state.revision + 1,
          ...pushPast(state),
        };
      }),

    updateMarker: (markerId, patch) =>
      set((state) => ({
        project: {
          ...state.project,
          markers: state.project.markers
            .map((marker) => (marker.id === markerId ? { ...marker, ...patch } : marker))
            .sort((a, b) => a.frame - b.frame),
        },
        revision: state.revision + 1,
        ...pushPastCoalesced(state, `marker:${markerId}`),
      })),

    removeMarker: (markerId) =>
      set((state) => ({
        project: {
          ...state.project,
          markers: state.project.markers.filter((marker) => marker.id !== markerId),
        },
        revision: state.revision + 1,
        ...pushPast(state),
      })),

    toggleTrackFlag: (trackId, flag) =>
      set((state) => ({
        project: {
          ...state.project,
          tracks: state.project.tracks.map((track) =>
            track.id === trackId ? { ...track, [flag]: !track[flag] } : track,
          ),
        },
        revision: state.revision + 1,
        ...pushPast(state),
      })),

    // -- clipboard --------------------------------------------------------------

    copySelection: () =>
      set((state) => ({ clipboard: collectSelection(state) })),

    cutSelection: () =>
      set((state) => {
        const entries = collectSelection(state);
        if (entries.length === 0) return state;
        const ids = new Set(entries.map((e) => e.item.id));
        return {
          clipboard: entries,
          project: {
            ...state.project,
            tracks: state.project.tracks.map((track) => ({
              ...track,
              items: track.items.filter((item) => !ids.has(item.id)),
            })),
          },
          selectedItemIds: [],
          revision: state.revision + 1,
          ...pushPast(state),
        };
      }),

    duplicateSelection: () =>
      set((state) => {
        const entries = collectSelection(state);
        if (entries.length === 0) return state;
        const newIds: TrackItemId[] = [];
        const tracks = state.project.tracks.map((track) => {
          const dupes = entries
            .filter((e) => e.trackId === track.id)
            .map((e) => {
              const id = createId<TrackItemId>();
              newIds.push(id);
              // Place the copy immediately after the original on the same track.
              return { ...e.item, id, startFrame: e.item.startFrame + e.item.durationFrames } as TrackItem;
            });
          return dupes.length > 0 ? { ...track, items: [...track.items, ...dupes] } : track;
        });
        return {
          project: { ...state.project, tracks },
          selectedItemIds: newIds,
          revision: state.revision + 1,
          ...pushPast(state),
        };
      }),

    pasteClipboard: () =>
      set((state) => {
        const entries = state.clipboard;
        if (entries.length === 0) return state;
        const minStart = Math.min(...entries.map((e) => e.item.startFrame));
        const delta = Math.round(transport.getFrame()) - minStart;
        const newIds: TrackItemId[] = [];
        let tracks = state.project.tracks;
        for (const entry of entries) {
          const target = targetTrackFor(tracks, entry.trackId, entry.item);
          if (!target) continue;
          const id = createId<TrackItemId>();
          newIds.push(id);
          const pasted = {
            ...entry.item,
            id,
            startFrame: Math.max(0, entry.item.startFrame + delta),
          } as TrackItem;
          tracks = tracks.map((track) =>
            track.id === target.id ? { ...track, items: [...track.items, pasted] } : track,
          );
        }
        if (newIds.length === 0) return state;
        return {
          project: { ...state.project, tracks },
          selectedItemIds: newIds,
          revision: state.revision + 1,
          ...pushPast(state),
        };
      }),

    // -- undo / redo ------------------------------------------------------------

    undo: () =>
      set((state) => {
        if (state.past.length === 0) return state;
        lastCoalesceKey = "";
        const previous = state.past[state.past.length - 1];
        return {
          project: previous,
          past: state.past.slice(0, -1),
          future: [state.project, ...state.future].slice(0, HISTORY_LIMIT),
          selectedItemIds: [],
          revision: state.revision + 1,
        };
      }),

    redo: () =>
      set((state) => {
        if (state.future.length === 0) return state;
        lastCoalesceKey = "";
        const next = state.future[0];
        return {
          project: next,
          past: [...state.past, state.project].slice(-HISTORY_LIMIT),
          future: state.future.slice(1),
          selectedItemIds: [],
          revision: state.revision + 1,
        };
      }),
  })),
);

/** Gather the currently-selected items paired with their owning track id. */
const collectSelection = (state: TimelineState): ClipboardEntry[] => {
  const selected = new Set(state.selectedItemIds);
  const entries: ClipboardEntry[] = [];
  for (const track of state.project.tracks) {
    for (const item of track.items) {
      if (selected.has(item.id)) entries.push({ item, trackId: track.id });
    }
  }
  return entries;
};

// ---------------------------------------------------------------------------
// Transport singleton (constructed against live store reads)
// ---------------------------------------------------------------------------

const projectDurationFrames = (project: Project): number => {
  let max = 0;
  for (const track of project.tracks) {
    for (const item of track.items) {
      max = Math.max(max, item.startFrame + item.durationFrames);
    }
  }
  return max;
};

export const transport: Transport = createTransport(
  () => useTimelineStore.getState().project.settings.frameRate,
  () => projectDurationFrames(useTimelineStore.getState().project),
);

/**
 * React hook for components that want the playhead frame WITHOUT joining the
 * per-frame hot path. Updates are coalesced to one setState per animation
 * frame, and only when the integer frame actually changed.
 */
export const useTransportFrame = (): number => {
  const [frame, setFrame] = useState(() => Math.floor(transport.getFrame()));
  const pendingRaf = useRef(0);

  useEffect(() => {
    const unsubscribe = transport.subscribe((liveFrame) => {
      if (pendingRaf.current) return;
      pendingRaf.current = requestAnimationFrame(() => {
        pendingRaf.current = 0;
        const whole = Math.floor(liveFrame);
        setFrame((previous) => (previous === whole ? previous : whole));
      });
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(pendingRaf.current);
    };
  }, []);

  return frame;
};

/** Convenience selectors (referentially stable picks keep re-renders narrow). */
export const useProjectSettings = () => useTimelineStore((state) => state.project.settings);
export const useTracks = () => useTimelineStore((state) => state.project.tracks);
export const useAssets = () => useTimelineStore((state) => state.project.assets);
export const useSelection = () => useTimelineStore((state) => state.selectedItemIds);

// ---------------------------------------------------------------------------
// Dev console handle: the page's live store/transport instances. Module-URL
// imports from devtools resolve to a second instance; this is the real one.
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __webcut?: { store: typeof useTimelineStore; transport: Transport };
  }
}
if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__webcut = { store: useTimelineStore, transport };
}
