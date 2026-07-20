/**
 * WebCut — Timeline domain model.
 *
 * Every duration/position is expressed in integer frames at the project frame
 * rate. Frames (not seconds) are the atomic unit of an NLE: integer math keeps
 * playhead snapping, clip trimming, and keyframe lookup exact and immune to
 * floating-point drift during long edits.
 */

/** Branded ID types prevent cross-assigning identifiers between entities. */
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type TrackId = string & { readonly __brand: "TrackId" };
export type TrackItemId = string & { readonly __brand: "TrackItemId" };
export type MediaAssetId = string & { readonly __brand: "MediaAssetId" };
export type EffectId = string & { readonly __brand: "EffectId" };
export type KeyframeId = string & { readonly __brand: "KeyframeId" };

export const createId = <T extends string>(): T =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`) as T;

// ---------------------------------------------------------------------------
// Keyframes & interpolation
// ---------------------------------------------------------------------------

export type InterpolationMode = "linear" | "bezier" | "hold";

/** Cubic-bezier easing handles, normalized to the [0,1] segment between two keyframes. */
export interface BezierHandles {
  /** Outgoing handle of this keyframe (x1, y1). x clamped to [0,1]. */
  readonly out: readonly [number, number];
  /** Incoming handle of the next keyframe (x2, y2). x clamped to [0,1]. */
  readonly in: readonly [number, number];
}

export interface Keyframe<V = number> {
  readonly id: KeyframeId;
  /** Frame offset relative to the owning TrackItem's start. */
  readonly frame: number;
  readonly value: V;
  readonly interpolation: InterpolationMode;
  /** Required when interpolation === "bezier". */
  readonly bezier?: BezierHandles;
}

/** An animatable scalar: a static value or a keyframe curve. */
export type AnimatableValue<V = number> =
  | { readonly kind: "static"; readonly value: V }
  | { readonly kind: "animated"; readonly keyframes: readonly Keyframe<V>[] };

export const staticValue = <V>(value: V): AnimatableValue<V> => ({ kind: "static", value });

// ---------------------------------------------------------------------------
// Spatial transform
// ---------------------------------------------------------------------------

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * 2D transform applied in the compositor. Position is in project pixels
 * relative to canvas center; anchor is normalized [0,1] within the item's own
 * bounds; rotation in degrees; scale 1.0 = 100%.
 */
export interface Transform {
  readonly position: AnimatableValue<Vec2>;
  readonly scale: AnimatableValue<Vec2>;
  readonly rotation: AnimatableValue<number>;
  readonly anchorPoint: AnimatableValue<Vec2>;
  readonly opacity: AnimatableValue<number>;
}

export const identityTransform = (): Transform => ({
  position: staticValue({ x: 0, y: 0 }),
  scale: staticValue({ x: 1, y: 1 }),
  rotation: staticValue(0),
  anchorPoint: staticValue({ x: 0.5, y: 0.5 }),
  opacity: staticValue(1),
});

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * Uniform block consumed by the CorridorKey WGSL shader. Field order mirrors
 * the std140-style uniform struct in src/effects/CorridorKeyShader.ts — keep
 * the two in sync when adding parameters.
 */
export interface CorridorKeyParams {
  /** Key color in linear RGB, each channel [0,1]. */
  readonly keyColor: readonly [number, number, number];
  /** Chroma distance below which a pixel is fully transparent. [0,1] */
  readonly similarity: number;
  /** Soft range above similarity over which alpha ramps to opaque. [0,1] */
  readonly smoothness: number;
  /** Erodes the matte boundary inward (in normalized chroma units). [0,0.5] */
  readonly edgeErosion: number;
  /** Gaussian-style feather radius applied to the matte edge, in pixels. */
  readonly featherRadiusPx: number;
  /** Strength of spill suppression / color unmixing on boundary pixels. [0,1] */
  readonly spillSuppression: number;
  /** Blend weight between procedural chroma matte and the ONNX neural matte. [0,1] */
  readonly neuralMatteMix: number;
  /** When true, the renderer binds the ONNX-produced alpha mask texture. */
  readonly useNeuralMatte: boolean;
}

export const defaultCorridorKeyParams = (): CorridorKeyParams => ({
  keyColor: [0.102, 0.784, 0.196], // canonical green screen, linearized
  similarity: 0.32,
  smoothness: 0.08,
  edgeErosion: 0.02,
  featherRadiusPx: 1.5,
  spillSuppression: 0.85,
  neuralMatteMix: 0.5,
  useNeuralMatte: false,
});

export type Effect =
  | {
      readonly id: EffectId;
      readonly type: "corridor-key";
      readonly enabled: boolean;
      readonly params: CorridorKeyParams;
    }
  | {
      readonly id: EffectId;
      readonly type: "brightness-contrast";
      readonly enabled: boolean;
      readonly params: { readonly brightness: AnimatableValue<number>; readonly contrast: AnimatableValue<number> };
    }
  | {
      readonly id: EffectId;
      readonly type: "gaussian-blur";
      readonly enabled: boolean;
      readonly params: { readonly radiusPx: AnimatableValue<number> };
    };

// ---------------------------------------------------------------------------
// Media assets
// ---------------------------------------------------------------------------

export type MediaKind = "video" | "audio" | "image";

export interface MediaAsset {
  readonly id: MediaAssetId;
  readonly kind: MediaKind;
  readonly name: string;
  /**
   * Serialized reference to a FileSystemFileHandle persisted in IndexedDB.
   * Local-first: we never copy media — we re-acquire the handle on load.
   */
  readonly handleKey: string;
  readonly durationFrames: number;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly mimeType: string;
  readonly fileSizeBytes: number;
}

// ---------------------------------------------------------------------------
// Track items
// ---------------------------------------------------------------------------

interface TrackItemBase {
  readonly id: TrackItemId;
  readonly name: string;
  /** Timeline frame at which the item begins. */
  readonly startFrame: number;
  /** Item length on the timeline, in frames. Always > 0. */
  readonly durationFrames: number;
  readonly transform: Transform;
  readonly effects: readonly Effect[];
  readonly locked: boolean;
}

export interface ClipItem extends TrackItemBase {
  readonly type: "clip";
  readonly assetId: MediaAssetId;
  /** In-point inside the source media (frames). Supports slip edits. */
  readonly sourceInFrame: number;
  /** Playback rate; 1 = realtime, negative values are reversed playback. */
  readonly speed: number;
  readonly audioGainDb: number;
  readonly audioMuted: boolean;
}

export interface ShapeItem extends TrackItemBase {
  readonly type: "shape";
  readonly shape: "rectangle" | "ellipse" | "line";
  readonly fillColor: string;
  readonly strokeColor: string;
  readonly strokeWidthPx: number;
  readonly cornerRadiusPx: number;
}

export interface TextItem extends TrackItemBase {
  readonly type: "text";
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly fontWeight: number;
  readonly fillColor: string;
  readonly alignment: "left" | "center" | "right";
  readonly lineHeight: number;
}

export type TrackItem = ClipItem | ShapeItem | TextItem;

/** True for items composited as overlays (rendered from vector/text, not media). */
export const isOverlayItem = (item: TrackItem): item is TextItem | ShapeItem =>
  item.type === "text" || item.type === "shape";

/** Factory: a text overlay with sensible defaults, ready for `addItemToTrack`. */
export const makeTextItem = (startFrame: number, durationFrames: number): Omit<TextItem, "id"> => ({
  type: "text",
  name: "Text",
  startFrame,
  durationFrames,
  transform: identityTransform(),
  effects: [],
  locked: false,
  text: "New text",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSizePx: 96,
  fontWeight: 700,
  fillColor: "#ffffff",
  alignment: "center",
  lineHeight: 1.2,
});

/** Factory: a shape overlay with sensible defaults, ready for `addItemToTrack`. */
export const makeShapeItem = (
  shape: ShapeItem["shape"],
  startFrame: number,
  durationFrames: number,
): Omit<ShapeItem, "id"> => ({
  type: "shape",
  name: shape.charAt(0).toUpperCase() + shape.slice(1),
  startFrame,
  durationFrames,
  transform: identityTransform(),
  effects: [],
  locked: false,
  shape,
  fillColor: "#4f8cff",
  strokeColor: "#ffffff",
  strokeWidthPx: 0,
  cornerRadiusPx: 0,
});

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export type TrackKind = "video" | "audio" | "adjustment";

export interface Track {
  readonly id: TrackId;
  readonly kind: TrackKind;
  readonly name: string;
  /** Render order: index 0 composites at the bottom of the stack. */
  readonly index: number;
  readonly items: readonly TrackItem[];
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly locked: boolean;
  readonly hidden: boolean;
  readonly heightPx: number;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface ProjectSettings {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly sampleRate: number;
  readonly backgroundColor: string;
}

/** Common canvas presets for quick aspect-ratio switching. */
export interface AspectPreset {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  { label: "16:9 · 1920×1080", width: 1920, height: 1080 },
  { label: "9:16 · 1080×1920", width: 1080, height: 1920 },
  { label: "1:1 · 1080×1080", width: 1080, height: 1080 },
  { label: "4:5 · 1080×1350", width: 1080, height: 1350 },
  { label: "4:3 · 1440×1080", width: 1440, height: 1080 },
  { label: "21:9 · 2560×1080", width: 2560, height: 1080 },
];

export interface Project {
  readonly id: ProjectId;
  readonly schemaVersion: 1;
  readonly name: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly settings: ProjectSettings;
  readonly assets: readonly MediaAsset[];
  readonly tracks: readonly Track[];
}

export const createEmptyProject = (name = "Untitled Project"): Project => {
  const now = new Date().toISOString();
  return {
    id: createId<ProjectId>(),
    schemaVersion: 1,
    name,
    createdAt: now,
    modifiedAt: now,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      backgroundColor: "#000000",
    },
    assets: [],
    tracks: [
      {
        id: createId<TrackId>(),
        kind: "video",
        name: "V1",
        index: 0,
        items: [],
        muted: false,
        soloed: false,
        locked: false,
        hidden: false,
        heightPx: 56,
      },
      {
        id: createId<TrackId>(),
        kind: "audio",
        name: "A1",
        index: 1,
        items: [],
        muted: false,
        soloed: false,
        locked: false,
        hidden: false,
        heightPx: 40,
      },
    ],
  };
};

// ---------------------------------------------------------------------------
// Keyframe evaluation
// ---------------------------------------------------------------------------

const cubicBezierY = (x: number, x1: number, y1: number, x2: number, y2: number): number => {
  // Newton-Raphson solve for t given x, then evaluate y(t).
  let t = x;
  for (let i = 0; i < 6; i++) {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const xt = ((ax * t + bx) * t + cx) * t - x;
    const dxt = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(dxt) < 1e-7) break;
    t -= xt / dxt;
    t = Math.min(1, Math.max(0, t));
  }
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  return ((ay * t + by) * t + cy) * t;
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const lerpValue = <V>(a: V, b: V, t: number): V => {
  if (typeof a === "number" && typeof b === "number") {
    return lerp(a, b, t) as V;
  }
  const va = a as unknown as Vec2;
  const vb = b as unknown as Vec2;
  if (typeof va?.x === "number" && typeof vb?.x === "number") {
    return { x: lerp(va.x, vb.x, t), y: lerp(va.y, vb.y, t) } as V;
  }
  return t < 1 ? a : b;
};

/** Sample an animatable value at a local frame (relative to item start). */
export const sampleAnimatable = <V>(animatable: AnimatableValue<V>, frame: number): V => {
  if (animatable.kind === "static") return animatable.value;
  const keys = animatable.keyframes;
  if (keys.length === 0) {
    throw new Error("Animated value must contain at least one keyframe");
  }
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;

  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].frame <= frame) lo = mid;
    else hi = mid;
  }
  const k0 = keys[lo];
  const k1 = keys[hi];
  if (k0.interpolation === "hold") return k0.value;

  const span = k1.frame - k0.frame;
  const rawT = span === 0 ? 1 : (frame - k0.frame) / span;
  let easedT = rawT;
  if (k0.interpolation === "bezier" && k0.bezier) {
    const [x1, y1] = k0.bezier.out;
    const [x2, y2] = k0.bezier.in;
    easedT = cubicBezierY(rawT, x1, y1, x2, y2);
  }
  return lerpValue(k0.value, k1.value, easedT);
};

export const framesToTimecode = (frame: number, fps: number): string => {
  const totalSeconds = Math.floor(frame / fps);
  const ff = Math.floor(frame % fps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
};
