/**
 * WebCut — pro-tier workspace layout.
 *
 *  ┌──────────────┬───────────────────────────────┬──────────────┐
 *  │  Media Pool  │     WebGPU Program Monitor    │  Inspector   │
 *  ├──────────────┴───────────────────────────────┴──────────────┤
 *  │                     Multi-track Timeline                    │
 *  └──────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  Captions,
  Circle,
  Clapperboard,
  Download,
  FileAudio,
  FileVideo,
  FolderOpen,
  Image as ImageIcon,
  Import,
  Keyboard,
  LayoutDashboard,
  LayoutTemplate,
  LayoutGrid,
  List,
  Music,
  Plus,
  Save,
  SlidersHorizontal,
  Sparkles,
  Square,
  Target,
  Type,
} from "lucide-react";
import { VideoPlayer } from "./VideoPlayer";
import { Timeline } from "./Timeline";
import { fileSystemService, isUserAbort } from "../services/FileSystemService";
import {
  ASSET_DND_MIME,
  classifyMedia,
  getThumbnail,
  ingestFiles,
  isMediaFile,
  probeMedia,
} from "../services/mediaImport";
import { projectStore, type ProjectSummary } from "../services/projectStore";
import { SOUND_LIBRARY, soundToFile } from "../services/sounds";
import { parseCaptions, toSrt } from "../services/subtitles";
import { transport, useTimelineStore } from "../store/timelineStore";
import {
  ASPECT_PRESETS,
  createId,
  BLEND_MODES,
  createEmptyProject,
  defaultCorridorKeyParams,
  framesToTimecode,
  GRADIENT_PRESETS,
  identityGrade,
  identityTransform,
  makeShapeItem,
  makeStickerItem,
  makeTextItem,
  sampleAnimatable,
  staticValue,
  identityCurves,
  identityEllipseMask,
  identityHsl,
  identityRectMask,
  isIdentityCurves,
  type CurvePoint,
  type GradeCurves,
  type GradePreset,
  type HslQualifier,
  type BezierHandles,
  type BlendMode,
  type ClipItem,
  type ColorGrade,
  type CorridorKeyParams,
  type Effect,
  type EffectId,
  type GradientFill,
  type InterpolationMode,
  type KeyframeId,
  type MediaAsset,
  type MediaAssetId,
  type MediaKind,
  type AnimatableValue,
  type MaskShape,
  type ShapeItem,
  type SubtitleId,
  type TextItem,
  type Track,
  type TrackItem,
  type TrackItemId,
  type TransitionKind,
  type Transform,
  type Vec2,
} from "../types/timeline";
import type { TransformProp } from "../store/timelineStore";
import { chordFromEvent, COMMANDS, prettyChord, resetBindings, setBinding, useKeymap, type CommandId } from "../store/keymap";
import { evalCurve, parseCubeLut, registerLut } from "../effects/lut";
import { projectEndFrame, type ExportFormat } from "../services/ExportService";
import { segmentsToSubtitleFrames, transcribeProject } from "../services/transcription";
import {
  applyTemplate,
  BUILT_IN_TEMPLATES,
  loadTemplates,
  saveTemplates,
  templateFromOverlays,
  type MotionGraphicsTemplate,
  type TemplateValues,
} from "../services/templates";
import { getUseProxies, proxyService, setUseProxies, subscribeUseProxies, type ProxyJob } from "../services/ProxyService";
import { trackPoint, type TrackSample } from "../services/motionTrack";
import { analyzeStabilization } from "../services/stabilize";
import { EXPORT_PRESETS, type ExportPreset } from "../services/ExportPresets";
import { exportQueue, type ExportJob } from "../services/ExportQueue";
import { getWaveform } from "../services/waveform";
import {
  computeDuckingKeyframes,
  decodeAudio,
  defaultDuckOptions,
  gainToTargetLufs,
  LUFS_TARGETS,
  measureLoudness,
} from "../services/loudness";

/** Signature of the store's generic item updater, shared by Inspector sections. */
type UpdateItemFn = (itemId: TrackItemId, updater: (item: TrackItem) => TrackItem, coalesceKey?: string) => void;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Curated font stacks offered in the text Inspector (all locally available). */
const FONT_OPTIONS: readonly string[] = [
  "Inter, system-ui, sans-serif",
  "Arial, Helvetica, sans-serif",
  "Georgia, serif",
  "'Times New Roman', Times, serif",
  "'Courier New', monospace",
  "Verdana, Geneva, sans-serif",
  "'Trebuchet MS', sans-serif",
  "Impact, Haettenschweiler, sans-serif",
  "'Comic Sans MS', cursive",
  "Tahoma, Geneva, sans-serif",
];

const fontLabel = (stack: string): string => stack.split(",")[0].replace(/['"]/g, "").trim();

/** Emoji sticker set offered in the Media Pool. */
const STICKERS: readonly string[] = [
  "😀", "😂", "😍", "😎", "🤔", "😭", "🔥", "✨", "⭐", "❤️",
  "👍", "👎", "👏", "🙌", "💯", "🎉", "🎈", "🎁", "💡", "⚡",
  "✅", "❌", "❓", "❗", "➡️", "⬅️", "⬆️", "⬇️", "📌", "🏆",
  "🇺🇸", "🇬🇧", "🇪🇺", "🇯🇵", "🇧🇷", "🇮🇳", "🌍", "☀️", "🌙", "☁️",
];

// ---------------------------------------------------------------------------
// Media pool
// ---------------------------------------------------------------------------

const MEDIA_ICONS: Record<MediaKind, typeof FileVideo> = {
  video: FileVideo,
  audio: FileAudio,
  image: ImageIcon,
  sequence: LayoutTemplate,
};

const InsertButton = ({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    title={`Add ${label} at playhead`}
    className="flex flex-col items-center gap-0.5 rounded border border-edge bg-panel-raised px-1 py-1.5 text-[9px] text-neutral-300 hover:border-accent/60"
  >
    {icon}
    {label}
  </button>
);

// ---------------------------------------------------------------------------
// Media pool (left panel)
// ---------------------------------------------------------------------------

/** Async, cached poster thumbnail for a media asset. */
const useThumbnail = (asset: MediaAsset): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    void getThumbnail(asset).then((next) => {
      if (alive) setUrl(next);
    });
    return () => {
      alive = false;
    };
  }, [asset]);
  return url;
};

const startAssetDrag = (event: React.DragEvent, assetId: MediaAssetId) => {
  event.dataTransfer.setData(ASSET_DND_MIME, assetId);
  event.dataTransfer.effectAllowed = "copy";
};

/** Grid tile: draggable poster + metadata. Drag to timeline, double-click to add. */
const AssetCard = ({ asset, onAdd }: { asset: MediaAsset; onAdd: () => void }) => {
  const thumb = useThumbnail(asset);
  const Icon = MEDIA_ICONS[asset.kind];
  return (
    <div
      draggable
      onDragStart={(event) => startAssetDrag(event, asset.id)}
      onDoubleClick={onAdd}
      title={`${asset.name} — drag to timeline or double-click to add`}
      className="group relative cursor-grab overflow-hidden rounded border border-edge bg-panel-raised/60 hover:border-accent/60"
    >
      <div className="flex aspect-video items-center justify-center bg-black/40">
        {thumb ? (
          <img src={thumb} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <Icon size={20} className="text-accent" />
        )}
      </div>
      <div className="px-1.5 py-1">
        <p className="truncate text-[10px] text-neutral-200">{asset.name}</p>
        <p className="font-mono text-[8px] text-neutral-500">
          {(asset.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
          {asset.width ? ` · ${asset.width}×${asset.height}` : ""}
        </p>
      </div>
      <button
        title="Add to timeline"
        onClick={onAdd}
        className="absolute right-1 top-1 rounded bg-black/60 p-1 text-neutral-300 opacity-0 hover:text-accent group-hover:opacity-100"
      >
        <Plus size={12} />
      </button>
    </div>
  );
};

/** List row: compact draggable entry. */
const AssetRow = ({ asset, onAdd }: { asset: MediaAsset; onAdd: () => void }) => {
  const Icon = MEDIA_ICONS[asset.kind];
  return (
    <div
      draggable
      onDragStart={(event) => startAssetDrag(event, asset.id)}
      onDoubleClick={onAdd}
      className="group mb-1 flex cursor-grab items-center gap-2 rounded border border-transparent bg-panel-raised/60 px-2 py-1.5 hover:border-edge"
    >
      <Icon size={14} className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] text-neutral-200">{asset.name}</p>
        <p className="font-mono text-[9px] text-neutral-500">
          {(asset.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
          {asset.width ? ` · ${asset.width}×${asset.height}` : ""}
        </p>
      </div>
      <button
        title="Add to timeline"
        onClick={onAdd}
        className="rounded p-1 text-neutral-500 opacity-0 hover:bg-panel hover:text-accent group-hover:opacity-100"
      >
        <Plus size={13} />
      </button>
    </div>
  );
};

const MediaPool = () => {
  const assets = useTimelineStore((state) => state.project.assets);
  const tracks = useTimelineStore((state) => state.project.tracks);
  const frameRate = useTimelineStore((state) => state.project.settings.frameRate);
  const addAsset = useTimelineStore((state) => state.addAsset);
  const addClipToTrack = useTimelineStore((state) => state.addClipToTrack);
  const addItemToTrack = useTimelineStore((state) => state.addItemToTrack);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grid, setGrid] = useState(true);
  const [dropActive, setDropActive] = useState(false);

  const importFileList = useCallback(
    async (files: readonly File[]) => {
      const media = files.filter(isMediaFile);
      if (media.length === 0) return;
      setError(null);
      try {
        const created = await ingestFiles(media, frameRate, {
          onProxyReady: (assetId, proxy) => {
            useTimelineStore.getState().updateAsset(assetId, {
              proxyHandleKey: proxy.handleKey,
              proxyWidth: proxy.width,
              proxyHeight: proxy.height,
            });
          },
        });
        for (const asset of created) addAsset(asset);
      } catch (dropError) {
        setError(dropError instanceof Error ? dropError.message : String(dropError));
      }
    },
    [addAsset, frameRate],
  );

  const insertOverlay = useCallback(
    (factory: (start: number, duration: number) => Omit<TrackItem, "id">) => {
      const armedId = useTimelineStore.getState().armedTrackId;
      const armed = tracks.find((t) => t.id === armedId && t.kind === "video" && !t.locked);
      const track = armed ?? tracks.find((t) => t.kind === "video" && !t.locked);
      if (!track) return;
      const start = Math.round(transport.getFrame());
      const duration = Math.max(1, Math.round(3 * frameRate));
      addItemToTrack(track.id, factory(start, duration));
    },
    [tracks, frameRate, addItemToTrack],
  );

  const handleImport = useCallback(async () => {
    setImporting(true);
    setError(null);
    try {
      const imported = await fileSystemService.importMediaFiles();
      for (const { handleKey, file } of imported) {
        const kind = classifyMedia(file.type || "", file.name);
        const probed = await probeMedia(file, kind);
        addAsset({
          id: createId<MediaAssetId>(),
          kind,
          name: file.name,
          handleKey,
          durationFrames: Math.max(1, Math.round(probed.duration * frameRate)),
          width: probed.width || undefined,
          height: probed.height || undefined,
          frameRate: undefined,
          mimeType: file.type || "application/octet-stream",
          fileSizeBytes: file.size,
        });
      }
    } catch (importError) {
      if (!isUserAbort(importError)) {
        setError(importError instanceof Error ? importError.message : String(importError));
      }
    } finally {
      setImporting(false);
    }
  }, [addAsset, frameRate]);

  const armedTrackId = useTimelineStore((state) => state.armedTrackId);

  const handleAddToTimeline = useCallback(
    (asset: MediaAsset) => {
      const preferredKind = asset.kind === "audio" ? "audio" : "video";
      const armed = tracks.find((t) => t.id === armedTrackId && t.kind === preferredKind && !t.locked);
      const track = armed ?? tracks.find((t) => t.kind === preferredKind && !t.locked) ?? tracks[0];
      if (!track) return;
      // Armed track: insert at the playhead (stacking workflow for keying).
      // Untargeted: append after the last clip on the track.
      const playheadEnd = armed
        ? Math.round(transport.getFrame())
        : track.items.reduce((max, item) => Math.max(max, item.startFrame + item.durationFrames), 0);
      const clip: Omit<Extract<TrackItem, { type: "clip" }>, "id"> = {
        type: "clip",
        name: asset.name,
        assetId: asset.id,
        startFrame: playheadEnd,
        durationFrames: asset.durationFrames,
        sourceInFrame: 0,
        speed: 1,
        audioGainDb: 0,
        audioMuted: false,
        transform: identityTransform(),
        effects: [],
        locked: false,
      };
      addClipToTrack(track.id, clip);
    },
    [tracks, addClipToTrack, armedTrackId],
  );

  return (
    <div className="flex h-full flex-col">
      <PanelTitle icon={<FolderOpen size={13} />} title="Media Pool" />
      <div className="p-2">
        <button
          onClick={handleImport}
          disabled={importing}
          className="flex w-full items-center justify-center gap-2 rounded border border-edge bg-panel-raised px-3 py-1.5 text-xs text-neutral-200 hover:border-accent/60 disabled:opacity-50"
        >
          <Import size={13} />
          {importing ? "Importing…" : "Import Media"}
        </button>
        {error && <p className="mt-2 text-[10px] leading-snug text-red-400">{error}</p>}
        <div className="mt-2 grid grid-cols-3 gap-1">
          <InsertButton icon={<Type size={12} />} label="Text" onClick={() => insertOverlay(makeTextItem)} />
          <InsertButton
            icon={<Square size={12} />}
            label="Rect"
            onClick={() => insertOverlay((s, d) => makeShapeItem("rectangle", s, d))}
          />
          <InsertButton
            icon={<Circle size={12} />}
            label="Ellipse"
            onClick={() => insertOverlay((s, d) => makeShapeItem("ellipse", s, d))}
          />
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer list-none text-[10px] text-neutral-400 hover:text-neutral-200">
            😀 Stickers
          </summary>
          <div className="mt-1 grid grid-cols-8 gap-0.5">
            {STICKERS.map((emoji) => (
              <button
                key={emoji}
                title={`Add ${emoji}`}
                onClick={() => insertOverlay((s, d) => makeStickerItem(emoji, s, d))}
                className="rounded p-0.5 text-base hover:bg-panel-raised"
              >
                {emoji}
              </button>
            ))}
          </div>
        </details>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-wide text-neutral-600">
            {assets.length} item{assets.length === 1 ? "" : "s"}
          </span>
          <div className="flex gap-0.5">
            <button
              title="Grid view"
              onClick={() => setGrid(true)}
              className={`rounded p-1 ${grid ? "bg-accent/25 text-accent" : "text-neutral-500 hover:bg-panel-raised"}`}
            >
              <LayoutGrid size={12} />
            </button>
            <button
              title="List view"
              onClick={() => setGrid(false)}
              className={`rounded p-1 ${!grid ? "bg-accent/25 text-accent" : "text-neutral-500 hover:bg-panel-raised"}`}
            >
              <List size={12} />
            </button>
          </div>
        </div>
      </div>
      <div
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDropActive(true);
          }
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          setDropActive(false);
          void importFileList(Array.from(event.dataTransfer.files));
        }}
        className={`min-h-0 flex-1 overflow-y-auto px-2 pb-2 ${
          dropActive ? "bg-accent/5 ring-1 ring-inset ring-accent/40" : ""
        }`}
      >
        {assets.length === 0 && (
          <p className="px-1 pt-4 text-center text-[11px] leading-relaxed text-neutral-600">
            No media yet. Import, paste, or drop files here — nothing is uploaded.
          </p>
        )}
        {grid ? (
          <div className="grid grid-cols-2 gap-1.5">
            {assets.map((asset) => (
              <AssetCard key={asset.id} asset={asset} onAdd={() => handleAddToTimeline(asset)} />
            ))}
          </div>
        ) : (
          assets.map((asset) => <AssetRow key={asset.id} asset={asset} onAdd={() => handleAddToTimeline(asset)} />)
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Inspector (right panel)
// ---------------------------------------------------------------------------

const SliderRow = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) => (
  <label className="mb-2 block">
    <span className="mb-1 flex justify-between text-[10px] text-neutral-400">
      {label}
      <span className="font-mono text-neutral-500">{value.toFixed(2)}</span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="h-1 w-full cursor-pointer appearance-none rounded bg-panel-raised accent-(--color-accent)"
    />
  </label>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="mb-4">
    <p className="mb-2 text-[11px] font-semibold tracking-wide text-neutral-400">{title.toUpperCase()}</p>
    <div className="rounded border border-edge bg-panel/40 p-2.5">{children}</div>
  </div>
);

const NumberField = ({
  label,
  value,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (value: number) => void;
}) => (
  <label className="block">
    <span className="mb-0.5 block text-[9px] uppercase tracking-wide text-neutral-500">{label}</span>
    <input
      type="number"
      value={Number.isFinite(value) ? round2(value) : 0}
      step={step}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
      className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200 outline-none focus:border-accent/60"
    />
  </label>
);

const ColorInput = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => (
  <label className="flex items-center gap-1.5 text-[10px] text-neutral-400">
    {label}
    <input
      type="color"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-6 w-8 cursor-pointer rounded border border-edge bg-transparent"
    />
  </label>
);

/** ◆ toggle: animate a property on/off, at the current playhead. */
const KeyToggle = ({ animated, onClick }: { animated: boolean; onClick: () => void }) => (
  <button
    title={animated ? "Property is animated — click to remove keyframes" : "Add keyframe at playhead"}
    onClick={onClick}
    className={`ml-1 rounded px-1 text-[10px] leading-none ${animated ? "text-accent-warm" : "text-neutral-600 hover:text-neutral-300"}`}
  >
    {animated ? "◆" : "◇"}
  </button>
);

const TransformSection = ({ item, updateItem }: { item: TrackItem; updateItem: UpdateItemFn }) => {
  const addKeyframe = useTimelineStore((s) => s.addTransformKeyframe);
  const clearKeyframes = useTimelineStore((s) => s.clearTransformKeyframes);
  const local = Math.max(0, Math.round(transport.getFrame()) - item.startFrame);
  const pos = sampleAnimatable(item.transform.position, local);
  const scale = sampleAnimatable(item.transform.scale, local);
  const rotation = sampleAnimatable(item.transform.rotation, local);
  const opacity = sampleAnimatable(item.transform.opacity, local);

  const setTransform = (patch: Partial<Transform>) =>
    updateItem(item.id, (it) => ({ ...it, transform: { ...it.transform, ...patch } }) as TrackItem, "transform");

  // Upsert a keyframe at the playhead when animated; otherwise set the static value.
  const setVec = (prop: "position" | "scale", next: Vec2) => {
    const av = item.transform[prop];
    if (av.kind === "static") return setTransform({ [prop]: staticValue(next) } as Partial<Transform>);
    const keyframes = [
      ...av.keyframes.filter((k) => k.frame !== local),
      { id: createId<KeyframeId>(), frame: local, value: next, interpolation: "linear" as const },
    ].sort((a, b) => a.frame - b.frame);
    setTransform({ [prop]: { kind: "animated", keyframes } } as Partial<Transform>);
  };
  const setNum = (prop: "rotation" | "opacity", next: number) => {
    const av = item.transform[prop];
    if (av.kind === "static") return setTransform({ [prop]: staticValue(next) } as Partial<Transform>);
    const keyframes = [
      ...av.keyframes.filter((k) => k.frame !== local),
      { id: createId<KeyframeId>(), frame: local, value: next, interpolation: "linear" as const },
    ].sort((a, b) => a.frame - b.frame);
    setTransform({ [prop]: { kind: "animated", keyframes } } as Partial<Transform>);
  };

  const toggle = (prop: TransformProp) => {
    if (item.transform[prop].kind === "animated") clearKeyframes(item.id, prop, local);
    else addKeyframe(item.id, prop, local);
  };
  const animated = (prop: TransformProp) => item.transform[prop].kind === "animated";

  return (
    <Section title="Transform">
      <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wide text-neutral-500">
        <span>Position</span>
        <KeyToggle animated={animated("position")} onClick={() => toggle("position")} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="X" value={pos.x} onChange={(x) => setVec("position", { x, y: pos.y })} />
        <NumberField label="Y" value={pos.y} onChange={(y) => setVec("position", { x: pos.x, y })} />
      </div>
      <div className="mb-1 mt-2 flex items-center justify-between text-[9px] uppercase tracking-wide text-neutral-500">
        <span>Scale</span>
        <KeyToggle animated={animated("scale")} onClick={() => toggle("scale")} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="X" value={scale.x} step={0.01} onChange={(x) => setVec("scale", { x, y: scale.y })} />
        <NumberField label="Y" value={scale.y} step={0.01} onChange={(y) => setVec("scale", { x: scale.x, y })} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1">
          <NumberField label="Rotation°" value={rotation} onChange={(r) => setNum("rotation", r)} />
        </div>
        <KeyToggle animated={animated("rotation")} onClick={() => toggle("rotation")} />
      </div>
      <div className="mt-1 flex items-center gap-1">
        <div className="flex-1">
          <SliderRow label="Opacity" value={opacity} min={0} max={1} step={0.01} onChange={(o) => setNum("opacity", o)} />
        </div>
        <KeyToggle animated={animated("opacity")} onClick={() => toggle("opacity")} />
      </div>
      <KeyframeGraph item={item} updateItem={updateItem} />
    </Section>
  );
};

const DEFAULT_BEZIER: BezierHandles = { out: [0.42, 0], in: [0.58, 1] };

/** Compact draggable cubic-bezier easing editor for a keyframe. */
const BezierEditor = ({ bezier, onChange }: { bezier: BezierHandles; onChange: (b: BezierHandles) => void }) => {
  const [drag, setDrag] = useState<null | "out" | "in">(null);
  const size = 96;
  const p1 = { cx: bezier.out[0] * size, cy: (1 - bezier.out[1]) * size };
  const p2 = { cx: bezier.in[0] * size, cy: (1 - bezier.in[1]) * size };
  const onMove = (event: React.PointerEvent) => {
    if (!drag) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / size));
    const y = Math.min(1.5, Math.max(-0.5, 1 - (event.clientY - rect.top) / size));
    onChange(drag === "out" ? { ...bezier, out: [x, y] } : { ...bezier, in: [x, y] });
  };
  return (
    <svg
      width={size}
      height={size}
      className="mt-1 rounded bg-panel-deep"
      onPointerMove={onMove}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
    >
      <line x1={0} y1={size} x2={p1.cx} y2={p1.cy} stroke="#555" />
      <line x1={size} y1={0} x2={p2.cx} y2={p2.cy} stroke="#555" />
      <path
        d={`M0,${size} C${p1.cx},${p1.cy} ${p2.cx},${p2.cy} ${size},0`}
        stroke="var(--color-accent)"
        fill="none"
        strokeWidth={1.5}
      />
      <circle cx={p1.cx} cy={p1.cy} r={5} fill="var(--color-accent)" className="cursor-grab" onPointerDown={() => setDrag("out")} />
      <circle cx={p2.cx} cy={p2.cy} r={5} fill="var(--color-accent-warm)" className="cursor-grab" onPointerDown={() => setDrag("in")} />
    </svg>
  );
};

