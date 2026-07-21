/**
 * WebCut — Multi-track timeline.
 *
 * Frame-accurate playhead, pixels-per-frame zoom, razor (split) tool, clip
 * dragging and edge trimming. The playhead element is positioned imperatively
 * via the transport subscription — dragging it never re-renders React.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Bookmark,
  Eye,
  EyeOff,
  Layers,
  Lock,
  LockOpen,
  Magnet,
  MousePointer2,
  Pause,
  Play,
  Scissors,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ASSET_DND_MIME, ingestFiles } from "../services/mediaImport";
import {
  transport,
  useTimelineStore,
  useTransportFrame,
} from "../store/timelineStore";
import {
  framesToTimecode,
  identityTransform,
  type Marker,
  type MediaAsset,
  type Track,
  type TrackId,
  type TrackItem,
  type TrackItemId,
} from "../types/timeline";

const HEADER_WIDTH = 168;
const RULER_HEIGHT = 28;

// ---------------------------------------------------------------------------
// Ruler tick spacing: choose a frame interval that yields ~80px tick gaps.
// ---------------------------------------------------------------------------

const NICE_FRAME_STEPS = [1, 2, 5, 10, 15, 30, 60, 150, 300, 600, 1800, 3600, 9000, 18000];

const pickTickStep = (pixelsPerFrame: number): number => {
  const targetPx = 80;
  for (const step of NICE_FRAME_STEPS) {
    if (step * pixelsPerFrame >= targetPx) return step;
  }
  return NICE_FRAME_STEPS[NICE_FRAME_STEPS.length - 1];
};

// ---------------------------------------------------------------------------
// Playhead — imperative positioning, zero React churn while scrubbing
// ---------------------------------------------------------------------------

const Playhead = ({ pixelsPerFrame, scrollLeft }: { pixelsPerFrame: number; scrollLeft: number }) => {
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const position = (frame: number) => {
      const node = lineRef.current;
      if (!node) return;
      node.style.transform = `translateX(${frame * pixelsPerFrame - scrollLeft}px)`;
    };
    position(transport.getFrame());
    return transport.subscribe(position);
  }, [pixelsPerFrame, scrollLeft]);

  return (
    <div
      ref={lineRef}
      className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-accent-warm"
      style={{ left: HEADER_WIDTH }}
    >
      <div className="absolute -left-[6.5px] top-0 h-0 w-0 border-x-[7px] border-t-[9px] border-x-transparent border-t-(--color-accent-warm)" />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Clip block
// ---------------------------------------------------------------------------

type DragMode = "move" | "trim-start" | "trim-end";

interface DragState {
  readonly mode: DragMode;
  readonly itemId: TrackItemId;
  readonly originClientX: number;
  readonly originStartFrame: number;
  readonly originDurationFrames: number;
}

const ITEM_COLORS: Record<TrackItem["type"], string> = {
  clip: "bg-[#2d5a9e] border-[#4f8cff]",
  shape: "bg-[#7a4f9e] border-[#b07fe0]",
  text: "bg-[#9e7a2d] border-[#e0b65f]",
};

const ClipBlock = ({
  item,
  track,
  pixelsPerFrame,
  selected,
  onPointerDown,
  onContextMenu,
}: {
  item: TrackItem;
  track: Track;
  pixelsPerFrame: number;
  selected: boolean;
  onPointerDown: (event: ReactPointerEvent, item: TrackItem, mode: DragMode) => void;
  onContextMenu: (event: ReactMouseEvent, item: TrackItem) => void;
}) => {
  const style: CSSProperties = {
    left: item.startFrame * pixelsPerFrame,
    width: Math.max(2, item.durationFrames * pixelsPerFrame),
    height: track.heightPx - 8,
  };

  return (
    <div
      data-clip-id={item.id}
      onPointerDown={(event) => onPointerDown(event, item, "move")}
      onContextMenu={(event) => onContextMenu(event, item)}
      className={`absolute top-1 cursor-grab touch-none overflow-hidden rounded border ${ITEM_COLORS[item.type]} ${
        selected ? "ring-2 ring-white/80" : ""
      } ${item.locked ? "opacity-50" : ""}`}
      style={style}
    >
      <span className="pointer-events-none block truncate px-1.5 pt-0.5 text-[10px] font-medium text-white/90">
        {item.name}
      </span>
      <div
        onPointerDown={(event) => onPointerDown(event, item, "trim-start")}
        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/30"
      />
      <div
        onPointerDown={(event) => onPointerDown(event, item, "trim-end")}
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/30"
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Track header (mute / solo / lock / hide)
// ---------------------------------------------------------------------------

const TrackHeader = ({ track }: { track: Track }) => {
  const toggleTrackFlag = useTimelineStore((state) => state.toggleTrackFlag);
  const armedTrackId = useTimelineStore((state) => state.armedTrackId);
  const armTrack = useTimelineStore((state) => state.armTrack);
  const armed = armedTrackId === track.id;
  const kindBadge = track.kind === "video" ? "V" : track.kind === "audio" ? "A" : "FX";

  return (
    <div
      onClick={() => armTrack(track.id)}
      title="Click to target this track for media inserts"
      className={`flex shrink-0 cursor-pointer items-center gap-1.5 border-b border-edge border-l-2 px-2 ${
        armed ? "border-l-(--color-accent) bg-panel-raised/70" : "border-l-transparent bg-panel"
      }`}
      style={{ height: track.heightPx, width: HEADER_WIDTH }}
    >
      <span className="flex h-5 w-6 items-center justify-center rounded bg-panel-raised text-[10px] font-bold text-neutral-400">
        {kindBadge}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-neutral-300">{track.name}</span>
      <button
        title={track.kind === "audio" ? "Mute" : "Hide"}
        onClick={() => toggleTrackFlag(track.id, track.kind === "audio" ? "muted" : "hidden")}
        className="rounded p-0.5 text-neutral-500 hover:bg-panel-raised hover:text-neutral-200"
      >
        {track.kind === "audio" ? (
          track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />
        ) : track.hidden ? (
          <EyeOff size={13} />
        ) : (
          <Eye size={13} />
        )}
      </button>
      <button
        title="Lock track"
        onClick={() => toggleTrackFlag(track.id, "locked")}
        className="rounded p-0.5 text-neutral-500 hover:bg-panel-raised hover:text-neutral-200"
      >
        {track.locked ? <Lock size={13} /> : <LockOpen size={13} />}
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Marker pin (ruler)
// ---------------------------------------------------------------------------

const MarkerPin = ({
  marker,
  pixelsPerFrame,
  onSeek,
  onRemove,
  onRelabel,
}: {
  marker: Marker;
  pixelsPerFrame: number;
  onSeek: () => void;
  onRemove: () => void;
  onRelabel: (label: string) => void;
}) => (
  <div
    className="absolute top-0 z-10 -translate-x-1/2"
    style={{ left: marker.frame * pixelsPerFrame }}
    onPointerDown={(event) => event.stopPropagation()}
  >
    <button
      title={marker.label || "Marker — click to seek, double-click to rename, right-click to delete"}
      onClick={onSeek}
      onDoubleClick={() => {
        const next = window.prompt("Marker label", marker.label);
        if (next !== null) onRelabel(next);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onRemove();
      }}
      className="block h-0 w-0 border-x-[5px] border-t-[8px] border-x-transparent"
      style={{ borderTopColor: marker.color }}
    />
    {marker.label && (
      <span className="absolute left-1.5 top-0 whitespace-nowrap text-[8px]" style={{ color: marker.color }}>
        {marker.label}
      </span>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export const Timeline = () => {
  const tracks = useTimelineStore((state) => state.project.tracks);
  const frameRate = useTimelineStore((state) => state.project.settings.frameRate);
  const pixelsPerFrame = useTimelineStore((state) => state.pixelsPerFrame);
  const activeTool = useTimelineStore((state) => state.activeTool);
  const selectedItemIds = useTimelineStore((state) => state.selectedItemIds);
  const setActiveTool = useTimelineStore((state) => state.setActiveTool);
  const zoomBy = useTimelineStore((state) => state.zoomBy);
  const moveItem = useTimelineStore((state) => state.moveItem);
  const trimItem = useTimelineStore((state) => state.trimItem);
  const splitItemAtFrame = useTimelineStore((state) => state.splitItemAtFrame);
  const setSelection = useTimelineStore((state) => state.setSelection);
  const removeItems = useTimelineStore((state) => state.removeItems);
  const rippleDelete = useTimelineStore((state) => state.rippleDelete);
  const addTrack = useTimelineStore((state) => state.addTrack);
  const addClipToTrack = useTimelineStore((state) => state.addClipToTrack);
  const addAsset = useTimelineStore((state) => state.addAsset);
  const markers = useTimelineStore((state) => state.project.markers);
  const addMarker = useTimelineStore((state) => state.addMarker);
  const removeMarker = useTimelineStore((state) => state.removeMarker);
  const updateMarker = useTimelineStore((state) => state.updateMarker);

  const displayFrame = useTransportFrame();
  const [isPlaying, setIsPlaying] = useState(false);
  const [snapping, setSnapping] = useState(true);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; item: TrackItem } | null>(null);
  const [dropTrackId, setDropTrackId] = useState<TrackId | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrubbing = useRef(false);

  const durationFrames = useMemo(() => {
    let max = frameRate * 60; // minimum 60s of runway
    for (const track of tracks) {
      for (const item of track.items) {
        max = Math.max(max, item.startFrame + item.durationFrames + frameRate * 5);
      }
    }
    return max;
  }, [tracks, frameRate]);

  const contentWidth = durationFrames * pixelsPerFrame;

  const clientXToFrame = useCallback(
    (clientX: number): number => {
      const scroller = scrollRef.current;
      if (!scroller) return 0;
      const rect = scroller.getBoundingClientRect();
      const x = clientX - rect.left + scroller.scrollLeft;
      return Math.max(0, x / pixelsPerFrame);
    },
    [pixelsPerFrame],
  );

  const maybeSnap = useCallback(
    (frame: number): number => {
      if (!snapping) return Math.round(frame);
      const snapToleranceFrames = 8 / pixelsPerFrame;
      let best = Math.round(frame);
      let bestDistance = snapToleranceFrames;
      const candidates: number[] = [Math.round(transport.getFrame())];
      for (const track of tracks) {
        for (const item of track.items) {
          candidates.push(item.startFrame, item.startFrame + item.durationFrames);
        }
      }
      for (const candidate of candidates) {
        const distance = Math.abs(candidate - frame);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      return best;
    },
    [snapping, pixelsPerFrame, tracks],
  );

  // -- Ruler scrub ----------------------------------------------------------

  const onRulerPointerDown = (event: ReactPointerEvent) => {
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    scrubbing.current = true;
    transport.pause();
    setIsPlaying(false);
    transport.setFrame(Math.round(clientXToFrame(event.clientX)));
  };

  const onRulerPointerMove = (event: ReactPointerEvent) => {
    if (!scrubbing.current) return;
    transport.setFrame(Math.round(clientXToFrame(event.clientX)));
  };

  const onRulerPointerUp = () => {
    scrubbing.current = false;
  };

  // -- Clip drag / trim / razor ----------------------------------------------

  const openMenu = useCallback(
    (event: ReactMouseEvent, item: TrackItem) => {
      event.preventDefault();
      event.stopPropagation();
      const selection = useTimelineStore.getState().selectedItemIds;
      if (!selection.includes(item.id)) setSelection([item.id]);
      setMenu({ x: event.clientX, y: event.clientY, item });
    },
    [setSelection],
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const onClipPointerDown = (event: ReactPointerEvent, item: TrackItem, mode: DragMode) => {
    event.stopPropagation();
    if (event.button === 2) return; // right-click opens the context menu, not a drag
    if (item.locked) return;

    if (activeTool === "razor") {
      splitItemAtFrame(item.id, maybeSnap(clientXToFrame(event.clientX)));
      return;
    }

    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setSelection([item.id]);
    dragRef.current = {
      mode,
      itemId: item.id,
      originClientX: event.clientX,
      originStartFrame: item.startFrame,
      originDurationFrames: item.durationFrames,
    };
  };

  const onLanePointerMove = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaFrames = (event.clientX - drag.originClientX) / pixelsPerFrame;

    if (drag.mode === "move") {
      const targetStart = maybeSnap(drag.originStartFrame + deltaFrames);
      const currentItem = findItem(tracks, drag.itemId);
      if (currentItem) {
        moveItem(drag.itemId, targetStart - currentItem.startFrame);
      }
    } else if (drag.mode === "trim-start") {
      trimItem(drag.itemId, "start", maybeSnap(drag.originStartFrame + deltaFrames));
    } else {
      trimItem(
        drag.itemId,
        "end",
        maybeSnap(drag.originStartFrame + drag.originDurationFrames + deltaFrames),
      );
    }
  };

  const onLanePointerUp = () => {
    dragRef.current = null;
  };

  // -- Drag & drop from the media pool / OS ----------------------------------

  const insertAssetClip = useCallback(
    (asset: MediaAsset, preferredTrack: Track, startFrame: number) => {
      // Audio assets belong on an audio track even if dropped over a video lane.
      const track =
        asset.kind === "audio" && preferredTrack.kind !== "audio"
          ? (tracks.find((t) => t.kind === "audio" && !t.locked) ?? preferredTrack)
          : preferredTrack;
      addClipToTrack(track.id, {
        type: "clip",
        name: asset.name,
        assetId: asset.id,
        startFrame: Math.max(0, Math.round(startFrame)),
        durationFrames: asset.durationFrames,
        sourceInFrame: 0,
        speed: 1,
        audioGainDb: 0,
        audioMuted: false,
        transform: identityTransform(),
        effects: [],
        locked: false,
      });
    },
    [tracks, addClipToTrack],
  );

  const onLaneDragOver = (event: ReactDragEvent, track: Track) => {
    const dt = event.dataTransfer;
    if (track.locked) return;
    if (dt.types.includes(ASSET_DND_MIME) || dt.types.includes("Files")) {
      event.preventDefault();
      dt.dropEffect = "copy";
      if (dropTrackId !== track.id) setDropTrackId(track.id);
    }
  };

  const onLaneDrop = (event: ReactDragEvent, track: Track) => {
    if (track.locked) return;
    const dt = event.dataTransfer;
    const hasAsset = dt.types.includes(ASSET_DND_MIME);
    const hasFiles = dt.types.includes("Files");
    if (!hasAsset && !hasFiles) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTrackId(null);
    // Read the transfer synchronously — it is cleared after any await.
    const startFrame = maybeSnap(clientXToFrame(event.clientX));
    const assetId = hasAsset ? dt.getData(ASSET_DND_MIME) : "";
    const files = hasFiles ? Array.from(dt.files) : [];

    if (assetId) {
      const asset = useTimelineStore.getState().project.assets.find((candidate) => candidate.id === assetId);
      if (asset) insertAssetClip(asset, track, startFrame);
      return;
    }
    void (async () => {
      const created = await ingestFiles(files, frameRate);
      let cursor = startFrame;
      for (const asset of created) {
        addAsset(asset);
        insertAssetClip(asset, track, cursor);
        cursor += asset.durationFrames;
      }
    })();
  };

  // -- Transport / keyboard ---------------------------------------------------

  const togglePlay = useCallback(() => {
    transport.togglePlayback();
    setIsPlaying(transport.isPlaying());
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const store = useTimelineStore.getState();

      // Modifier combos: undo/redo + clipboard. Handled before the plain-key
      // switch so Ctrl+C/V don't collide with the razor/select tool keys.
      if (event.metaKey || event.ctrlKey) {
        switch (event.code) {
          case "KeyZ":
            event.preventDefault();
            if (event.shiftKey) store.redo();
            else store.undo();
            return;
          case "KeyY":
            event.preventDefault();
            store.redo();
            return;
          case "KeyC":
            event.preventDefault();
            store.copySelection();
            return;
          case "KeyX":
            event.preventDefault();
            store.cutSelection();
            return;
          case "KeyV":
            event.preventDefault();
            store.pasteClipboard();
            return;
          case "KeyD":
            event.preventDefault();
            store.duplicateSelection();
            return;
          default:
            return;
        }
      }

      switch (event.code) {
        case "Space":
          event.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          transport.setFrame(Math.max(0, Math.round(transport.getFrame()) - (event.shiftKey ? 10 : 1)));
          break;
        case "ArrowRight":
          transport.setFrame(Math.round(transport.getFrame()) + (event.shiftKey ? 10 : 1));
          break;
        case "Home":
          transport.setFrame(0);
          break;
        case "KeyV":
          store.setActiveTool("select");
          break;
        case "KeyC":
          store.setActiveTool("razor");
          break;
        case "KeyM":
          store.addMarker(transport.getFrame());
          break;
        case "Delete":
        case "Backspace": {
          if (store.selectedItemIds.length > 0) {
            // Shift+Delete ripples (closes the gap); plain Delete leaves it.
            if (event.shiftKey) store.rippleDelete(store.selectedItemIds);
            else store.removeItems(store.selectedItemIds);
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay]);

  // -- Ruler ticks -------------------------------------------------------------

  const tickStep = pickTickStep(pixelsPerFrame);
  const ticks = useMemo(() => {
    const result: { frame: number; label: string }[] = [];
    for (let frame = 0; frame <= durationFrames; frame += tickStep) {
      result.push({ frame, label: framesToTimecode(frame, frameRate) });
    }
    return result;
  }, [durationFrames, tickStep, frameRate]);

  return (
    <div className="flex h-full flex-col bg-panel-deep">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge bg-panel px-2">
        <button
          title="Select (V)"
          onClick={() => setActiveTool("select")}
          className={`rounded p-1.5 ${activeTool === "select" ? "bg-accent/25 text-accent" : "text-neutral-400 hover:bg-panel-raised"}`}
        >
          <MousePointer2 size={14} />
        </button>
        <button
          title="Razor / Split (C)"
          onClick={() => setActiveTool("razor")}
          className={`rounded p-1.5 ${activeTool === "razor" ? "bg-accent/25 text-accent" : "text-neutral-400 hover:bg-panel-raised"}`}
        >
          <Scissors size={14} />
        </button>
        <button
          title="Toggle snapping"
          onClick={() => setSnapping((s) => !s)}
          className={`rounded p-1.5 ${snapping ? "bg-accent/25 text-accent" : "text-neutral-400 hover:bg-panel-raised"}`}
        >
          <Magnet size={14} />
        </button>
        <button
          title="Add marker at playhead (M)"
          onClick={() => addMarker(transport.getFrame())}
          className="rounded p-1.5 text-neutral-400 hover:bg-panel-raised"
        >
          <Bookmark size={14} />
        </button>

        <div className="mx-2 h-5 w-px bg-edge" />

        <button
          title="Add video track"
          onClick={() => addTrack("video")}
          className="flex items-center gap-1 rounded p-1.5 text-neutral-400 hover:bg-panel-raised"
        >
          <Layers size={14} />
          <span className="text-[10px] font-semibold">V+</span>
        </button>
        <button
          title="Add audio track"
          onClick={() => addTrack("audio")}
          className="flex items-center gap-1 rounded p-1.5 text-neutral-400 hover:bg-panel-raised"
        >
          <Layers size={14} />
          <span className="text-[10px] font-semibold">A+</span>
        </button>

        <div className="mx-2 h-5 w-px bg-edge" />

        <button title="Go to start" onClick={() => transport.setFrame(0)} className="rounded p-1.5 text-neutral-400 hover:bg-panel-raised">
          <SkipBack size={14} />
        </button>
        <button title="Play/Pause (Space)" onClick={togglePlay} className="rounded p-1.5 text-neutral-200 hover:bg-panel-raised">
          {isPlaying ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button
          title="Step forward"
          onClick={() => transport.setFrame(Math.round(transport.getFrame()) + 1)}
          className="rounded p-1.5 text-neutral-400 hover:bg-panel-raised"
        >
          <SkipForward size={14} />
        </button>

        <span className="ml-2 rounded bg-panel-raised px-2 py-0.5 font-mono text-xs text-accent">
          {framesToTimecode(displayFrame, frameRate)}
        </span>
        <span className="ml-1 font-mono text-[10px] text-neutral-500">{frameRate} fps</span>

        <div className="flex-1" />

        {selectedItemIds.length > 0 && (
          <>
            <button
              onClick={() => rippleDelete(selectedItemIds)}
              title="Ripple delete — remove and close the gap (Shift+Del)"
              className="rounded px-2 py-0.5 text-[11px] text-amber-400 hover:bg-panel-raised"
            >
              Ripple
            </button>
            <button
              onClick={() => removeItems(selectedItemIds)}
              className="mr-2 rounded px-2 py-0.5 text-[11px] text-red-400 hover:bg-panel-raised"
            >
              Delete {selectedItemIds.length} item{selectedItemIds.length > 1 ? "s" : ""}
            </button>
          </>
        )}

        <button title="Zoom out" onClick={() => zoomBy(1 / 1.4)} className="rounded p-1.5 text-neutral-400 hover:bg-panel-raised">
          <ZoomOut size={14} />
        </button>
        <span className="w-16 text-center font-mono text-[10px] text-neutral-500">
          {pixelsPerFrame.toFixed(2)} px/f
        </span>
        <button title="Zoom in" onClick={() => zoomBy(1.4)} className="rounded p-1.5 text-neutral-400 hover:bg-panel-raised">
          <ZoomIn size={14} />
        </button>
      </div>

      {/* Tracks area */}
      <div className="relative flex min-h-0 flex-1">
        <Playhead pixelsPerFrame={pixelsPerFrame} scrollLeft={scrollLeft} />

        {/* Track headers */}
        <div className="z-10 shrink-0 border-r border-edge" style={{ width: HEADER_WIDTH }}>
          <div className="border-b border-edge bg-panel" style={{ height: RULER_HEIGHT }} />
          {tracks.map((track) => (
            <TrackHeader key={track.id} track={track} />
          ))}
        </div>

        {/* Scrollable lanes */}
        <div
          ref={scrollRef}
          onScroll={(event) => setScrollLeft((event.target as HTMLDivElement).scrollLeft)}
          className="min-w-0 flex-1 overflow-x-auto overflow-y-auto"
          onPointerDown={() => setSelection([])}
        >
          <div style={{ width: contentWidth, minWidth: "100%" }}>
            {/* Ruler */}
            <div
              className={`relative border-b border-edge bg-panel ${activeTool === "razor" ? "cursor-crosshair" : "cursor-ew-resize"}`}
              style={{ height: RULER_HEIGHT }}
              onPointerDown={onRulerPointerDown}
              onPointerMove={onRulerPointerMove}
              onPointerUp={onRulerPointerUp}
            >
              {ticks.map((tick) => (
                <div key={tick.frame} className="absolute top-0 h-full" style={{ left: tick.frame * pixelsPerFrame }}>
                  <div className="h-2 w-px bg-neutral-600" />
                  <span className="absolute left-1 top-2 font-mono text-[9px] text-neutral-500">{tick.label}</span>
                </div>
              ))}
              {markers.map((marker) => (
                <MarkerPin
                  key={marker.id}
                  marker={marker}
                  pixelsPerFrame={pixelsPerFrame}
                  onSeek={() => transport.setFrame(marker.frame)}
                  onRemove={() => removeMarker(marker.id)}
                  onRelabel={(label) => updateMarker(marker.id, { label })}
                />
              ))}
            </div>

            {/* Lanes */}
            <div className="relative" onPointerMove={onLanePointerMove} onPointerUp={onLanePointerUp}>
              {/* Marker guide lines spanning all lanes */}
              {markers.map((marker) => (
                <div
                  key={marker.id}
                  className="pointer-events-none absolute top-0 bottom-0 z-20 w-px"
                  style={{ left: marker.frame * pixelsPerFrame, background: marker.color, opacity: 0.5 }}
                />
              ))}
              {tracks.map((track) => (
                <div
                  key={track.id}
                  onDragOver={(event) => onLaneDragOver(event, track)}
                  onDragLeave={() => setDropTrackId((current) => (current === track.id ? null : current))}
                  onDrop={(event) => onLaneDrop(event, track)}
                  className={`relative border-b border-edge/60 bg-panel-deep odd:bg-[#13151a] ${
                    dropTrackId === track.id ? "bg-accent/10 outline outline-1 -outline-offset-1 outline-accent/70" : ""
                  }`}
                  style={{ height: track.heightPx }}
                >
                  {track.items.map((item) => (
                    <ClipBlock
                      key={item.id}
                      item={item}
                      track={track}
                      pixelsPerFrame={pixelsPerFrame}
                      selected={selectedItemIds.includes(item.id)}
                      onPointerDown={onClipPointerDown}
                      onContextMenu={openMenu}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-[168px] rounded border border-edge bg-panel py-1 text-xs shadow-xl shadow-black/50"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {[
            {
              label: "Split at playhead",
              run: () => splitItemAtFrame(menu.item.id, Math.round(transport.getFrame())),
            },
            {
              label: "Duplicate",
              run: () => {
                setSelection([menu.item.id]);
                useTimelineStore.getState().duplicateSelection();
              },
            },
            {
              label: "Copy",
              run: () => {
                setSelection([menu.item.id]);
                useTimelineStore.getState().copySelection();
              },
            },
            {
              label: "Cut",
              run: () => {
                setSelection([menu.item.id]);
                useTimelineStore.getState().cutSelection();
              },
            },
            { label: "Delete", run: () => removeItems([menu.item.id]) },
            { label: "Ripple delete", run: () => rippleDelete([menu.item.id]) },
          ].map((entry) => (
            <button
              key={entry.label}
              onClick={() => {
                entry.run();
                setMenu(null);
              }}
              className="block w-full px-3 py-1.5 text-left text-neutral-300 hover:bg-panel-raised"
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const findItem = (tracks: readonly Track[], itemId: TrackItemId): TrackItem | undefined => {
  for (const track of tracks) {
    const found = track.items.find((item) => item.id === itemId);
    if (found) return found;
  }
  return undefined;
};
