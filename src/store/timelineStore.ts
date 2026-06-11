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
  type ClipItem,
  type Effect,
  type MediaAsset,
  type Project,
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

  // -- actions --
  setProject(project: Project): void;
  armTrack(trackId: TrackId): void;
  addTrack(kind: "video" | "audio"): TrackId;
  setActiveTool(tool: EditorTool): void;
  setPixelsPerFrame(ppf: number): void;
  zoomBy(factor: number): void;
  addAsset(asset: MediaAsset): void;
  addClipToTrack(trackId: TrackId, clip: Omit<ClipItem, "id">): TrackItemId;
  moveItem(itemId: TrackItemId, deltaFrames: number, targetTrackId?: TrackId): void;
  trimItem(itemId: TrackItemId, edge: "start" | "end", newFrame: number): void;
  splitItemAtFrame(itemId: TrackItemId, frame: number): void;
  removeItems(itemIds: readonly TrackItemId[]): void;
  setSelection(itemIds: readonly TrackItemId[]): void;
  updateItemEffects(itemId: TrackItemId, effects: readonly Effect[]): void;
  toggleTrackFlag(trackId: TrackId, flag: "muted" | "soloed" | "locked" | "hidden"): void;
}

const MIN_PPF = 0.02;
const MAX_PPF = 60;

const mapItems = (project: Project, fn: (item: TrackItem, track: Track) => TrackItem): Project => ({
  ...project,
  tracks: project.tracks.map((track) => ({
    ...track,
    items: track.items.map((item) => fn(item, track)),
  })),
});

export const useTimelineStore = create<TimelineState>()(
  subscribeWithSelector((set, get) => ({
    project: createEmptyProject(),
    selectedItemIds: [],
    armedTrackId: null,
    pixelsPerFrame: 2,
    activeTool: "select",
    revision: 0,

    setProject: (project) => set({ project, selectedItemIds: [], armedTrackId: null, revision: get().revision + 1 }),

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
      })),

    setSelection: (selectedItemIds) => set({ selectedItemIds }),

    updateItemEffects: (itemId, effects) =>
      set((state) => ({
        project: mapItems(state.project, (item) => (item.id === itemId ? { ...item, effects } : item)),
        revision: state.revision + 1,
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
      })),
  })),
);

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