const KeyframeGraph = ({ item }: { item: TrackItem; updateItem: UpdateItemFn }) => {
  const updateKf = useTimelineStore((s) => s.updateTransformKeyframe);
  const removeKf = useTimelineStore((s) => s.removeTransformKeyframe);
  const props: TransformProp[] = ["position", "scale", "rotation", "opacity"];
  const animated = props.filter((p) => item.transform[p].kind === "animated");
  if (animated.length === 0) return null;
  return (
    <div className="mt-3 rounded border border-edge bg-panel/40 p-2">
      <p className="mb-1 text-[9px] uppercase tracking-wide text-neutral-500">Keyframes</p>
      {animated.map((prop) => {
        const av = item.transform[prop];
        if (av.kind !== "animated") return null;
        const bezierKf = av.keyframes.find((k) => k.interpolation === "bezier");
        return (
          <div key={prop} className="mb-2">
            <p className="text-[10px] capitalize text-neutral-400">{prop}</p>
            {av.keyframes.map((k) => (
              <div key={k.id} className="mt-1 flex items-center gap-1 text-[10px]">
                <span className="w-9 font-mono text-neutral-500">f{k.frame}</span>
                <select
                  value={k.interpolation}
                  onChange={(event) => {
                    const mode = event.target.value as InterpolationMode;
                    updateKf(item.id, prop, k.id, {
                      interpolation: mode,
                      bezier: mode === "bezier" ? (k.bezier ?? DEFAULT_BEZIER) : undefined,
                    });
                  }}
                  className="rounded border border-edge bg-panel-raised px-1 py-0.5 text-[10px] text-neutral-200"
                >
                  <option value="linear">Linear</option>
                  <option value="bezier">Bezier</option>
                  <option value="hold">Hold</option>
                </select>
                <button onClick={() => removeKf(item.id, prop, k.id)} className="text-neutral-600 hover:text-red-400">
                  ✕
                </button>
              </div>
            ))}
            {bezierKf && bezierKf.bezier && (
              <BezierEditor
                bezier={bezierKf.bezier}
                onChange={(bez) => updateKf(item.id, prop, bezierKf.id, { bezier: bez })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

const cssGradient = (g: GradientFill): string => {
  const stops = g.stops.map((s) => `${s.color} ${Math.round(s.at * 100)}%`).join(", ");
  return g.kind === "radial" ? `radial-gradient(circle, ${stops})` : `linear-gradient(${g.angle}deg, ${stops})`;
};

const GradientRow = ({
  gradient,
  onChange,
}: {
  gradient: GradientFill | undefined;
  onChange: (g: GradientFill | undefined) => void;
}) => (
  <div className="mt-2">
    <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wide text-neutral-500">
      <span>Gradient fill</span>
      {gradient && (
        <button onClick={() => onChange(undefined)} className="text-neutral-500 hover:text-neutral-300">
          clear
        </button>
      )}
    </div>
    <div className="flex flex-wrap gap-1">
      {GRADIENT_PRESETS.map((p) => (
        <button
          key={p.label}
          title={p.label}
          onClick={() => onChange(p.fill)}
          className="h-5 w-8 rounded border border-edge"
          style={{ background: cssGradient(p.fill) }}
        />
      ))}
    </div>
  </div>
);

const BlendSection = ({ item, updateItem }: { item: TrackItem; updateItem: UpdateItemFn }) => (
  <Section title="Compositing">
    <label className="block">
      <span className="mb-0.5 block text-[9px] uppercase tracking-wide text-neutral-500">Blend mode</span>
      <select
        value={item.blendMode ?? "normal"}
        onChange={(event) =>
          updateItem(item.id, (it) => ({ ...it, blendMode: event.target.value as BlendMode }) as TrackItem, "blend")
        }
        className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] capitalize text-neutral-200"
      >
        {BLEND_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </select>
    </label>
  </Section>
);

const TextSection = ({ item, updateItem }: { item: TrackItem; updateItem: UpdateItemFn }) => {
  if (item.type !== "text") return null;
  const set = (patch: Partial<TextItem>) =>
    updateItem(item.id, (it) => (it.type === "text" ? { ...it, ...patch } : it), "text");
  return (
    <Section title="Text">
      <textarea
        value={item.text}
        rows={2}
        onChange={(event) => set({ text: event.target.value })}
        className="mb-2 w-full resize-none rounded border border-edge bg-panel-raised px-2 py-1 text-[11px] text-neutral-200 outline-none focus:border-accent/60"
      />
      <label className="mb-2 block">
        <span className="mb-0.5 block text-[9px] uppercase tracking-wide text-neutral-500">Font</span>
        <select
          value={item.fontFamily}
          onChange={(event) => set({ fontFamily: event.target.value })}
          style={{ fontFamily: item.fontFamily }}
          className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200"
        >
          {!FONT_OPTIONS.includes(item.fontFamily) && (
            <option value={item.fontFamily}>{fontLabel(item.fontFamily)}</option>
          )}
          {FONT_OPTIONS.map((stack) => (
            <option key={stack} value={stack} style={{ fontFamily: stack }}>
              {fontLabel(stack)}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Size" value={item.fontSizePx} onChange={(v) => set({ fontSizePx: Math.max(1, v) })} />
        <label className="block">
          <span className="mb-0.5 block text-[9px] uppercase tracking-wide text-neutral-500">Weight</span>
          <select
            value={item.fontWeight}
            onChange={(event) => set({ fontWeight: Number(event.target.value) })}
            className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200"
          >
            <option value={400}>Regular</option>
            <option value={600}>Semibold</option>
            <option value={700}>Bold</option>
            <option value={900}>Black</option>
          </select>
        </label>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <ColorInput label="Fill" value={item.fillColor} onChange={(v) => set({ fillColor: v })} />
        <div className="flex gap-1">
          {(["left", "center", "right"] as const).map((align) => (
            <button
              key={align}
              onClick={() => set({ alignment: align })}
              className={`rounded px-2 py-1 text-[10px] ${
                item.alignment === align ? "bg-accent/25 text-accent" : "text-neutral-400 hover:bg-panel-raised"
              }`}
            >
              {align[0].toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <GradientRow gradient={item.fillGradient} onChange={(g) => set({ fillGradient: g })} />
    </Section>
  );
};

const ShapeSection = ({ item, updateItem }: { item: TrackItem; updateItem: UpdateItemFn }) => {
  if (item.type !== "shape") return null;
  const set = (patch: Partial<ShapeItem>) =>
    updateItem(item.id, (it) => (it.type === "shape" ? { ...it, ...patch } : it), "shape");
  return (
    <Section title="Shape">
      <div className="flex items-center justify-between">
        <ColorInput label="Fill" value={item.fillColor} onChange={(v) => set({ fillColor: v })} />
        <ColorInput label="Stroke" value={item.strokeColor} onChange={(v) => set({ strokeColor: v })} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <NumberField label="Stroke px" value={item.strokeWidthPx} onChange={(v) => set({ strokeWidthPx: Math.max(0, v) })} />
        <NumberField
          label="Corner px"
          value={item.cornerRadiusPx}
          onChange={(v) => set({ cornerRadiusPx: Math.max(0, v) })}
        />
      </div>
      <GradientRow gradient={item.fillGradient} onChange={(g) => set({ fillGradient: g })} />
    </Section>
  );
};

const ClipSection = ({ item, updateItem }: { item: TrackItem; updateItem: UpdateItemFn }) => {
  if (item.type !== "clip") return null;
  const setSpeed = (speed: number) =>
    updateItem(
      item.id,
      (it) => {
        if (it.type !== "clip") return it;
        const target = Math.abs(speed) < 0.1 ? 0.1 : speed;
        // Preserve the source range: sourceFrames = timelineDuration × |speed|.
        const sourceFrames = it.durationFrames * Math.abs(it.speed || 1);
        return { ...it, speed: target, durationFrames: Math.max(1, Math.round(sourceFrames / Math.abs(target))) };
      },
      "speed",
    );
  const setAudio = (patch: Partial<Pick<ClipItem, "audioGainDb" | "audioMuted">>) =>
    updateItem(item.id, (it) => (it.type === "clip" ? { ...it, ...patch } : it), "audio");
  return (
    <Section title="Clip">
      <SliderRow label="Speed ×" value={item.speed} min={0.25} max={4} step={0.05} onChange={setSpeed} />
      <SliderRow
        label="Volume (dB)"
        value={item.audioGainDb}
        min={-30}
        max={6}
        step={0.5}
        onChange={(v) => setAudio({ audioGainDb: v })}
      />
      <label className="flex items-center gap-2 pt-1 text-[10px] text-neutral-400">
        <input
          type="checkbox"
          checked={item.audioMuted}
          onChange={(event) => setAudio({ audioMuted: event.target.checked })}
          className="accent-(--color-accent)"
        />
        Mute clip audio
      </label>
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Effects panel (#12): add / reorder / enable / tune stackable effects
// ---------------------------------------------------------------------------

const EFFECT_LABELS: Record<Effect["type"], string> = {
  "corridor-key": "Corridor key",
  "brightness-contrast": "Brightness / Contrast",
  "gaussian-blur": "Gaussian blur",
  "sharpen": "Sharpen",
};

const makeEffect = (type: Effect["type"]): Effect => {
  const id = createId<EffectId>();
  if (type === "brightness-contrast") {
    return { id, type, enabled: true, params: { brightness: staticValue(0), contrast: staticValue(1) } };
  }
  if (type === "gaussian-blur") {
    return { id, type, enabled: true, params: { radiusPx: staticValue(2) } };
  }
  if (type === "sharpen") {
    return { id, type, enabled: true, params: { amount: staticValue(0.5) } };
  }
  return { id, type: "corridor-key", enabled: true, params: defaultCorridorKeyParams() };
};

const EffectsSection = ({ item }: { item: TrackItem }) => {
  const updateItemEffects = useTimelineStore((s) => s.updateItemEffects);
  if (item.type !== "clip") return null;
  const effects = item.effects;

  const add = (type: Effect["type"]) => {
    updateItemEffects(item.id, [...effects, makeEffect(type)]);
  };
  const patchEffect = (idx: number, patch: (e: Effect) => Effect) => {
    updateItemEffects(item.id, effects.map((e, i) => (i === idx ? patch(e) : e)));
  };
  const removeAt = (idx: number) => {
    updateItemEffects(item.id, effects.filter((_, i) => i !== idx));
  };
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= effects.length) return;
    const next = [...effects];
    [next[idx], next[j]] = [next[j], next[idx]];
    updateItemEffects(item.id, next);
  };

  const numOf = (av: AnimatableValue<number>): number => (av.kind === "static" ? av.value : av.keyframes[0]?.value ?? 0);
  const setNumParam = (idx: number, key: string, value: number) => {
    patchEffect(idx, (e) => {
      const eAny = e as unknown as { params: Record<string, AnimatableValue<number>> };
      return { ...e, params: { ...eAny.params, [key]: staticValue(value) } } as Effect;
    });
  };

  return (
    <Section title="Effects">
      {effects.length === 0 && (
        <p className="mb-1 text-[10px] text-neutral-600">No effects. Add one below.</p>
      )}
      {effects.map((e, idx) => (
        <div key={e.id} className="mb-1.5 rounded border border-edge bg-panel/40 p-1.5">
          <div className="mb-1 flex items-center gap-1">
            <input
              type="checkbox"
              checked={e.enabled}
              onChange={(ev) => patchEffect(idx, (x) => ({ ...x, enabled: ev.target.checked }) as Effect)}
              className="accent-(--color-accent)"
            />
            <span className="flex-1 truncate text-[10px] text-neutral-300">{EFFECT_LABELS[e.type]}</span>
            <button onClick={() => move(idx, -1)} disabled={idx === 0} className="rounded border border-edge px-1 text-[9px] text-neutral-500 hover:border-accent/60 disabled:opacity-30">↑</button>
            <button onClick={() => move(idx, +1)} disabled={idx === effects.length - 1} className="rounded border border-edge px-1 text-[9px] text-neutral-500 hover:border-accent/60 disabled:opacity-30">↓</button>
            <button onClick={() => removeAt(idx)} className="rounded border border-edge px-1 text-[9px] text-neutral-500 hover:border-red-500/60">✕</button>
          </div>
          {e.type === "brightness-contrast" && (
            <>
              <SliderRow label="Brightness" value={numOf(e.params.brightness)} min={-0.5} max={0.5} step={0.01} onChange={(v) => setNumParam(idx, "brightness", v)} />
              <SliderRow label="Contrast" value={numOf(e.params.contrast)} min={0} max={3} step={0.01} onChange={(v) => setNumParam(idx, "contrast", v)} />
            </>
          )}
          {e.type === "gaussian-blur" && (
            <SliderRow label="Radius (px)" value={numOf(e.params.radiusPx)} min={0} max={16} step={0.5} onChange={(v) => setNumParam(idx, "radiusPx", v)} />
          )}
          {e.type === "sharpen" && (
            <SliderRow label="Amount" value={numOf(e.params.amount)} min={0} max={3} step={0.05} onChange={(v) => setNumParam(idx, "amount", v)} />
          )}
          {e.type === "corridor-key" && (
            <p className="text-[9px] text-neutral-600">Tune the matte in the CorridorKey section below.</p>
          )}
        </div>
      ))}
      <select
        value=""
        onChange={(ev) => { if (ev.target.value) { add(ev.target.value as Effect["type"]); ev.target.value = ""; } }}
        className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[10px] text-neutral-300"
      >
        <option value="">Add effect…</option>
        <option value="brightness-contrast">Brightness / Contrast</option>
        <option value="gaussian-blur">Gaussian blur</option>
        <option value="sharpen">Sharpen</option>
      </select>
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Shape mask (#13)
// ---------------------------------------------------------------------------

const MaskSection = ({ item }: { item: TrackItem }) => {
  const setClipMask = useTimelineStore((s) => s.setClipMask);
  if (item.type !== "clip") return null;
  const clip = item;
  const mask = clip.mask ?? null;

  const setKind = (kind: MaskShape | null) => {
    if (kind === null) return setClipMask(clip.id, null);
    if (kind === "polygon") {
      // Sensible starter polygon: a diamond in the center.
      setClipMask(clip.id, {
        shape: "polygon",
        points: [
          { x: 0.5, y: 0.15 }, { x: 0.85, y: 0.5 }, { x: 0.5, y: 0.85 }, { x: 0.15, y: 0.5 },
        ],
        inverted: mask?.inverted ?? false,
        feather: mask?.feather ?? 0.02,
      });
      return;
    }
    setClipMask(clip.id, kind === "rect" ? identityRectMask() : identityEllipseMask());
  };

  return (
    <Section title="Shape mask">
      <div className="mb-1.5 flex flex-wrap gap-1">
        {(["rect", "ellipse", "polygon"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded px-1.5 py-0.5 text-[9px] capitalize ${mask?.shape === k ? "bg-accent/30 text-accent" : "border border-edge text-neutral-400 hover:border-accent/60"}`}
          >
            {k}
          </button>
        ))}
        {mask && (
          <button
            onClick={() => setKind(null)}
            className="ml-auto rounded border border-edge px-1.5 py-0.5 text-[9px] text-neutral-500 hover:border-red-500/60"
          >
            Remove
          </button>
        )}
      </div>
      {mask && (
        <>
          <label className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
            <input
              type="checkbox"
              checked={mask.inverted}
              onChange={(e) => setClipMask(clip.id, { ...mask, inverted: e.target.checked })}
              className="accent-(--color-accent)"
            />
            Invert (keep OUTSIDE the shape)
          </label>
          <SliderRow
            label="Feather"
            value={mask.feather}
            min={0}
            max={0.2}
            step={0.005}
            onChange={(v) => setClipMask(clip.id, { ...mask, feather: Math.max(0, Math.min(0.2, v)) })}
          />
          {mask.shape !== "polygon" && (
            <p className="mt-1 text-[9px] text-neutral-600">
              Corners: ({mask.points[0].x.toFixed(2)}, {mask.points[0].y.toFixed(2)}) → ({mask.points[1].x.toFixed(2)}, {mask.points[1].y.toFixed(2)}).
              Drag on the preview to reshape (coming with the on-canvas gizmo).
            </p>
          )}
          {mask.shape === "polygon" && (
            <p className="mt-1 text-[9px] text-neutral-600">
              {mask.points.length} vertices. Max 16 in this MVP; click on the preview to add/move.
            </p>
          )}
        </>
      )}
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Transitions (#6): crossfade / dissolve / wipe applied at a clip's edge
// ---------------------------------------------------------------------------

const TRANSITION_KINDS: readonly TransitionKind[] = ["fade", "wipe-left", "wipe-right", "wipe-up", "wipe-down"];

const TransitionSection = ({ item }: { item: TrackItem }) => {
  const setClipTransition = useTimelineStore((s) => s.setClipTransition);
  const fps = useTimelineStore((s) => s.project.settings.frameRate);
  if (item.type !== "clip") return null;
  const clip = item;

  const renderEdge = (edge: "in" | "out") => {
    const t = edge === "in" ? clip.transitionIn : clip.transitionOut;
    return (
      <div className="mb-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] text-neutral-400">{edge === "in" ? "In edge" : "Out edge"}</span>
          {t && (
            <button onClick={() => setClipTransition(clip.id, edge, null)} className="rounded border border-edge px-1.5 py-0.5 text-[9px] text-neutral-500 hover:border-red-500/60">
              Remove
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {TRANSITION_KINDS.map((k) => {
            const active = t?.kind === k;
            return (
              <button
                key={k}
                onClick={() => setClipTransition(clip.id, edge, { kind: k, frames: t?.frames ?? Math.round(fps * 0.5) })}
                className={`rounded px-1.5 py-0.5 text-[9px] ${active ? "bg-accent/30 text-accent" : "border border-edge text-neutral-400 hover:border-accent/60"}`}
              >
                {k === "fade" ? "Fade" : k.replace("wipe-", "▶ ").replace("left", "L").replace("right", "R").replace("up", "U").replace("down", "D")}
              </button>
            );
          })}
        </div>
        {t && (
          <SliderRow
            label="Duration (frames)"
            value={t.frames}
            min={1}
            max={Math.max(1, Math.round(fps * 3))}
            step={1}
            onChange={(v) => setClipTransition(clip.id, edge, { ...t, frames: Math.max(1, Math.round(v)) })}
          />
        )}
      </div>
    );
  };

  return (
    <Section title="Transitions">
      <p className="mb-1.5 text-[9px] leading-tight text-neutral-600">
        Applied where this clip overlaps a neighbor on the same track. Fade cross-mixes both clips;
        wipes reveal this clip across the frame.
      </p>
      {renderEdge("in")}
      {renderEdge("out")}
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Retime: speed ramp (#52) + freeze frame (#55)
// ---------------------------------------------------------------------------

const SpeedSection = ({ item }: { item: TrackItem }) => {
  const setSpeedRampPoint = useTimelineStore((s) => s.setSpeedRampPoint);
  const clearSpeedRamp = useTimelineStore((s) => s.clearSpeedRamp);
  const freezeFrame = useTimelineStore((s) => s.freezeFrame);
  const fps = useTimelineStore((s) => s.project.settings.frameRate);
  if (item.type !== "clip") return null;
  const clip = item;
  const rampOn = !!clip.speedRamp && clip.speedRamp.kind === "animated";
  const localPlayhead = Math.round(transport.getFrame()) - clip.startFrame;
  const withinClip = localPlayhead >= 0 && localPlayhead < clip.durationFrames;

  return (
    <Section title="Retime">
      <div className="flex items-center justify-between text-[10px] text-neutral-400">
        <span>Speed ramp {rampOn ? "· on" : "· off"}</span>
        {rampOn && (
          <button onClick={() => clearSpeedRamp(clip.id)} className="rounded border border-edge px-1.5 py-0.5 text-[9px] hover:border-red-500/60">
            Clear
          </button>
        )}
      </div>
      <p className="mb-1 text-[9px] leading-tight text-neutral-600">
        Sets a speed keyframe at the playhead — build a ramp by adding several.
      </p>
      <div className="flex flex-wrap gap-1">
        {[0.25, 0.5, 1, 2, 4].map((sp) => (
          <button
            key={sp}
            disabled={!withinClip}
            onClick={() => setSpeedRampPoint(clip.id, localPlayhead, sp)}
            className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-neutral-300 hover:border-accent/60 disabled:opacity-40"
          >
            {sp}×
          </button>
        ))}
      </div>
      <button
        disabled={!withinClip}
        onClick={() => freezeFrame(clip.id, Math.round(transport.getFrame()), fps)}
        className="mt-1.5 w-full rounded border border-edge px-2 py-0.5 text-[10px] text-neutral-300 hover:border-accent/60 disabled:opacity-40"
      >
        Freeze frame here (1s hold)
      </button>
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Warp stabilizer (#61): analyze camera motion + bake residual keyframes.
// ---------------------------------------------------------------------------

const StabilizeSection = ({ item }: { item: TrackItem }) => {
  const project = useTimelineStore((s) => s.project);
  const updateItem = useTimelineStore((s) => s.updateItem);
  const [smoothSigma, setSmoothSigma] = useState(20);
  const [cropToFit, setCropToFit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  if (item.type !== "clip") return null;
  const clip = item;
  const asset = project.assets.find((a) => a.id === clip.assetId);
  if (!asset || asset.kind === "audio" || !asset.width || !asset.height) return null;

  const run = async () => {
    setBusy(true);
    setMessage(null);
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await analyzeStabilization(
        asset,
        clip.sourceInFrame,
        clip.durationFrames,
        project.settings.frameRate,
        (p) => setProgress(Math.round((p.frame / p.totalFrames) * 100)),
        controller.signal,
        { smoothSigma, cropToFit },
      );
      // Map source-pixel residuals → project-pixel offsets on the clip's
      // transform (compositor uses canvas-center-relative pixels).
      const scaleX = project.settings.width / asset.width!;
      const scaleY = project.settings.height / asset.height!;
      const positionKfs = result.residuals.map((r) => ({
        id: createId<KeyframeId>(),
        frame: r.frame,
        value: { x: r.dx * scaleX, y: r.dy * scaleY },
        interpolation: "linear" as const,
      }));
      const scaleKf = {
        id: createId<KeyframeId>(),
        frame: 0,
        value: { x: result.recommendedCropScale, y: result.recommendedCropScale },
        interpolation: "hold" as const,
      };
      updateItem(
        clip.id,
        (it) => ({
          ...it,
          transform: {
            ...it.transform,
            position: { kind: "animated", keyframes: positionKfs },
            ...(cropToFit && result.recommendedCropScale > 1
              ? { scale: { kind: "animated", keyframes: [scaleKf] } }
              : {}),
          },
        }) as unknown as TrackItem,
        "stabilize",
      );
      setMessage(`Stabilized. Max residual ${result.maxDx.toFixed(0)}×${result.maxDy.toFixed(0)} px, crop ×${result.recommendedCropScale.toFixed(3)}.`);
    } catch (err) {
      if ((err as DOMException).name === "AbortError") setMessage("Cancelled.");
      else setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <Section title="Stabilize (warp)">
      <p className="mb-1.5 text-[9px] leading-tight text-neutral-600">
        Tracks a grid of points across the clip and bakes the residual camera motion into position
        keyframes. Uses translation only in this MVP; add crop-to-fit to hide edge exposure.
      </p>
      <SliderRow
        label="Smoothness (σ frames)"
        value={smoothSigma}
        min={5}
        max={60}
        step={1}
        onChange={(v) => setSmoothSigma(Math.max(1, Math.round(v)))}
      />
      <label className="mb-2 flex items-center gap-2 text-[10px] text-neutral-400">
        <input
          type="checkbox"
          checked={cropToFit}
          onChange={(e) => setCropToFit(e.target.checked)}
          className="accent-(--color-accent)"
        />
        Crop to fit (auto-scale up)
      </label>
      {busy && (
        <div className="mb-2">
          <div className="mb-0.5 flex justify-between text-[10px] text-neutral-500">
            <span>Analyzing</span>
            <span className="font-mono">{progress}%</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded bg-panel-raised">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      {message && <p className="mb-1.5 text-[10px] text-neutral-500">{message}</p>}
      {!busy ? (
        <button
          onClick={run}
          className="w-full rounded border border-edge px-2 py-0.5 text-[10px] text-neutral-300 hover:border-accent/60"
        >
          Stabilize
        </button>
      ) : (
        <button
          onClick={() => abortRef.current?.abort()}
          className="w-full rounded border border-red-500/50 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10"
        >
          Cancel
        </button>
      )}
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Multicam (#49): drop a set of angles onto a clip; hard-cut between them.
// ---------------------------------------------------------------------------

const MulticamSection = ({ item }: { item: TrackItem }) => {
  const assets = useTimelineStore((s) => s.project.assets);
  const setClipMulticam = useTimelineStore((s) => s.setClipMulticam);
  const setMulticamAngleAt = useTimelineStore((s) => s.setMulticamAngleAt);
  if (item.type !== "clip") return null;
  const clip = item;
  const videoAssets = assets.filter((a) => a.kind === "video" || a.kind === "image");
  const enabled = !!clip.multicam;

  const enable = () => {
    // Seed with the current clip's asset as the sole angle.
    setClipMulticam(clip.id, {
      angles: [clip.assetId],
      angleSelection: staticValue(0),
    });
  };
  const disable = () => setClipMulticam(clip.id, null);

  const toggleAngle = (assetId: import("../types/timeline").MediaAssetId) => {
    if (!clip.multicam) return;
    const current = clip.multicam.angles;
    const idx = current.indexOf(assetId);
    const next = idx >= 0 ? current.filter((a) => a !== assetId) : [...current, assetId];
    if (next.length === 0) { disable(); return; }
    setClipMulticam(clip.id, { angles: next, angleSelection: clip.multicam.angleSelection });
  };

  const cutTo = (angleIdx: number) => {
    if (!clip.multicam) return;
    const localFrame = Math.max(0, Math.min(clip.durationFrames - 1, Math.round(transport.getFrame()) - clip.startFrame));
    setMulticamAngleAt(clip.id, localFrame, angleIdx);
  };

  return (
    <Section title="Multicam">
      {!enabled && (
        <button onClick={enable} className="w-full rounded border border-edge px-2 py-0.5 text-[10px] text-neutral-300 hover:border-accent/60">
          Enable multicam
        </button>
      )}
      {enabled && clip.multicam && (
        <>
          <p className="mb-1 text-[9px] text-neutral-600">
            Pick angles below, then press 1..N (or click Cut) at the playhead to insert a
            hard-cut keyframe. Angles must already be aligned on the timeline (drag to sync).
          </p>
          <div className="mb-1.5 max-h-32 space-y-0.5 overflow-y-auto pr-1">
            {videoAssets.map((a) => {
              const selected = clip.multicam!.angles.includes(a.id);
              const idx = clip.multicam!.angles.indexOf(a.id);
              return (
                <label key={a.id} className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] ${selected ? "bg-accent/10 text-neutral-200" : "text-neutral-400 hover:bg-panel-raised"}`}>
                  <input type="checkbox" checked={selected} onChange={() => toggleAngle(a.id)} className="accent-(--color-accent)" />
                  <span className="w-4 text-center font-mono text-[9px] text-neutral-500">{selected ? idx + 1 : "—"}</span>
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                </label>
              );
            })}
          </div>
          <div className="mb-1 flex flex-wrap gap-1">
            {clip.multicam.angles.map((_, idx) => (
              <button
                key={idx}
                onClick={() => cutTo(idx)}
                className="rounded border border-edge px-1.5 py-0.5 font-mono text-[10px] text-neutral-300 hover:border-accent/60"
                title={`Cut to angle ${idx + 1} at playhead`}
              >
                Cut → {idx + 1}
              </button>
            ))}
          </div>
          <button onClick={disable} className="w-full rounded border border-edge px-2 py-0.5 text-[10px] text-neutral-400 hover:border-red-500/60">
            Disable multicam
          </button>
        </>
      )}
    </Section>
  );
};

/** RGB triple of sliders for one lift/gamma/gain wheel channel. */
const GradeTriple = ({
  label,
  value,
  min,
  max,
  center,
  onChange,
}: {
  label: string;
  value: readonly [number, number, number];
  min: number;
  max: number;
  center: number;
  onChange: (next: [number, number, number]) => void;
}) => {
  const channels: ReadonlyArray<{ i: number; tint: string }> = [
    { i: 0, tint: "accent-red-400" },
    { i: 1, tint: "accent-emerald-400" },
    { i: 2, tint: "accent-blue-400" },
  ];
  return (
    <div className="mb-1.5">
      <div className="mb-0.5 flex justify-between text-[9px] uppercase tracking-wide text-neutral-500">
        <span>{label}</span>
        <span className="font-mono text-neutral-600">
          {value.map((v) => v.toFixed(2)).join(" ")}
        </span>
      </div>
      {channels.map(({ i, tint }) => (
        <input
          key={i}
          type="range"
          min={min}
          max={max}
          step={0.01}
          value={value[i]}
          onDoubleClick={() => {
            const next: [number, number, number] = [...value] as [number, number, number];
            next[i] = center;
            onChange(next);
          }}
          onChange={(event) => {
            const next: [number, number, number] = [...value] as [number, number, number];
            next[i] = Number(event.target.value);
            onChange(next);
          }}
          className={`mb-0.5 h-1 w-full cursor-pointer appearance-none rounded bg-panel-raised ${tint}`}
        />
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Tone-curve editor (#42) — draggable control points on an SVG grid
// ---------------------------------------------------------------------------

const CURVE_CHANNELS = [
  { key: "master" as const, label: "RGB", stroke: "#e5e5e5" },
  { key: "red" as const, label: "R", stroke: "#f87171" },
  { key: "green" as const, label: "G", stroke: "#4ade80" },
  { key: "blue" as const, label: "B", stroke: "#60a5fa" },
];

const CurveEditor = ({
  curves,
  onChange,
}: {
  curves: GradeCurves;
  onChange: (next: GradeCurves) => void;
}) => {
  const [channel, setChannel] = useState<keyof GradeCurves>("master");
  const svgRef = useRef<SVGSVGElement>(null);
  const dragIndex = useRef<number | null>(null);
  const points = curves[channel];
  const meta = CURVE_CHANNELS.find((c) => c.key === channel)!;

  const toLocal = (e: React.PointerEvent): CurvePoint => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  };

  const commit = (pts: CurvePoint[]) => {
    const sorted = [...pts].sort((a, b) => a[0] - b[0]);
    onChange({ ...curves, [channel]: sorted });
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const [x, y] = toLocal(e);
    // Grab the nearest point within a small radius, else insert a new one.
    let nearest = -1;
    let best = 0.05;
    points.forEach((p, i) => {
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < best) { best = d; nearest = i; }
    });
    if (e.shiftKey && nearest > 0 && nearest < points.length - 1) {
      commit(points.filter((_, i) => i !== nearest));
      return;
    }
    if (nearest === -1) {
      const next = [...points, [x, y] as CurvePoint];
      dragIndex.current = next.length - 1;
      commit(next);
    } else {
      dragIndex.current = nearest;
    }
  };

  const onMove = (e: React.PointerEvent) => {
    if (dragIndex.current === null) return;
    const [x, y] = toLocal(e);
    const i = dragIndex.current;
    const isEndpoint = i === 0 || i === points.length - 1;
    const next = points.map((p, idx) =>
      idx === i ? ([isEndpoint ? p[0] : x, y] as CurvePoint) : p,
    );
    commit(next);
    // Re-track index after re-sort by matching the y we set (endpoints keep x).
    dragIndex.current = next
      .map((p, idx) => ({ p, idx }))
      .sort((a, b) => a.p[0] - b.p[0])
      .findIndex(({ idx }) => idx === i);
  };

  const onUp = () => { dragIndex.current = null; };

  // Sample the curve into a polyline for display.
  const path = Array.from({ length: 33 }, (_, k) => {
    const x = k / 32;
    const y = evalCurve(points, x);
    return `${x * 100},${(1 - y) * 100}`;
  }).join(" ");

  return (
    <div className="mt-1 border-t border-edge/60 pt-1.5">
      <div className="mb-1 flex items-center gap-1">
        {CURVE_CHANNELS.map((c) => (
          <button
            key={c.key}
            onClick={() => setChannel(c.key)}
            className={`rounded px-1.5 py-0.5 text-[9px] font-mono ${channel === c.key ? "bg-accent/30 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
          >
            {c.label}
          </button>
        ))}
        <span className="ml-auto text-[8px] text-neutral-600">drag · shift-click removes</span>
      </div>
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-24 w-full cursor-crosshair touch-none rounded border border-edge bg-black/40"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <line x1="0" y1="100" x2="100" y2="0" stroke="#333" strokeWidth="0.5" />
        <polyline points={path} fill="none" stroke={meta.stroke} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <circle key={i} cx={p[0] * 100} cy={(1 - p[1]) * 100} r="2" fill={meta.stroke} stroke="#000" strokeWidth="0.4" />
        ))}
      </svg>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Grade presets (persisted to localStorage) + HSL secondary
// ---------------------------------------------------------------------------

const PRESET_KEY = "webcut.gradePresets.v1";

const loadGradePresets = (): GradePreset[] => {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    return raw ? (JSON.parse(raw) as GradePreset[]) : [];
  } catch {
    return [];
  }
};

const saveGradePresets = (presets: GradePreset[]): void => {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  } catch {
    /* storage unavailable */
  }
};

const ColorSection = ({ item, updateItem }: { item: TrackItem; updateItem: UpdateItemFn }) => {
  const copyGrade = useTimelineStore((s) => s.copyGrade);
  const pasteGrade = useTimelineStore((s) => s.pasteGradeToSelection);
  const applyGrade = useTimelineStore((s) => s.applyGradeToSelection);
  const [presets, setPresets] = useState<GradePreset[]>(() => (typeof localStorage !== "undefined" ? loadGradePresets() : []));
  if (item.type !== "clip") return null;
  const grade: ColorGrade = item.grade ?? identityGrade();
  const setGrade = (patch: Partial<ColorGrade>) =>
    updateItem(item.id, (it) => (it.type === "clip" ? { ...it, grade: { ...grade, ...patch } } : it), "grade");
  const hsl: HslQualifier = grade.hsl ?? identityHsl();
  const setHsl = (patch: Partial<HslQualifier>) => setGrade({ hsl: { ...hsl, ...patch } });

  const onImportLut = async (file: File) => {
    try {
      const text = await file.text();
      const lut = parseCubeLut(text);
      const id = registerLut(file.name, lut);
      setGrade({ lut3dId: id, lut3dName: file.name });
    } catch (err) {
      console.error("[WebCut] LUT import failed:", err);
      alert(`Could not import LUT: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const savePreset = () => {
    const name = prompt("Preset name:");
    if (!name) return;
    const next = [...presets, { id: createId(), name, grade }];
    setPresets(next);
    saveGradePresets(next);
  };

  return (
    <Section title="Color">
      <GradeTriple label="Lift (shadows)" value={grade.lift} min={-0.5} max={0.5} center={0} onChange={(lift) => setGrade({ lift })} />
      <GradeTriple label="Gamma (mids)" value={grade.gamma} min={0.2} max={2.5} center={1} onChange={(gamma) => setGrade({ gamma })} />
      <GradeTriple label="Gain (highlights)" value={grade.gain} min={0} max={2.5} center={1} onChange={(gain) => setGrade({ gain })} />
      <div className="mt-1 border-t border-edge/60 pt-1">
        <SliderRow label="Brightness" value={grade.brightness} min={-0.5} max={0.5} step={0.01} onChange={(v) => setGrade({ brightness: v })} />
        <SliderRow label="Contrast" value={grade.contrast} min={0} max={2} step={0.01} onChange={(v) => setGrade({ contrast: v })} />
        <SliderRow label="Saturation" value={grade.saturation} min={0} max={2} step={0.01} onChange={(v) => setGrade({ saturation: v })} />
        <SliderRow label="Temperature" value={grade.temperature} min={-0.3} max={0.3} step={0.005} onChange={(v) => setGrade({ temperature: v })} />
        <SliderRow label="Tint" value={grade.tint} min={-0.3} max={0.3} step={0.005} onChange={(v) => setGrade({ tint: v })} />
      </div>

      {/* Tone curves (#42) */}
      <CurveEditor
        curves={grade.curves ?? identityCurves()}
        onChange={(curves) => setGrade({ curves: isIdentityCurves(curves) ? undefined : curves })}
      />

      {/* HSL secondary qualifier (#43) */}
      <details className="mt-1.5 border-t border-edge/60 pt-1">
        <summary className="cursor-pointer text-[9px] uppercase tracking-wide text-neutral-500">HSL secondary</summary>
        <div className="pt-1">
          <SliderRow label="Center hue °" value={hsl.centerHue} min={0} max={360} step={1} onChange={(v) => setHsl({ centerHue: v })} />
          <SliderRow label="Range °" value={hsl.hueWidth} min={2} max={120} step={1} onChange={(v) => setHsl({ hueWidth: v })} />
          <SliderRow label="Softness °" value={hsl.softness} min={0} max={60} step={1} onChange={(v) => setHsl({ softness: v })} />
          <SliderRow label="Hue shift °" value={hsl.hueShift} min={-180} max={180} step={1} onChange={(v) => setHsl({ hueShift: v })} />
          <SliderRow label="Saturation ×" value={hsl.satScale} min={0} max={2} step={0.02} onChange={(v) => setHsl({ satScale: v })} />
          <SliderRow label="Lightness ×" value={hsl.lumScale} min={0} max={2} step={0.02} onChange={(v) => setHsl({ lumScale: v })} />
        </div>
      </details>

      {/* 3D LUT (#44) */}
      <div className="mt-1.5 flex items-center gap-1 border-t border-edge/60 pt-1.5">
        <label className="flex-1 cursor-pointer rounded border border-edge px-2 py-0.5 text-center text-[10px] text-neutral-300 hover:border-accent/60">
          {grade.lut3dName ? `LUT: ${grade.lut3dName}` : "Import .cube LUT"}
          <input
            type="file"
            accept=".cube"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportLut(f);
              e.target.value = "";
            }}
          />
        </label>
        {grade.lut3dId && (
          <button
            onClick={() => setGrade({ lut3dId: undefined, lut3dName: undefined })}
            className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-red-500/60"
          >
            ✕
          </button>
        )}
      </div>

      {/* Presets + copy/paste (#46) */}
      <div className="mt-1.5 flex flex-wrap gap-1 border-t border-edge/60 pt-1.5">
        <button onClick={() => copyGrade(item.id)} className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-neutral-300 hover:border-accent/60">Copy</button>
        <button onClick={() => pasteGrade()} className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-neutral-300 hover:border-accent/60">Paste</button>
        <button onClick={savePreset} className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-neutral-300 hover:border-accent/60">Save preset</button>
        <select
          value=""
          onChange={(e) => {
            const p = presets.find((x) => x.id === e.target.value);
            if (p) applyGrade(p.grade);
          }}
          className="min-w-0 flex-1 rounded border border-edge bg-panel-raised px-1 py-0.5 text-[10px] text-neutral-300"
        >
          <option value="">Apply preset…</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <button
        onClick={() => updateItem(item.id, (it) => (it.type === "clip" ? { ...it, grade: undefined } : it), "grade")}
        className="mt-1 w-full rounded border border-edge px-2 py-0.5 text-[10px] text-neutral-400 hover:border-accent/60"
      >
        Reset grade
      </button>
    </Section>
  );
};

const ProjectSettingsSection = () => {
  const settings = useTimelineStore((state) => state.project.settings);
  const setProjectSettings = useTimelineStore((state) => state.setProjectSettings);
  const current = `${settings.width}x${settings.height}`;
  const isPreset = ASPECT_PRESETS.some((preset) => `${preset.width}x${preset.height}` === current);
  return (
    <div className="pt-2">
      <p className="mb-2 text-[11px] font-semibold tracking-wide text-neutral-400">PROJECT</p>
      <div className="rounded border border-edge bg-panel/40 p-2.5">
        <label className="mb-2 block">
          <span className="mb-1 block text-[10px] text-neutral-400">Aspect / resolution</span>
          <select
            value={current}
            onChange={(event) => {
              const preset = ASPECT_PRESETS.find((x) => `${x.width}x${x.height}` === event.target.value);
              if (preset) setProjectSettings({ width: preset.width, height: preset.height });
            }}
            className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200"
          >
            {!isPreset && (
              <option value={current}>
                Custom · {settings.width}×{settings.height}
              </option>
            )}
            {ASPECT_PRESETS.map((preset) => (
              <option key={preset.label} value={`${preset.width}x${preset.height}`}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Width"
            value={settings.width}
            onChange={(v) => setProjectSettings({ width: Math.max(16, Math.round(v)) })}
          />
          <NumberField
            label="Height"
            value={settings.height}
            onChange={(v) => setProjectSettings({ height: Math.max(16, Math.round(v)) })}
          />
        </div>
        <label className="mt-2 flex items-center justify-between text-[10px] text-neutral-400">
          Background
          <input
            type="color"
            value={settings.backgroundColor}
            onChange={(event) => setProjectSettings({ backgroundColor: event.target.value, backgroundGradient: undefined })}
            className="h-6 w-8 cursor-pointer rounded border border-edge bg-transparent"
          />
        </label>
        <GradientRow
          gradient={settings.backgroundGradient}
          onChange={(g) => setProjectSettings({ backgroundGradient: g })}
        />
        <p className="mt-3 text-center text-[10px] leading-relaxed text-neutral-600">
          Select a clip, text, or shape on the timeline to edit its properties.
        </p>
      </div>
    </div>
  );
};

const Inspector = () => {
  const selectedItemIds = useTimelineStore((state) => state.selectedItemIds);
  const tracks = useTimelineStore((state) => state.project.tracks);
  const updateItemEffects = useTimelineStore((state) => state.updateItemEffects);
  const updateItem = useTimelineStore((state) => state.updateItem);

  const selectedItem = useMemo(() => {
    if (selectedItemIds.length !== 1) return undefined;
    for (const track of tracks) {
      const found = track.items.find((item) => item.id === selectedItemIds[0]);
      if (found) return found;
    }
    return undefined;
  }, [selectedItemIds, tracks]);

  const corridorKey = selectedItem?.effects.find(
    (effect): effect is Extract<Effect, { type: "corridor-key" }> => effect.type === "corridor-key",
  );

  const applyKeyParams = useCallback(
    (params: Partial<CorridorKeyParams>) => {
      if (!selectedItem) return;
      const existing = selectedItem.effects.find((e) => e.type === "corridor-key");
      const nextEffects: Effect[] = existing
        ? selectedItem.effects.map((effect) =>
            effect.type === "corridor-key" ? { ...effect, params: { ...effect.params, ...params } } : effect,
          )
        : [
            ...selectedItem.effects,
            {
              id: createId<EffectId>(),
              type: "corridor-key" as const,
              enabled: true,
              params: { ...defaultCorridorKeyParams(), ...params },
            },
          ];
      updateItemEffects(selectedItem.id, nextEffects);
    },
    [selectedItem, updateItemEffects],
  );

  return (
    <div className="flex h-full flex-col">
      <PanelTitle icon={<SlidersHorizontal size={13} />} title="Inspector" />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!selectedItem && <ProjectSettingsSection />}

        {selectedItem && (
          <>
            <p className="mb-1 truncate text-xs font-medium text-neutral-200">{selectedItem.name}</p>
            <p className="mb-4 font-mono text-[10px] text-neutral-500">
              {selectedItem.durationFrames}f @ frame {selectedItem.startFrame}
            </p>

            <TransformSection item={selectedItem} updateItem={updateItem} />
            <TextSection item={selectedItem} updateItem={updateItem} />
            <ShapeSection item={selectedItem} updateItem={updateItem} />
            <ClipSection item={selectedItem} updateItem={updateItem} />
            <EffectsSection item={selectedItem} />
            <MaskSection item={selectedItem} />
            <TransitionSection item={selectedItem} />
            <SpeedSection item={selectedItem} />
            <StabilizeSection item={selectedItem} />
            <MulticamSection item={selectedItem} />
            <ColorSection item={selectedItem} updateItem={updateItem} />
            <BlendSection item={selectedItem} updateItem={updateItem} />

            {selectedItem.type === "clip" && (
              <div className="mb-3 mt-1 flex items-center gap-2">
                <Sparkles size={13} className="text-accent-warm" />
                <span className="text-[11px] font-semibold tracking-wide text-neutral-300">CORRIDORKEY MATTE</span>
              </div>
            )}

            {selectedItem.type === "clip" && !corridorKey && (
              <button
                onClick={() => applyKeyParams({})}
                className="w-full rounded border border-edge bg-panel-raised px-3 py-1.5 text-xs text-neutral-200 hover:border-accent/60"
              >
                Enable CorridorKey
              </button>
            )}

            {selectedItem.type === "clip" && corridorKey && (
              <div className="rounded border border-edge bg-panel/60 p-2.5">
                <label className="mb-3 flex items-center justify-between text-[10px] text-neutral-400">
                  Key color
                  <input
                    type="color"
                    value={rgbToHex(corridorKey.params.keyColor)}
                    onChange={(event) => applyKeyParams({ keyColor: hexToRgb(event.target.value) })}
                    className="h-6 w-10 cursor-pointer rounded border border-edge bg-transparent"
                  />
                </label>
                <SliderRow
                  label="Similarity"
                  value={corridorKey.params.similarity}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(similarity) => applyKeyParams({ similarity })}
                />
                <SliderRow
                  label="Smoothness"
                  value={corridorKey.params.smoothness}
                  min={0.001}
                  max={0.5}
                  step={0.001}
                  onChange={(smoothness) => applyKeyParams({ smoothness })}
                />
                <SliderRow
                  label="Edge erosion"
                  value={corridorKey.params.edgeErosion}
                  min={0}
                  max={0.5}
                  step={0.005}
                  onChange={(edgeErosion) => applyKeyParams({ edgeErosion })}
                />
                <SliderRow
                  label="Feather (px)"
                  value={corridorKey.params.featherRadiusPx}
                  min={0}
                  max={10}
                  step={0.1}
                  onChange={(featherRadiusPx) => applyKeyParams({ featherRadiusPx })}
                />
                <SliderRow
                  label="Spill suppression"
                  value={corridorKey.params.spillSuppression}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(spillSuppression) => applyKeyParams({ spillSuppression })}
                />
                <SliderRow
                  label="Neural matte mix"
                  value={corridorKey.params.neuralMatteMix}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(neuralMatteMix) => applyKeyParams({ neuralMatteMix })}
                />
                <label className="flex items-center gap-2 pt-1 text-[10px] text-neutral-400">
                  <input
                    type="checkbox"
                    checked={corridorKey.params.useNeuralMatte}
                    onChange={(event) => applyKeyParams({ useNeuralMatte: event.target.checked })}
                    className="accent-(--color-accent)"
                  />
                  Drive matte with ONNX neural session
                </label>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const rgbToHex = (rgb: readonly [number, number, number]): string =>
  `#${rgb.map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

const PanelTitle = ({ icon, title }: { icon: React.ReactNode; title: string }) => (
  <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-[11px] font-semibold tracking-wide text-neutral-400">
    {icon}
    {title.toUpperCase()}
  </div>
);

// ---------------------------------------------------------------------------
// Video scopes (histogram / waveform / vectorscope)
// ---------------------------------------------------------------------------

type ScopeMode = "histogram" | "waveform" | "vectorscope";

const drawScope = (canvas: HTMLCanvasElement, img: ImageData, mode: ScopeMode): void => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, W, H);
  const { data, width: sw, height: sh } = img;

  if (mode === "histogram") {
    const bins = 256;
    const r = new Float32Array(bins);
    const g = new Float32Array(bins);
    const b = new Float32Array(bins);
    for (let i = 0; i < data.length; i += 4) {
      r[data[i]]++;
      g[data[i + 1]]++;
      b[data[i + 2]]++;
    }
    const max = Math.max(...r, ...g, ...b, 1);
    const chans: Array<[Float32Array, string]> = [
      [r, "rgba(255,80,80,0.8)"],
      [g, "rgba(80,255,120,0.8)"],
      [b, "rgba(90,140,255,0.8)"],
    ];
    ctx.globalCompositeOperation = "lighter";
    for (const [arr, color] of chans) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let x = 0; x < bins; x++) {
        const px = (x / (bins - 1)) * W;
        const py = H - (arr[x] / max) * H;
        if (x === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    return;
  }

  if (mode === "waveform") {
    // Luma waveform: x = source column, y = brightness (top = white).
    const image = ctx.getImageData(0, 0, W, H);
    for (let sx = 0; sx < sw; sx++) {
      const dx = Math.floor((sx / sw) * W);
      for (let sy = 0; sy < sh; sy++) {
        const i = (sy * sw + sx) * 4;
        const luma = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
        const dy = Math.floor((1 - luma) * (H - 1));
        const di = (dy * W + dx) * 4;
        image.data[di] = Math.min(255, image.data[di] + 40);
        image.data[di + 1] = Math.min(255, image.data[di + 1] + 80);
        image.data[di + 2] = Math.min(255, image.data[di + 2] + 40);
        image.data[di + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return;
  }

  // Vectorscope: plot BT.709 chroma (Cb, Cr) around the center.
  const cx = W / 2;
  const cy = H / 2;
  ctx.strokeStyle = "#20262f";
  ctx.beginPath();
  ctx.arc(cx, cy, Math.min(W, H) / 2 - 2, 0, Math.PI * 2);
  ctx.stroke();
  const image = ctx.getImageData(0, 0, W, H);
  const scale = (Math.min(W, H) / 2 - 2) * 2;
  for (let i = 0; i < data.length; i += 16) {
    const rr = data[i] / 255;
    const gg = data[i + 1] / 255;
    const bb = data[i + 2] / 255;
    const cb = -0.114572 * rr - 0.385428 * gg + 0.5 * bb;
    const cr = 0.5 * rr - 0.454153 * gg - 0.045847 * bb;
    const px = Math.floor(cx + cb * scale);
    const py = Math.floor(cy - cr * scale);
    if (px < 0 || px >= W || py < 0 || py >= H) continue;
    const di = (py * W + px) * 4;
    image.data[di] = Math.min(255, image.data[di] + 60);
    image.data[di + 1] = Math.min(255, image.data[di + 1] + 90);
    image.data[di + 2] = Math.min(255, image.data[di + 2] + 60);
    image.data[di + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
};

const ScopesPanel = ({ onClose }: { onClose: () => void }) => {
  const [mode, setMode] = useState<ScopeMode>("histogram");
  const displayRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const sample = document.createElement("canvas");
    sample.width = 240;
    sample.height = 135;
    const sctx = sample.getContext("2d", { willReadFrequently: true });
    const loop = () => {
      const preview = document.querySelector<HTMLCanvasElement>("canvas[data-webcut-preview]");
      const display = displayRef.current;
      if (preview && sctx && display && preview.width > 0) {
        try {
          sctx.drawImage(preview, 0, 0, sample.width, sample.height);
          drawScope(display, sctx.getImageData(0, 0, sample.width, sample.height), mode);
        } catch {
          /* WebGPU canvas readback can fail transiently — skip this frame */
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  return (
    <Modal title="SCOPES" icon={<Activity size={14} className="text-accent" />} onClose={onClose}>
      <div className="mb-3 flex gap-1">
        {(["histogram", "waveform", "vectorscope"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded px-2 py-1 text-[10px] capitalize ${
              mode === m ? "bg-accent/25 text-accent" : "text-neutral-400 hover:bg-panel-raised"
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      <canvas ref={displayRef} width={256} height={256} className="w-full rounded border border-edge bg-black" />
      <p className="mt-2 text-[10px] leading-relaxed text-neutral-600">
        Live readout of the composited preview. Adjust a clip's grade and watch the trace respond.
      </p>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Audio mixer panel (#48) + loudness/ducking (#54/#53)
// ---------------------------------------------------------------------------

/** Peak level [0,1] of a track's active clip at the current playhead. */
const useMixerLevels = (): Record<string, number> => {
  const tracks = useTimelineStore((s) => s.project.tracks);
  const assets = useTimelineStore((s) => s.project.assets);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const waveCache = useRef<Map<string, number[] | null>>(new Map());

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const frame = transport.getFrame();
      const next: Record<string, number> = {};
      for (const track of tracks) {
        const clip = track.items.find(
          (i) => i.type === "clip" && frame >= i.startFrame && frame < i.startFrame + i.durationFrames,
        ) as ClipItem | undefined;
        let level = 0;
        if (clip && !track.muted && !clip.audioMuted) {
          const asset = assets.find((a) => a.id === clip.assetId);
          if (asset) {
            const key = asset.handleKey;
            if (!waveCache.current.has(key)) {
              waveCache.current.set(key, null); // pending sentinel
              void getWaveform(asset).then((w) => waveCache.current.set(key, w));
            }
            const wave = waveCache.current.get(key);
            if (wave && wave.length > 0 && asset.durationFrames > 0) {
              const src = clip.sourceInFrame + (frame - clip.startFrame) * clip.speed;
              const idx = Math.max(0, Math.min(wave.length - 1, Math.floor((src / asset.durationFrames) * wave.length)));
              const gainLin = Math.pow(10, ((clip.audioGainDb ?? 0) + (track.gainDb ?? 0)) / 20);
              level = Math.max(0, Math.min(1, wave[idx] * gainLin));
            }
          }
        }
        next[track.id] = level;
      }
      setLevels(next);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tracks, assets]);

  return levels;
};

const MixerStrip = ({
  track,
  level,
  onStatus,
}: {
  track: Track;
  level: number;
  onStatus: (msg: string) => void;
}) => {
  const setTrackAudio = useTimelineStore((s) => s.setTrackAudio);
  const toggleTrackFlag = useTimelineStore((s) => s.toggleTrackFlag);
  const setClipGainKeyframes = useTimelineStore((s) => s.setClipGainKeyframes);
  const tracks = useTimelineStore((s) => s.project.tracks);
  const assets = useTimelineStore((s) => s.project.assets);
  const fps = useTimelineStore((s) => s.project.settings.frameRate);
  const [busy, setBusy] = useState(false);

  const activeClip = (t: Track): ClipItem | undefined => {
    const frame = transport.getFrame();
    return t.items.find(
      (i) => i.type === "clip" && frame >= i.startFrame && frame < i.startFrame + i.durationFrames,
    ) as ClipItem | undefined;
  };

  const normalize = async () => {
    const clip = activeClip(track);
    const asset = clip && assets.find((a) => a.id === clip.assetId);
    if (!clip || !asset) return onStatus("No clip under playhead");
    setBusy(true);
    try {
      const file = await fileSystemService.resolveMediaFile(asset.handleKey);
      const buf = await file.arrayBuffer();
      const audio = await decodeAudio(buf);
      const { integratedLufs } = measureLoudness(audio);
      const gain = gainToTargetLufs(integratedLufs, LUFS_TARGETS[0].lufs);
      setTrackAudio(track.id, { gainDb: Math.max(-30, Math.min(6, gain)) });
      onStatus(`${track.name}: ${integratedLufs.toFixed(1)} LUFS → ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB`);
    } catch (err) {
      onStatus(`Loudness failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const duckUnder = async (dialogueTrackId: string) => {
    const music = activeClip(track);
    const dialogueTrack = tracks.find((t) => t.id === dialogueTrackId);
    const dialogueClip = dialogueTrack && activeClip(dialogueTrack);
    const dialogueAsset = dialogueClip && assets.find((a) => a.id === dialogueClip.assetId);
    if (!music || !dialogueClip || !dialogueAsset) return onStatus("Need a clip on both tracks under the playhead");
    setBusy(true);
    try {
      const file = await fileSystemService.resolveMediaFile(dialogueAsset.handleKey);
      const audio = await decodeAudio(await file.arrayBuffer());
      const offset = dialogueClip.startFrame - music.startFrame;
      const kfs = computeDuckingKeyframes(audio, fps, music.durationFrames, offset, defaultDuckOptions());
      setClipGainKeyframes(music.id, kfs);
      onStatus(`Ducked ${music.name} under ${dialogueTrack!.name} (${kfs.length} points)`);
    } catch (err) {
      onStatus(`Ducking failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const otherTracks = tracks.filter((t) => t.id !== track.id);

  return (
    <div className="flex w-24 shrink-0 flex-col items-center gap-1 rounded border border-edge bg-panel/40 p-2">
      <span className="w-full truncate text-center text-[10px] font-medium text-neutral-300">{track.name}</span>
      {/* VU meter */}
      <div className="relative h-24 w-3 overflow-hidden rounded bg-black/60">
        <div
          className="absolute bottom-0 w-full transition-[height] duration-75"
          style={{
            height: `${Math.round(level * 100)}%`,
            background: level > 0.9 ? "#ef4444" : level > 0.7 ? "#f59e0b" : "#22c55e",
          }}
        />
      </div>
      {/* Fader */}
      <input
        type="range"
        min={-30}
        max={6}
        step={0.5}
        value={track.gainDb ?? 0}
        onChange={(e) => setTrackAudio(track.id, { gainDb: Number(e.target.value) })}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-panel-raised accent-(--color-accent)"
      />
      <span className="font-mono text-[9px] text-neutral-500">{(track.gainDb ?? 0).toFixed(1)} dB</span>
      {/* Pan */}
      <input
        type="range"
        min={-1}
        max={1}
        step={0.05}
        value={track.pan ?? 0}
        onChange={(e) => setTrackAudio(track.id, { pan: Number(e.target.value) })}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-panel-raised accent-(--color-accent)"
      />
      <span className="font-mono text-[9px] text-neutral-500">
        pan {(track.pan ?? 0) === 0 ? "C" : (track.pan ?? 0) < 0 ? `L${Math.round(-(track.pan ?? 0) * 100)}` : `R${Math.round((track.pan ?? 0) * 100)}`}
      </span>
      <div className="flex gap-1">
        <button
          onClick={() => toggleTrackFlag(track.id, "muted")}
          className={`rounded px-1.5 py-0.5 text-[9px] ${track.muted ? "bg-red-500/70 text-white" : "border border-edge text-neutral-400"}`}
        >
          M
        </button>
        <button
          onClick={() => toggleTrackFlag(track.id, "soloed")}
          className={`rounded px-1.5 py-0.5 text-[9px] ${track.soloed ? "bg-amber-500/70 text-black" : "border border-edge text-neutral-400"}`}
        >
          S
        </button>
      </div>
      <button
        disabled={busy}
        onClick={normalize}
        className="w-full rounded border border-edge px-1 py-0.5 text-[9px] text-neutral-300 hover:border-accent/60 disabled:opacity-40"
        title="Measure LUFS and set fader to reach −14 LUFS"
      >
        Normalize
      </button>
      {otherTracks.length > 0 && (
        <select
          value=""
          disabled={busy}
          onChange={(e) => e.target.value && void duckUnder(e.target.value)}
          className="w-full rounded border border-edge bg-panel-raised px-0.5 py-0.5 text-[9px] text-neutral-400"
          title="Auto-duck this track under another"
        >
          <option value="">Duck under…</option>
          {otherTracks.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      )}
    </div>
  );
};

const MixerPanel = ({ onClose }: { onClose: () => void }) => {
  const tracks = useTimelineStore((s) => s.project.tracks);
  const levels = useMixerLevels();
  const [status, setStatus] = useState("");
  return (
    <Modal title="AUDIO MIXER" icon={<SlidersHorizontal size={14} className="text-accent" />} onClose={onClose}>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {tracks.map((track) => (
          <MixerStrip key={track.id} track={track} level={levels[track.id] ?? 0} onStatus={setStatus} />
        ))}
      </div>
      <p className="mt-2 min-h-[14px] text-[10px] text-accent">{status}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-neutral-600">
        Faders/mute/solo affect playback live. VU meters read the waveform under the playhead. Normalize
        measures integrated LUFS (ITU-R BS.1770); “Duck under” writes gain automation. Pan is stored per
        track (stereo panning applies once a Web Audio graph is added).
      </p>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Keyboard shortcuts editor (#75)
// ---------------------------------------------------------------------------

const ShortcutsPanel = ({ onClose }: { onClose: () => void }) => {
  const bindings = useKeymap();
  const [capturing, setCapturing] = useState<CommandId | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      // Ignore lone modifier presses; wait for a real key.
      if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
      setBinding(capturing, chordFromEvent(e));
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  const groups = Array.from(new Set(COMMANDS.map((c) => c.group)));
  return (
    <Modal title="KEYBOARD SHORTCUTS" icon={<Keyboard size={14} className="text-accent" />} onClose={onClose}>
      <div className="max-h-[60vh] overflow-y-auto pr-1">
        {groups.map((group) => (
          <div key={group} className="mb-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">{group}</p>
            {COMMANDS.filter((c) => c.group === group).map((cmd) => (
              <div key={cmd.id} className="flex items-center justify-between border-b border-edge/40 py-1">
                <span className="text-[11px] text-neutral-300">{cmd.label}</span>
                <button
                  onClick={() => setCapturing(cmd.id)}
                  className={`min-w-[64px] rounded border px-2 py-0.5 text-center font-mono text-[10px] ${
                    capturing === cmd.id ? "border-accent bg-accent/20 text-accent" : "border-edge text-neutral-300 hover:border-accent/60"
                  }`}
                >
                  {capturing === cmd.id ? "press…" : prettyChord(bindings[cmd.id] ?? cmd.defaultChord)}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <button
        onClick={() => resetBindings()}
        className="mt-2 w-full rounded border border-edge px-2 py-1 text-[10px] text-neutral-400 hover:border-accent/60"
      >
        Reset all to defaults
      </button>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Export dialog (#1)
// ---------------------------------------------------------------------------

const saveBlob = async (blob: Blob, filename: string): Promise<void> => {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  const ext = filename.endsWith(".webm") ? "webm" : "mp4";
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: "Video", accept: { [`video/${ext}`]: [`.${ext}`] } }],
      });
      const writable = await (handle as unknown as { createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }).createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return;
      // fall through to anchor download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const ExportPanel = ({ onClose, onStatus }: { onClose: () => void; onStatus: (msg: string) => void }) => {
  const project = useTimelineStore((s) => s.project);
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [scale, setScale] = useState(1);
  const [fps, setFps] = useState(project.settings.frameRate);
  const [mbps, setMbps] = useState(12);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<readonly ExportJob[]>(exportQueue.getJobs());

  const width = Math.round((project.settings.width * scale) / 2) * 2;
  const height = Math.round((project.settings.height * scale) / 2) * 2;
  const endFrame = projectEndFrame(project);
  const durationSec = endFrame / project.settings.frameRate;
  const hasRunning = jobs.some((j) => j.status === "running" || j.status === "pending");

  // On completion, auto-save + status flash. Chapters (if any) drop as a
  // WebVTT sidecar via anchor-download so they don't compete with the video's
  // Save dialog.
  useEffect(() => {
    exportQueue.setOnFinished((job) => {
      if (!job.result) return;
      void saveBlob(job.result.blob, job.result.filename);
      if (job.result.chaptersVtt) {
        const vtt = new Blob([job.result.chaptersVtt], { type: "text/vtt" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(vtt);
        a.download = `${job.result.filename}.chapters.vtt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      }
      onStatus(`Exported ${job.result.filename} (${(job.result.blob.size / 1e6).toFixed(1)} MB)`);
    });
    const unsub = exportQueue.subscribe(setJobs);
    return () => {
      exportQueue.setOnFinished(null);
      unsub();
    };
  }, [onStatus]);

  const enqueueCurrent = () => {
    if (endFrame <= 0) {
      setError("Timeline is empty — add clips before exporting.");
      return;
    }
    setError(null);
    exportQueue.enqueue(`${format.toUpperCase()} ${width}×${height}@${fps}`, {
      width, height, frameRate: fps, format, videoBitrate: mbps * 1_000_000, startFrame: 0, endFrame,
    });
    void exportQueue.runAll(project);
  };

  const addPreset = (preset: ExportPreset) => {
    if (endFrame <= 0) {
      setError("Timeline is empty — add clips before exporting.");
      return;
    }
    setError(null);
    exportQueue.enqueueFromPreset(project, preset);
    void exportQueue.runAll(project);
  };

  const groups = Array.from(new Set(EXPORT_PRESETS.map((p) => p.group)));

  return (
    <Modal title="EXPORT VIDEO" icon={<Download size={14} className="text-accent-warm" />} onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-4">
        {/* Left column: custom export + presets */}
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Custom</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[10px] text-neutral-400">Format</span>
              <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200">
                <option value="mp4">MP4 (H.264 / AAC)</option>
                <option value="webm">WebM (VP9 / Opus)</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] text-neutral-400">Resolution</span>
              <select value={scale} onChange={(e) => setScale(Number(e.target.value))} className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200">
                <option value={1}>100% ({project.settings.width}×{project.settings.height})</option>
                <option value={0.75}>75%</option>
                <option value={0.5}>50%</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] text-neutral-400">Frame rate</span>
              <select value={fps} onChange={(e) => setFps(Number(e.target.value))} className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200">
                {[24, 25, 30, 50, 60].map((r) => <option key={r} value={r}>{r} fps</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] text-neutral-400">Bitrate</span>
              <select value={mbps} onChange={(e) => setMbps(Number(e.target.value))} className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200">
                {[4, 8, 12, 20, 40, 80].map((m) => <option key={m} value={m}>{m} Mbps</option>)}
              </select>
            </label>
          </div>
          <p className="text-[10px] text-neutral-500">
            {width}×{height} · {fps} fps · {durationSec.toFixed(1)}s · whole timeline ({endFrame} frames)
          </p>
          <button onClick={enqueueCurrent} className="w-full rounded bg-accent-warm/90 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-accent-warm">
            Queue custom export
          </button>

          <div className="border-t border-edge/50 pt-2">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Platform presets</p>
            {groups.map((group) => (
              <div key={group} className="mb-2">
                <p className="mb-0.5 text-[9px] uppercase tracking-wide text-neutral-600">{group}</p>
                <div className="flex flex-wrap gap-1">
                  {EXPORT_PRESETS.filter((p) => p.group === group).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => addPreset(p)}
                      title={`${p.options.width}×${p.options.height} @ ${p.options.frameRate}fps · ${(p.options.videoBitrate / 1e6).toFixed(0)} Mbps`}
                      className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-neutral-300 hover:border-accent-warm/70 hover:bg-accent-warm/10"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {error && <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">{error}</p>}
        </div>

        {/* Right column: job queue */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Queue</p>
            <button onClick={() => exportQueue.clearFinished()} className="text-[9px] text-neutral-500 hover:text-neutral-300">Clear finished</button>
          </div>
          {jobs.length === 0 && (
            <p className="rounded border border-dashed border-edge/70 p-3 text-center text-[10px] text-neutral-600">
              Queue is empty. Add exports from the left, or click a preset.
            </p>
          )}
          <div className="max-h-[50vh] space-y-1.5 overflow-y-auto pr-1">
            {jobs.map((job) => {
              const pct = job.progress ? Math.round((job.progress.frame / job.progress.totalFrames) * 100) : 0;
              return (
                <div key={job.id} className="rounded border border-edge bg-panel/40 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[10px] text-neutral-200">{job.presetName}</span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase ${
                      job.status === "done" ? "bg-emerald-500/25 text-emerald-300"
                      : job.status === "error" ? "bg-red-500/25 text-red-300"
                      : job.status === "cancelled" ? "bg-neutral-500/25 text-neutral-400"
                      : job.status === "running" ? "bg-accent-warm/25 text-accent-warm"
                      : "bg-neutral-500/15 text-neutral-500"
                    }`}>{job.status}</span>
                  </div>
                  <p className="mt-0.5 font-mono text-[9px] text-neutral-500">
                    {job.options.width}×{job.options.height} · {job.options.frameRate}fps · {(job.options.videoBitrate / 1e6).toFixed(0)}Mbps · {job.options.format}
                  </p>
                  {(job.status === "running" || job.status === "pending") && (
                    <div className="mt-1">
                      <div className="mb-0.5 flex justify-between text-[9px] text-neutral-500">
                        <span className="capitalize">{job.progress?.phase ?? "queued"}</span>
                        <span className="font-mono">{pct}%</span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded bg-panel-raised">
                        <div className="h-full bg-accent-warm transition-[width]" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )}
                  {job.error && <p className="mt-1 text-[9px] text-red-400">{job.error}</p>}
                  {job.status === "done" && job.result && (
                    <p className="mt-1 text-[9px] text-neutral-500">Saved · {(job.result.blob.size / 1e6).toFixed(1)} MB</p>
                  )}
                  <div className="mt-1 flex gap-1">
                    {(job.status === "running" || job.status === "pending") && (
                      <button onClick={() => exportQueue.cancel(job.id)} className="rounded border border-edge px-1.5 py-0.5 text-[9px] text-neutral-400 hover:border-red-500/60">
                        Cancel
                      </button>
                    )}
                    {job.status !== "running" && (
                      <button onClick={() => exportQueue.remove(job.id)} className="rounded border border-edge px-1.5 py-0.5 text-[9px] text-neutral-500 hover:border-accent/60">
                        Remove
                      </button>
                    )}
                    {job.status === "done" && job.result && (
                      <button onClick={() => void saveBlob(job.result!.blob, job.result!.filename)} className="rounded border border-edge px-1.5 py-0.5 text-[9px] text-neutral-300 hover:border-accent/60">
                        Save again
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] leading-relaxed text-neutral-600">
            Jobs run sequentially through the shared WebGPU compositor. Each completed export is
            offered via the Save dialog automatically; cancel one without stopping the rest.
          </p>
        </div>
      </div>

      <div className="mt-3 flex justify-end border-t border-edge/50 pt-2">
        <button onClick={onClose} disabled={hasRunning} className="rounded border border-edge px-3 py-1 text-[11px] text-neutral-400 hover:border-accent/60 disabled:opacity-40">
          {hasRunning ? "Exports running…" : "Close"}
        </button>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Proxy indicator (#51): status chip + toggle in the toolbar
// ---------------------------------------------------------------------------

const ProxyIndicator = () => {
  const [jobs, setJobs] = useState<readonly ProxyJob[]>(proxyService.getJobs());
  const [useProxies, setUseProxiesState] = useState(getUseProxies());
  useEffect(() => {
    const unsub1 = proxyService.subscribe(setJobs);
    const unsub2 = subscribeUseProxies(setUseProxiesState);
    return () => { unsub1(); unsub2(); };
  }, []);

  const running = jobs.filter((j) => j.status === "running" || j.status === "pending");
  const done = jobs.filter((j) => j.status === "done").length;
  const errored = jobs.filter((j) => j.status === "error").length;

  const label = running.length > 0
    ? `Optimizing… ${Math.round((running[0].progress || 0) * 100)}%`
    : done > 0 || errored > 0
      ? `${done} proxy${done === 1 ? "" : "ies"}${errored > 0 ? ` · ${errored} err` : ""}`
      : "";

  return (
    <div className="flex items-center gap-1">
      {label && (
        <span
          title={running.map((j) => `${j.assetName} — ${Math.round(j.progress * 100)}%`).join("\n") || label}
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${running.length > 0 ? "bg-accent-warm/20 text-accent-warm" : "text-neutral-500"}`}
        >
          {label}
        </span>
      )}
      <button
        onClick={() => setUseProxies(!useProxies)}
        title={useProxies ? "Preview uses proxy media when available. Click to disable." : "Previews use full-resolution originals. Click to enable proxies."}
        className={`rounded border px-1.5 py-1 text-[11px] ${useProxies ? "border-accent-warm/60 text-accent-warm hover:bg-accent-warm/10" : "border-edge text-neutral-400 hover:border-accent/60"}`}
      >
        Proxy: {useProxies ? "on" : "off"}
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Motion tracking (#59): pick a point on the source frame, LK-track it, and
// write the result as position keyframes on a chosen overlay.
// ---------------------------------------------------------------------------

const MotionTrackPanel = ({ onClose, onStatus }: { onClose: () => void; onStatus: (m: string) => void }) => {
  const project = useTimelineStore((s) => s.project);
  const selectedItemIds = useTimelineStore((s) => s.selectedItemIds);
  const updateItem = useTimelineStore((s) => s.updateItem);

  // Pick the currently-selected CLIP as the source, and require exactly one
  // OVERLAY somewhere in the project to receive the keyframes.
  const clip = useMemo(() => {
    for (const track of project.tracks) {
      for (const item of track.items) {
        if (item.id === selectedItemIds[0] && item.type === "clip") return item;
      }
    }
    return null;
  }, [project, selectedItemIds]);
  const overlays = useMemo(() => {
    const acc: TrackItem[] = [];
    for (const track of project.tracks) {
      for (const item of track.items) {
        if (item.type === "text" || item.type === "shape" || item.type === "sticker") acc.push(item);
      }
    }
    return acc;
  }, [project]);

  const asset = clip ? project.assets.find((a) => a.id === clip.assetId) : undefined;
  const [px, setPx] = useState(asset?.width ? Math.round(asset.width / 2) : 320);
  const [py, setPy] = useState(asset?.height ? Math.round(asset.height / 2) : 180);
  const [targetOverlayId, setTargetOverlayId] = useState<string>(overlays[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = async () => {
    if (!clip || !asset || asset.kind === "audio") { setMessage("Select a video clip first."); return; }
    if (!targetOverlayId) { setMessage("Add a text/shape/sticker overlay first."); return; }
    setBusy(true);
    setMessage("Tracking…");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const samples: TrackSample[] = await trackPoint(
        asset,
        clip.sourceInFrame,
        clip.durationFrames,
        project.settings.frameRate,
        { x: px, y: py },
        (p) => setProgress(Math.round((p.frame / p.totalFrames) * 100)),
        controller.signal,
      );

      // Apply as position keyframes on the overlay. Positions are in project
      // pixels relative to canvas center, so we offset by (asset dim / 2).
      const w = asset.width ?? project.settings.width;
      const h = asset.height ?? project.settings.height;
      const scaleX = project.settings.width / w;
      const scaleY = project.settings.height / h;
      const keyframes = samples.map((s) => ({
        id: createId<KeyframeId>(),
        frame: s.frame,
        value: {
          x: (s.point.x - w / 2) * scaleX,
          y: (s.point.y - h / 2) * scaleY,
        },
        interpolation: "linear" as const,
      }));

      updateItem(
        targetOverlayId as unknown as TrackItemId,
        (it) => ({
          ...it,
          transform: {
            ...it.transform,
            position: { kind: "animated", keyframes },
          },
        }) as unknown as TrackItem,
        "motiontrack",
      );

      onStatus(`Motion-tracked ${samples.length} frames → ${overlays.find((o) => o.id === targetOverlayId)?.name}.`);
      onClose();
    } catch (err) {
      if ((err as DOMException).name === "AbortError") setMessage("Cancelled.");
      else setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <Modal title="MOTION TRACKING" icon={<Target size={14} className="text-accent" />} onClose={onClose} wide>
      {!clip && (
        <p className="rounded border border-dashed border-edge/70 p-3 text-[10px] text-neutral-500">
          Select a video clip on the timeline to track.
        </p>
      )}
      {clip && asset && (
        <div className="space-y-3">
          <p className="text-[10px] text-neutral-400">
            Source: <span className="font-mono text-neutral-200">{asset.name}</span> · {asset.width ?? "?"}×{asset.height ?? "?"} · {clip.durationFrames} frames.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-0.5 block text-[10px] text-neutral-400">Start point X (px)</span>
              <input type="number" value={px} onChange={(e) => setPx(Number(e.target.value))} className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200 outline-none" />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-[10px] text-neutral-400">Start point Y (px)</span>
              <input type="number" value={py} onChange={(e) => setPy(Number(e.target.value))} className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200 outline-none" />
            </label>
          </div>

          <label className="block">
            <span className="mb-0.5 block text-[10px] text-neutral-400">Attach tracked position to</span>
            <select
              value={targetOverlayId}
              onChange={(e) => setTargetOverlayId(e.target.value)}
              className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200"
            >
              <option value="">— pick an overlay —</option>
              {overlays.map((o) => (
                <option key={o.id} value={o.id}>{o.name} ({o.type})</option>
              ))}
            </select>
          </label>

          {busy && (
            <div>
              <div className="mb-0.5 flex justify-between text-[10px] text-neutral-500">
                <span>Tracking</span>
                <span className="font-mono">{progress}%</span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded bg-panel-raised">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
          {message && <p className="text-[10px] text-neutral-400">{message}</p>}

          <div className="flex gap-2">
            {busy ? (
              <button onClick={() => abortRef.current?.abort()} className="flex-1 rounded border border-edge px-3 py-1.5 text-[11px] text-neutral-300 hover:border-red-500/60">
                Cancel
              </button>
            ) : (
              <>
                <button onClick={onClose} className="rounded border border-edge px-3 py-1.5 text-[11px] text-neutral-400 hover:border-accent/60">Close</button>
                <button onClick={run} className="flex-1 rounded bg-accent/90 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-accent">
                  Track
                </button>
              </>
            )}
          </div>

          <p className="text-[10px] leading-relaxed text-neutral-600">
            Classical Lucas–Kanade optical flow: iteratively aligns a small window around the seed
            point across frames using two pyramid levels. Deterministic, no ML model needed. Tracked
            positions land as linear position keyframes on the chosen overlay's transform.
          </p>
        </div>
      )}
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Motion-graphics templates (#62)
// ---------------------------------------------------------------------------

const TemplatesPanel = ({ onClose, onStatus }: { onClose: () => void; onStatus: (m: string) => void }) => {
  const tracks = useTimelineStore((s) => s.project.tracks);
  const selectedItemIds = useTimelineStore((s) => s.selectedItemIds);
  const addItemToTrack = useTimelineStore((s) => s.addItemToTrack);
  const armedTrackId = useTimelineStore((s) => s.armedTrackId);
  const [userTemplates, setUserTemplates] = useState<MotionGraphicsTemplate[]>(() => loadTemplates());
  const [selected, setSelected] = useState<MotionGraphicsTemplate | null>(null);
  const [values, setValues] = useState<TemplateValues>({});

  const templates = [...BUILT_IN_TEMPLATES, ...userTemplates];

  const openTemplate = (t: MotionGraphicsTemplate) => {
    setSelected(t);
    const init: TemplateValues = {};
    for (const p of t.params) init[p.name] = p.defaultValue;
    setValues(init);
  };

  const saveFromSelection = () => {
    const overlays: import("../types/timeline").OverlayItem[] = [];
    for (const track of tracks) {
      for (const item of track.items) {
        if (!selectedItemIds.includes(item.id)) continue;
        if (item.type === "text" || item.type === "shape" || item.type === "sticker") {
          overlays.push(item);
        }
      }
    }
    if (overlays.length === 0) {
      onStatus("Select some overlays first (text / shape / sticker).");
      return;
    }
    const name = prompt("Template name:");
    if (!name) return;
    const t = templateFromOverlays(name, overlays);
    const next = [...userTemplates, t];
    setUserTemplates(next);
    saveTemplates(next);
    onStatus(`Saved template “${name}”.`);
  };

  const applyToTimeline = () => {
    if (!selected) return;
    const target = tracks.find((t) => t.id === armedTrackId) ?? tracks.find((t) => t.kind === "video" && !t.locked);
    if (!target) {
      onStatus("No visual track available. Add one first.");
      return;
    }
    const startFrame = Math.round(transport.getFrame());
    const overlays = applyTemplate(selected, values, startFrame);
    for (const o of overlays) {
      addItemToTrack(target.id, o);
    }
    onStatus(`Applied “${selected.name}” at frame ${startFrame}.`);
    onClose();
  };

  const removeTemplate = (id: string) => {
    if (BUILT_IN_TEMPLATES.some((b) => b.id === id)) return; // built-ins are immutable
    const next = userTemplates.filter((t) => t.id !== id);
    setUserTemplates(next);
    saveTemplates(next);
    if (selected?.id === id) setSelected(null);
  };

  return (
    <Modal title="MOTION GRAPHICS TEMPLATES" icon={<LayoutTemplate size={14} className="text-accent" />} onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-4">
        {/* Gallery */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Gallery</p>
            <button onClick={saveFromSelection} className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-neutral-300 hover:border-accent/60">
              + Save selection
            </button>
          </div>
          <div className="max-h-[55vh] space-y-1 overflow-y-auto pr-1">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => openTemplate(t)}
                className={`flex w-full items-center justify-between rounded border px-2 py-1.5 text-left text-[11px] ${
                  selected?.id === t.id ? "border-accent bg-accent/10 text-neutral-100" : "border-edge text-neutral-300 hover:border-accent/60"
                }`}
              >
                <span>
                  <span className="block font-medium">{t.name}</span>
                  <span className="text-[9px] text-neutral-500">
                    {t.overlays.length} overlay{t.overlays.length === 1 ? "" : "s"} · {t.durationFrames}f · {t.params.length} param{t.params.length === 1 ? "" : "s"}
                  </span>
                </span>
                {!BUILT_IN_TEMPLATES.some((b) => b.id === t.id) && (
                  <button
                    onClick={(e) => { e.stopPropagation(); removeTemplate(t.id); }}
                    className="ml-2 rounded border border-edge px-1 text-[9px] text-neutral-500 hover:border-red-500/60"
                    title="Delete template"
                  >✕</button>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Detail / apply */}
        <div className="space-y-2">
          {!selected && (
            <p className="rounded border border-dashed border-edge/70 p-3 text-[10px] text-neutral-500">
              Pick a template on the left to preview its parameters and apply it at the playhead.
            </p>
          )}
          {selected && (
            <>
              <p className="text-[11px] font-medium text-neutral-200">{selected.name}</p>
              {selected.params.length === 0 && (
                <p className="text-[10px] text-neutral-500">No parameters — applies as-is.</p>
              )}
              {selected.params.map((p) => (
                <label key={p.name} className="block">
                  <span className="mb-0.5 block text-[10px] text-neutral-400">{p.name}</span>
                  {p.kind === "text" && (
                    <input
                      value={String(values[p.name] ?? p.defaultValue)}
                      onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                      className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200 outline-none"
                    />
                  )}
                  {p.kind === "color" && (
                    <input
                      type="color"
                      value={String(values[p.name] ?? p.defaultValue).slice(0, 7)}
                      onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                      className="h-7 w-full rounded border border-edge bg-transparent"
                    />
                  )}
                  {p.kind === "number" && (
                    <input
                      type="number"
                      value={Number(values[p.name] ?? p.defaultValue)}
                      onChange={(e) => setValues((v) => ({ ...v, [p.name]: Number(e.target.value) }))}
                      className="w-full rounded border border-edge bg-panel-raised px-1.5 py-1 text-[11px] text-neutral-200 outline-none"
                    />
                  )}
                </label>
              ))}
              <button
                onClick={applyToTimeline}
                className="w-full rounded bg-accent/90 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-accent"
              >
                Apply at playhead
              </button>
              <p className="text-[10px] text-neutral-600">
                Overlays land on the armed video track (or the first unlocked video track).
              </p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Diagnostics panel
// ---------------------------------------------------------------------------

const DiagRow = ({ label, value, ok }: { label: string; value: string; ok?: boolean }) => (
  <div className="flex items-center justify-between border-b border-edge/50 py-1.5 text-[11px]">
    <span className="text-neutral-400">{label}</span>
    <span className={`font-mono ${ok === undefined ? "text-neutral-200" : ok ? "text-emerald-400" : "text-amber-400"}`}>
      {value}
    </span>
  </div>
);

const DiagnosticsPanel = ({ onClose }: { onClose: () => void }) => {
  const project = useTimelineStore((state) => state.project);
  const stats = useMemo(() => {
    let items = 0;
    let durationFrames = 0;
    for (const track of project.tracks) {
      items += track.items.length;
      for (const item of track.items) durationFrames = Math.max(durationFrames, item.startFrame + item.durationFrames);
    }
    return { items, durationFrames };
  }, [project]);

  const secure = typeof window !== "undefined" && window.isSecureContext;
  const coi = typeof window !== "undefined" && window.crossOriginIsolated;
  const webgpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const canDecode = typeof window !== "undefined" && "VideoDecoder" in window;
  const canEncode = typeof window !== "undefined" && "VideoEncoder" in window;
  const canFsa = typeof window !== "undefined" && "showOpenFilePicker" in window;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-edge bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <Activity size={14} className="text-accent" />
          <span className="text-xs font-semibold tracking-wide text-neutral-200">DIAGNOSTICS</span>
          <div className="flex-1" />
          <button onClick={onClose} className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-panel-raised">
            Close
          </button>
        </div>

        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Environment</p>
        <DiagRow label="WebGPU" value={webgpu ? "available" : "unavailable"} ok={webgpu} />
        <DiagRow label="WebCodecs decode" value={canDecode ? "available" : "unavailable"} ok={canDecode} />
        <DiagRow label="WebCodecs encode" value={canEncode ? "available" : "unavailable"} ok={canEncode} />
        <DiagRow label="File System Access" value={canFsa ? "available" : "unavailable"} ok={canFsa} />
        <DiagRow label="Secure context" value={secure ? "yes" : "no"} ok={secure} />
        <DiagRow label="Cross-origin isolated" value={coi ? "yes (threads)" : "no (single-thread)"} ok={coi} />

        <p className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Project</p>
        <DiagRow label="Resolution" value={`${project.settings.width}×${project.settings.height}`} />
        <DiagRow label="Frame rate" value={`${project.settings.frameRate} fps`} />
        <DiagRow label="Tracks" value={String(project.tracks.length)} />
        <DiagRow label="Timeline items" value={String(stats.items)} />
        <DiagRow label="Media assets" value={String(project.assets.length)} />
        <DiagRow label="Markers" value={String(project.markers.length)} />
        <DiagRow
          label="Content length"
          value={framesToTimecode(stats.durationFrames, project.settings.frameRate)}
        />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Modals: subtitles, sounds, projects
// ---------------------------------------------------------------------------

const Modal = ({
  title,
  icon,
  wide,
  onClose,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
    <div
      className={`flex max-h-[85vh] w-full flex-col rounded-lg border border-edge bg-panel shadow-2xl ${wide ? "max-w-2xl" : "max-w-md"}`}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
        {icon}
        <span className="text-xs font-semibold tracking-wide text-neutral-200">{title}</span>
        <div className="flex-1" />
        <button onClick={onClose} className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-panel-raised">
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  </div>
);

const SubtitlesPanel = ({ onClose }: { onClose: () => void }) => {
  const project = useTimelineStore((s) => s.project);
  const subtitles = useTimelineStore((s) => s.project.subtitles);
  const style = useTimelineStore((s) => s.project.subtitleStyle);
  const fps = useTimelineStore((s) => s.project.settings.frameRate);
  const addSubtitle = useTimelineStore((s) => s.addSubtitle);
  const updateSubtitle = useTimelineStore((s) => s.updateSubtitle);
  const removeSubtitle = useTimelineStore((s) => s.removeSubtitle);
  const setSubtitles = useTimelineStore((s) => s.setSubtitles);
  const setStyle = useTimelineStore((s) => s.setSubtitleStyle);
  const [importText, setImportText] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeMsg, setTranscribeMsg] = useState<string | null>(null);
  const [transcribePct, setTranscribePct] = useState(0);
  const transcribeAbort = useRef<AbortController | null>(null);

  const exportSrt = () => {
    const blob = new Blob([toSrt(subtitles, fps)], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "captions.srt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const runTranscribe = async () => {
    const endFrame = projectEndFrame(project);
    if (endFrame <= 0) { setTranscribeMsg("Timeline is empty."); return; }
    setTranscribing(true);
    setTranscribeMsg("Loading model…");
    setTranscribePct(0);
    const controller = new AbortController();
    transcribeAbort.current = controller;
    try {
      const { segments } = await transcribeProject(
        project,
        { startFrame: 0, endFrame },
        (p) => {
          setTranscribeMsg(p.message ?? p.phase);
          setTranscribePct(Math.round(p.progress * 100));
        },
        controller.signal,
      );
      if (segments.length === 0) {
        setTranscribeMsg("No speech detected.");
      } else {
        const frames = segmentsToSubtitleFrames(segments, 0, fps);
        setSubtitles([...subtitles, ...frames.map((f) => ({
          id: createId<SubtitleId>(),
          startFrame: f.startFrame,
          endFrame: f.endFrame,
          text: f.text,
        }))]);
        setTranscribeMsg(`Added ${segments.length} caption${segments.length === 1 ? "" : "s"}.`);
      }
    } catch (err) {
      if ((err as DOMException).name === "AbortError") setTranscribeMsg("Cancelled.");
      else setTranscribeMsg(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTranscribing(false);
      transcribeAbort.current = null;
    }
  };

  return (
    <Modal title="SUBTITLES" icon={<Captions size={14} className="text-accent" />} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => addSubtitle(transport.getFrame(), transport.getFrame() + fps * 2, "New caption")}
          className="rounded border border-edge bg-panel-raised px-2 py-1 text-[11px] text-neutral-200 hover:border-accent/60"
        >
          + Cue at playhead
        </button>
        <button onClick={exportSrt} className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60">
          Export .srt
        </button>
        {!transcribing ? (
          <button
            onClick={runTranscribe}
            className="rounded bg-accent/90 px-2 py-1 text-[11px] font-medium text-white hover:bg-accent"
            title="Run Whisper (whisper-tiny.en) locally in your browser. First run downloads ~40MB of model weights."
          >
            ⚡ Auto-transcribe
          </button>
        ) : (
          <button
            onClick={() => transcribeAbort.current?.abort()}
            className="rounded border border-red-500/50 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10"
          >
            Cancel transcription
          </button>
        )}
        {(transcribing || transcribeMsg) && (
          <span className="text-[10px] text-neutral-400">
            {transcribeMsg}
            {transcribing && ` · ${transcribePct}%`}
          </span>
        )}
      </div>
      {transcribing && (
        <div className="mb-3 h-1 w-full overflow-hidden rounded bg-panel-raised">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${transcribePct}%` }} />
        </div>
      )}

      <div className="mb-3 grid grid-cols-4 gap-2 rounded border border-edge bg-panel/40 p-2 text-[10px]">
        <NumberField label="Size" value={style.fontSizePx} onChange={(v) => setStyle({ fontSizePx: Math.max(8, v) })} />
        <label className="block">
          <span className="mb-0.5 block text-[9px] uppercase tracking-wide text-neutral-500">Text</span>
          <input type="color" value={style.fillColor} onChange={(e) => setStyle({ fillColor: e.target.value })} className="h-7 w-full rounded border border-edge bg-transparent" />
        </label>
        <NumberField label="Pos Y %" value={Math.round(style.positionY * 100)} onChange={(v) => setStyle({ positionY: Math.min(1, Math.max(0, v / 100)) })} />
        <div className="flex items-end text-neutral-500">{subtitles.length} cues</div>
      </div>

      <div className="space-y-1">
        {subtitles.map((cue) => (
          <div key={cue.id} className="flex items-center gap-1 rounded border border-edge bg-panel-raised/50 p-1">
            <input
              value={cue.text}
              onChange={(e) => updateSubtitle(cue.id, { text: e.target.value })}
              className="min-w-0 flex-1 rounded bg-panel px-1.5 py-1 text-[11px] text-neutral-200 outline-none"
            />
            <input type="number" value={cue.startFrame} onChange={(e) => updateSubtitle(cue.id, { startFrame: Number(e.target.value) })} className="w-16 rounded bg-panel px-1 py-1 text-[10px] text-neutral-400" />
            <input type="number" value={cue.endFrame} onChange={(e) => updateSubtitle(cue.id, { endFrame: Number(e.target.value) })} className="w-16 rounded bg-panel px-1 py-1 text-[10px] text-neutral-400" />
            <button onClick={() => removeSubtitle(cue.id)} className="px-1 text-neutral-500 hover:text-red-400">✕</button>
          </div>
        ))}
      </div>

      <p className="mb-1 mt-3 text-[9px] uppercase tracking-wide text-neutral-500">Import SRT / VTT</p>
      <textarea
        value={importText}
        onChange={(e) => setImportText(e.target.value)}
        rows={3}
        placeholder="Paste .srt or .vtt content…"
        className="w-full resize-none rounded border border-edge bg-panel-raised px-2 py-1 text-[10px] text-neutral-200 outline-none"
      />
      <button
        onClick={() => {
          const parsed = parseCaptions(importText, fps);
          if (parsed.length > 0) setSubtitles([...subtitles, ...parsed]);
          setImportText("");
        }}
        className="mt-1 rounded border border-edge bg-panel-raised px-2 py-1 text-[11px] text-neutral-200 hover:border-accent/60"
      >
        Import
      </button>
    </Modal>
  );
};

const SoundsPanel = ({ onClose, onStatus }: { onClose: () => void; onStatus: (m: string) => void }) => {
  const tracks = useTimelineStore((s) => s.project.tracks);
  const frameRate = useTimelineStore((s) => s.project.settings.frameRate);
  const addAsset = useTimelineStore((s) => s.addAsset);
  const addClipToTrack = useTimelineStore((s) => s.addClipToTrack);

  const preview = (def: (typeof SOUND_LIBRARY)[number]) => {
    const url = URL.createObjectURL(def.make());
    const audio = new Audio(url);
    void audio.play().finally(() => setTimeout(() => URL.revokeObjectURL(url), 3000));
  };

  const add = async (def: (typeof SOUND_LIBRARY)[number]) => {
    const [asset] = await ingestFiles([soundToFile(def)], frameRate);
    if (!asset) return;
    addAsset(asset);
    const track = tracks.find((t) => t.kind === "audio" && !t.locked);
    if (track) {
      addClipToTrack(track.id, {
        type: "clip",
        name: def.name,
        assetId: asset.id,
        startFrame: Math.round(transport.getFrame()),
        durationFrames: asset.durationFrames,
        sourceInFrame: 0,
        speed: 1,
        audioGainDb: 0,
        audioMuted: false,
        transform: identityTransform(),
        effects: [],
        locked: false,
      });
    }
    onStatus(`Added ${def.name}`);
  };

  return (
    <Modal title="SOUNDS" icon={<Music size={14} className="text-accent" />} onClose={onClose}>
      <p className="mb-2 text-[10px] text-neutral-500">Built-in sounds, synthesized locally and added to an audio track at the playhead.</p>
      <div className="space-y-1">
        {SOUND_LIBRARY.map((def) => (
          <div key={def.name} className="flex items-center gap-2 rounded border border-edge bg-panel-raised/50 px-2 py-1.5">
            <Music size={13} className="text-accent" />
            <span className="flex-1 text-[11px] text-neutral-200">{def.name}</span>
            <span className="font-mono text-[9px] text-neutral-500">{def.durationS.toFixed(2)}s</span>
            <button onClick={() => preview(def)} className="rounded px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-panel">
              Preview
            </button>
            <button onClick={() => void add(def)} className="rounded bg-accent/80 px-2 py-0.5 text-[10px] text-white hover:bg-accent">
              Add
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
};

const ProjectsPanel = ({ onClose, onStatus }: { onClose: () => void; onStatus: (m: string) => void }) => {
  const setProject = useTimelineStore((s) => s.setProject);
  const [list, setList] = useState<ProjectSummary[]>([]);
  const currentId = useTimelineStore((s) => s.project.id);

  const refresh = useCallback(() => {
    void projectStore.list().then(setList);
  }, []);
  useEffect(() => refresh(), [refresh]);

  const saveCurrent = async () => {
    await projectStore.save(useTimelineStore.getState().project);
    onStatus("Saved to project library");
    refresh();
  };
  const open = async (id: ProjectSummary["id"]) => {
    const project = await projectStore.load(id);
    if (project) {
      setProject(project);
      onStatus("Project opened");
      onClose();
    }
  };

  return (
    <Modal title="PROJECTS" icon={<LayoutDashboard size={14} className="text-accent" />} onClose={onClose}>
      <div className="mb-3 flex gap-2">
        <button onClick={saveCurrent} className="rounded bg-accent/80 px-2 py-1 text-[11px] text-white hover:bg-accent">
          Save current
        </button>
        <button
          onClick={() => {
            setProject(createEmptyProject());
            onClose();
          }}
          className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60"
        >
          New project
        </button>
      </div>
      {list.length === 0 && <p className="text-center text-[11px] text-neutral-600">No saved projects yet.</p>}
      <div className="space-y-1">
        {list.map((p) => (
          <div key={p.id} className="flex items-center gap-2 rounded border border-edge bg-panel-raised/50 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] text-neutral-200">
                {p.name}
                {p.id === currentId && <span className="ml-1 text-[9px] text-accent">(current)</span>}
              </p>
              <p className="font-mono text-[9px] text-neutral-500">{new Date(p.updatedAt).toLocaleString()}</p>
            </div>
            <button onClick={() => void open(p.id)} className="rounded px-2 py-0.5 text-[10px] text-neutral-300 hover:bg-panel">
              Open
            </button>
            <button
              onClick={async () => {
                const name = window.prompt("Project name", p.name);
                if (name) {
                  await projectStore.rename(p.id, name);
                  refresh();
                }
              }}
              className="rounded px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-panel"
            >
              Rename
            </button>
            <button
              onClick={async () => {
                await projectStore.remove(p.id);
                refresh();
              }}
              className="px-1 text-neutral-500 hover:text-red-400"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Main layout
// ---------------------------------------------------------------------------

export const MainLayout = () => {
  const projectName = useTimelineStore((state) => state.project.name);
  const setProject = useTimelineStore((state) => state.setProject);
  const addAsset = useTimelineStore((state) => state.addAsset);
  const frameRate = useTimelineStore((state) => state.project.settings.frameRate);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [modal, setModal] = useState<null | "subtitles" | "sounds" | "projects" | "scopes" | "mixer" | "shortcuts" | "export" | "templates" | "motionTrack">(null);

  const flashStatus = useCallback((message: string) => {
    setStatusMessage(message);
    window.setTimeout(() => setStatusMessage(null), 2500);
  }, []);

  // Paste-to-import: media files on the clipboard become assets (no picker).
  useEffect(() => {
    const importFiles = async (files: File[], label: string) => {
      const media = files.filter(isMediaFile);
      if (media.length === 0) return;
      try {
        const created = await ingestFiles(media, frameRate, {
          onProxyReady: (assetId, proxy) => {
            useTimelineStore.getState().updateAsset(assetId, {
              proxyHandleKey: proxy.handleKey,
              proxyWidth: proxy.width,
              proxyHeight: proxy.height,
            });
          },
        });
        for (const asset of created) addAsset(asset);
        setStatusMessage(`Imported ${created.length} ${label}`);
        window.setTimeout(() => setStatusMessage(null), 2500);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const files = event.clipboardData?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      void importFiles(Array.from(files), "pasted file(s)");
    };

    // Stop the browser navigating to a dropped file, and import files dropped
    // anywhere the media pool / timeline drop zones didn't already consume.
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      void importFiles(Array.from(event.dataTransfer.files), "dropped file(s)");
    };

    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [addAsset, frameRate]);

  const withStatus = useCallback(async (label: string, action: () => Promise<void>) => {
    try {
      await action();
      setStatusMessage(label);
      window.setTimeout(() => setStatusMessage(null), 2500);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
      window.setTimeout(() => setStatusMessage(null), 5000);
    }
  }, []);

  const handleSave = useCallback(
    () =>
      withStatus("Project saved", async () => {
        await fileSystemService.saveProject(useTimelineStore.getState().project);
      }),
    [withStatus],
  );

  const handleOpen = useCallback(
    () =>
      withStatus("Project loaded", async () => {
        const project = await fileSystemService.openProject();
        if (project) setProject(project);
      }),
    [withStatus, setProject],
  );

  const createNestedSequence = useCallback(() => {
    const state = useTimelineStore.getState();
    const project = state.project;
    // Only nest projects that have SOMETHING to render.
    let hasContent = false;
    for (const track of project.tracks) {
      if (track.items.length > 0) { hasContent = true; break; }
    }
    if (!hasContent) {
      flashStatus("Add clips to the timeline before nesting.");
      return;
    }
    const name = prompt("Nested sequence name:", `Nested ${new Date().toLocaleTimeString()}`);
    if (!name) return;

    const snapshot: import("../types/timeline").Project = JSON.parse(JSON.stringify(project));
    const asset: import("../types/timeline").MediaAsset = {
      id: createId<import("../types/timeline").MediaAssetId>(),
      kind: "sequence",
      name,
      handleKey: `sequence:${snapshot.id}`,
      durationFrames: (() => {
        let max = 0;
        for (const track of project.tracks) {
          for (const item of track.items) max = Math.max(max, item.startFrame + item.durationFrames);
        }
        return Math.max(1, max);
      })(),
      width: project.settings.width,
      height: project.settings.height,
      mimeType: "application/x-webcut-sequence",
      fileSizeBytes: 0,
      nestedProject: snapshot,
    };
    state.addAsset(asset);
    flashStatus(`Nested sequence “${name}” added to media pool.`);
  }, [flashStatus]);

  return (
    <div className="flex h-full flex-col bg-panel-deep text-sm">
      {/* App bar */}
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-edge bg-panel px-3">
        <Clapperboard size={16} className="text-accent" />
        <span className="text-[13px] font-semibold tracking-wide text-neutral-100">WebCut</span>
        <span className="truncate text-xs text-neutral-500">{projectName}.webcut</span>

        <div className="flex-1" />

        {statusMessage && <span className="text-[11px] text-accent">{statusMessage}</span>}

        <button onClick={() => setModal("projects")} title="Projects" className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60">
          <LayoutDashboard size={12} />
        </button>
        <button onClick={() => setModal("sounds")} title="Sounds library" className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60">
          <Music size={12} />
        </button>
        <button onClick={() => setModal("subtitles")} title="Subtitles" className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60">
          <Captions size={12} />
        </button>
        <button onClick={() => setModal("scopes")} title="Scopes" className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60">
          <BarChart3 size={12} />
        </button>
        <button onClick={() => setModal("mixer")} title="Audio mixer" className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60">
          <SlidersHorizontal size={12} />
        </button>
        <button onClick={() => setModal("shortcuts")} title="Keyboard shortcuts" className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60">
          <Keyboard size={12} />
        </button>
        <button onClick={() => setModal("templates")} title="Motion graphics templates" className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60">
          <LayoutTemplate size={12} />
        </button>
        <button onClick={() => setModal("motionTrack")} title="Motion tracking" className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60">
          <Target size={12} />
        </button>
        <button
          onClick={createNestedSequence}
          title="Snapshot the current timeline as a nested sequence and add it to the media pool"
          className="rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60"
        >
          Nest
        </button>
        <ProxyIndicator />
        <button
          onClick={() => setShowDiag(true)}
          title="Diagnostics"
          className="flex items-center gap-1.5 rounded border border-edge px-2 py-1 text-[11px] text-neutral-300 hover:border-accent/60"
        >
          <Activity size={12} />
        </button>
        <button
          onClick={handleOpen}
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-[11px] text-neutral-300 hover:border-accent/60"
        >
          <FolderOpen size={12} /> Open
        </button>
        <button
          onClick={handleSave}
          className="flex items-center gap-1.5 rounded bg-accent/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent"
        >
          <Save size={12} /> Save
        </button>
        <button
          onClick={() => setModal("export")}
          className="flex items-center gap-1.5 rounded bg-accent-warm/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-warm"
        >
          <Download size={12} /> Export
        </button>
      </header>

      {/* Workspace */}
      <div className="flex min-h-0 flex-[3] border-b border-edge">
        <aside className="w-60 shrink-0 border-r border-edge bg-panel-deep">
          <MediaPool />
        </aside>
        <main className="min-w-0 flex-1">
          <VideoPlayer />
        </main>
        <aside className="w-72 shrink-0 border-l border-edge bg-panel-deep">
          <Inspector />
        </aside>
      </div>

      {/* Timeline */}
      <div className="min-h-0 flex-[2]">
        <Timeline />
      </div>

      {showDiag && <DiagnosticsPanel onClose={() => setShowDiag(false)} />}
      {modal === "subtitles" && <SubtitlesPanel onClose={() => setModal(null)} />}
      {modal === "scopes" && <ScopesPanel onClose={() => setModal(null)} />}
      {modal === "mixer" && <MixerPanel onClose={() => setModal(null)} />}
      {modal === "shortcuts" && <ShortcutsPanel onClose={() => setModal(null)} />}
      {modal === "templates" && <TemplatesPanel onClose={() => setModal(null)} onStatus={flashStatus} />}
      {modal === "motionTrack" && <MotionTrackPanel onClose={() => setModal(null)} onStatus={flashStatus} />}
      {modal === "export" && <ExportPanel onClose={() => setModal(null)} onStatus={flashStatus} />}
      {modal === "sounds" && <SoundsPanel onClose={() => setModal(null)} onStatus={flashStatus} />}
      {modal === "projects" && <ProjectsPanel onClose={() => setModal(null)} onStatus={flashStatus} />}
    </div>
  );
};
