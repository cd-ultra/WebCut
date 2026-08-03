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
export type MarkerId = string & { readonly __brand: "MarkerId" };

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

// ---------------------------------------------------------------------------
// Color grade (primary correction applied in the compositor after keying)
// ---------------------------------------------------------------------------

/**
 * Per-clip primary grade. Lift/gamma/gain follow an ASC-CDL-style pipeline
 * (out = pow(clamp(in*gain + lift), 1/gamma)), followed by brightness/contrast,
 * saturation, and a simple temperature/tint white balance. All fields default
 * to identity (no visual change).
 */
/** A control point on a tone curve; both axes normalized to [0,1]. */
export type CurvePoint = readonly [number, number];

/** Per-channel tone curves (master applies to luma/all channels, then R/G/B). */
export interface GradeCurves {
  readonly master: readonly CurvePoint[];
  readonly red: readonly CurvePoint[];
  readonly green: readonly CurvePoint[];
  readonly blue: readonly CurvePoint[];
}

/** The neutral curve: a straight line from (0,0) to (1,1). */
export const identityCurveChannel = (): readonly CurvePoint[] => [
  [0, 0],
  [1, 1],
];

export const identityCurves = (): GradeCurves => ({
  master: identityCurveChannel(),
  red: identityCurveChannel(),
  green: identityCurveChannel(),
  blue: identityCurveChannel(),
});

const isIdentityCurveChannel = (pts: readonly CurvePoint[]): boolean =>
  pts.length === 2 &&
  pts[0][0] === 0 && pts[0][1] === 0 &&
  pts[1][0] === 1 && pts[1][1] === 1;

export const isIdentityCurves = (c: GradeCurves): boolean =>
  isIdentityCurveChannel(c.master) &&
  isIdentityCurveChannel(c.red) &&
  isIdentityCurveChannel(c.green) &&
  isIdentityCurveChannel(c.blue);

/**
 * A single HSL qualifier (secondary correction): pixels whose hue falls within
 * a band around `centerHue` are shifted/re-saturated/re-lit, feathered by the
 * band's soft edges. Identity when the shifts are all neutral.
 */
export interface HslQualifier {
  /** Band center, degrees [0,360). */
  readonly centerHue: number;
  /** Half-width of the fully-selected band, degrees. */
  readonly hueWidth: number;
  /** Soft feather beyond the band, degrees. */
  readonly softness: number;
  /** Hue rotation applied to selected pixels, degrees. */
  readonly hueShift: number;
  /** Saturation multiplier for selected pixels (1 = unchanged). */
  readonly satScale: number;
  /** Lightness multiplier for selected pixels (1 = unchanged). */
  readonly lumScale: number;
}

export const identityHsl = (): HslQualifier => ({
  centerHue: 180,
  hueWidth: 30,
  softness: 15,
  hueShift: 0,
  satScale: 1,
  lumScale: 1,
});

export const isIdentityHsl = (h: HslQualifier): boolean =>
  h.hueShift === 0 && h.satScale === 1 && h.lumScale === 1;

export interface ColorGrade {
  readonly lift: readonly [number, number, number];
  readonly gamma: readonly [number, number, number];
  readonly gain: readonly [number, number, number];
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly temperature: number;
  readonly tint: number;
  /** RGB/luma tone curves; absent ⇒ identity. */
  readonly curves?: GradeCurves;
  /** HSL secondary qualifier; absent ⇒ identity. */
  readonly hsl?: HslQualifier;
  /**
   * Reference to a 3D LUT registered in the LUT registry (see effects/lut.ts).
   * Absent ⇒ no LUT. The referenced bytes live outside the serialized project,
   * so a LUT must be re-imported after a reload.
   */
  readonly lut3dId?: string;
  /** Human label of the applied LUT (kept for display after reload). */
  readonly lut3dName?: string;
}

export const identityGrade = (): ColorGrade => ({
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  brightness: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
});

/** True when a grade would produce no visual change (lets the shader skip it). */
export const isIdentityGrade = (g: ColorGrade): boolean =>
  g.lift[0] === 0 && g.lift[1] === 0 && g.lift[2] === 0 &&
  g.gamma[0] === 1 && g.gamma[1] === 1 && g.gamma[2] === 1 &&
  g.gain[0] === 1 && g.gain[1] === 1 && g.gain[2] === 1 &&
  g.brightness === 0 && g.contrast === 1 && g.saturation === 1 &&
  g.temperature === 0 && g.tint === 0 &&
  (!g.curves || isIdentityCurves(g.curves)) &&
  (!g.hsl || isIdentityHsl(g.hsl)) &&
  !g.lut3dId;

/** A named, reusable grade preset (persisted to localStorage by the UI). */
export interface GradePreset {
  readonly id: string;
  readonly name: string;
  readonly grade: ColorGrade;
}

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
    }
  | {
      readonly id: EffectId;
      readonly type: "sharpen";
      readonly enabled: boolean;
      /** amount 0..3 (multiplier on the unsharp-mask high-pass). */
      readonly params: { readonly amount: AnimatableValue<number> };
    };

/** Effect kinds selectable from the "Add effect" UI. */
export type EffectType = Effect["type"];

/**
 * Reduce a clip's active effects into a single flat set of shader parameters.
 * Multiple instances of the same effect type sum (radius/amount) or take the
 * latest value (brightness/contrast). Disabled effects contribute nothing.
 */
export interface EffectParams {
  /** Additive brightness applied AFTER the grade pass (-1..+1). */
  readonly brightnessDelta: number;
  /** Multiplicative contrast applied AFTER the grade pass (~0..3, 1 = neutral). */
  readonly contrastMul: number;
  /** Total blur radius in pixels (0 = disabled). Clamped at the shader. */
  readonly blurRadiusPx: number;
  /** Unsharp-mask amount (0 = disabled). */
  readonly sharpenAmount: number;
}

export const identityEffectParams = (): EffectParams => ({
  brightnessDelta: 0,
  contrastMul: 1,
  blurRadiusPx: 0,
  sharpenAmount: 0,
});

export const reduceEffects = (effects: readonly Effect[], localFrame: number): EffectParams => {
  let brightness = 0;
  let contrast = 1;
  let blur = 0;
  let sharpen = 0;
  for (const e of effects) {
    if (!e.enabled) continue;
    if (e.type === "brightness-contrast") {
      brightness += sampleAnimatable(e.params.brightness, localFrame);
      contrast *= sampleAnimatable(e.params.contrast, localFrame);
    } else if (e.type === "gaussian-blur") {
      blur += Math.max(0, sampleAnimatable(e.params.radiusPx, localFrame));
    } else if (e.type === "sharpen") {
      sharpen += Math.max(0, sampleAnimatable(e.params.amount, localFrame));
    }
  }
  return { brightnessDelta: brightness, contrastMul: contrast, blurRadiusPx: blur, sharpenAmount: sharpen };
};

export const isIdentityEffectParams = (p: EffectParams): boolean =>
  p.brightnessDelta === 0 && p.contrastMul === 1 && p.blurRadiusPx === 0 && p.sharpenAmount === 0;

// ---------------------------------------------------------------------------
// Media assets
// ---------------------------------------------------------------------------

export type MediaKind = "video" | "audio" | "image" | "sequence";

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
  /**
   * Nested sequence (#50). Present when `kind === "sequence"` — an immutable
   * snapshot of another Project. The sequence renders its overlays + image
   * clips to a bitmap per frame and is composited as a normal layer source.
   * Video clips inside a nested sequence are NOT rendered in this MVP.
   */
  readonly nestedProject?: Project;
  /**
   * Proxy media (#51): a smaller, faster-to-decode copy generated from the
   * source. Preview uses it when available; export always reads the original.
   * Absent ⇒ no proxy has been generated (or generation failed / was skipped).
   */
  readonly proxyHandleKey?: string;
  /** Width of the proxy, when present. */
  readonly proxyWidth?: number;
  /** Height of the proxy, when present. */
  readonly proxyHeight?: number;
}

// ---------------------------------------------------------------------------
// Gradients & blend modes
// ---------------------------------------------------------------------------

export interface GradientStop {
  /** Position along the gradient, 0..1. */
  readonly at: number;
  readonly color: string;
}

export interface GradientFill {
  readonly kind: "linear" | "radial";
  /** Angle in degrees for linear gradients. */
  readonly angle: number;
  readonly stops: readonly GradientStop[];
}

export const GRADIENT_PRESETS: readonly { readonly label: string; readonly fill: GradientFill }[] = [
  { label: "Sunset", fill: { kind: "linear", angle: 90, stops: [{ at: 0, color: "#ff8f5e" }, { at: 1, color: "#c840a0" }] } },
  { label: "Ocean", fill: { kind: "linear", angle: 90, stops: [{ at: 0, color: "#2e78ff" }, { at: 1, color: "#33d0c0" }] } },
  { label: "Grape", fill: { kind: "linear", angle: 135, stops: [{ at: 0, color: "#7a4fe0" }, { at: 1, color: "#e04f9e" }] } },
  { label: "Mint", fill: { kind: "linear", angle: 90, stops: [{ at: 0, color: "#1fce8f" }, { at: 1, color: "#0f8f6f" }] } },
  { label: "Ember", fill: { kind: "radial", angle: 0, stops: [{ at: 0, color: "#ffd15e" }, { at: 1, color: "#e0451f" }] } },
  { label: "Slate", fill: { kind: "linear", angle: 90, stops: [{ at: 0, color: "#3a4152" }, { at: 1, color: "#12151c" }] } },
];

/** Per-item compositing blend mode. "normal" is the default premultiplied over. */
export type BlendMode = "normal" | "multiply" | "screen" | "add";

export const BLEND_MODES: readonly BlendMode[] = ["normal", "multiply", "screen", "add"];

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
  /** Compositing blend mode; absent ⇒ "normal". */
  readonly blendMode?: BlendMode;
}

/**
 * A visual transition applied at a clip edge. `frames` is the transition's
 * total duration; a crossfade of N frames means the two clips overlap on the
 * timeline for N frames and the outgoing/incoming alpha ramps across them.
 * Wipes ramp a directional edge across the frame instead of alpha.
 */
export type TransitionKind = "fade" | "wipe-left" | "wipe-right" | "wipe-up" | "wipe-down";

export interface Transition {
  readonly kind: TransitionKind;
  readonly frames: number;
}

/**
 * Shape mask (#13). Points are in NORMALIZED clip-frame coords: (0,0) is the
 * top-left of the source frame, (1,1) is the bottom-right. Rectangles/ellipses
 * use exactly two points (opposing corners of the axis-aligned bounding box).
 * Polygons use N points (max ~32) evaluated in the shader via winding number.
 */
export type MaskShape = "rect" | "ellipse" | "polygon";

/**
 * Rotoscoping keyframe (#60): a snapshot of the mask's vertex positions at a
 * specific clip-local frame. Vertex counts must match across keyframes — the
 * evaluator interpolates each vertex 1:1 by index. `mask.points` acts as the
 * "current edit" snapshot; it's not consulted for playback when keyframes exist.
 */
export interface MaskKeyframe {
  readonly frame: number;
  readonly points: readonly Vec2[];
}

export interface ShapeMask {
  readonly shape: MaskShape;
  readonly points: readonly Vec2[];
  /** Invert the mask (keep everything OUTSIDE the shape). */
  readonly inverted: boolean;
  /** Soft edge, in normalized units (0..0.2 typical). */
  readonly feather: number;
  /**
   * Rotoscoping (#60): if present and non-empty, per-frame vertex positions
   * are interpolated across these snapshots rather than using `points`.
   * Absent ⇒ static mask (`points`).
   */
  readonly keyframes?: readonly MaskKeyframe[];
}

export const identityRectMask = (): ShapeMask => ({
  shape: "rect",
  points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }],
  inverted: false,
  feather: 0.02,
});

export const identityEllipseMask = (): ShapeMask => ({
  shape: "ellipse",
  points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }],
  inverted: false,
  feather: 0.02,
});

export interface ClipItem extends TrackItemBase {
  readonly type: "clip";
  readonly assetId: MediaAssetId;
  /** Transition applied to this clip's leading edge (overlaps the previous clip). */
  readonly transitionIn?: Transition;
  /** Transition applied to this clip's trailing edge (overlaps the next clip). */
  readonly transitionOut?: Transition;
  /** In-point inside the source media (frames). Supports slip edits. */
  readonly sourceInFrame: number;
  /** Playback rate; 1 = realtime, negative values are reversed playback. */
  readonly speed: number;
  /**
   * Speed ramp: a keyframed speed multiplier over the clip's local frames.
   * When present it overrides the flat `speed` for source mapping and preview
   * playback rate. Absent ⇒ constant `speed`.
   */
  readonly speedRamp?: AnimatableValue<number>;
  readonly audioGainDb: number;
  /**
   * Keyframed gain automation in dB over local frames (e.g. auto-ducking).
   * When present it is summed with `audioGainDb`. Absent ⇒ flat gain.
   */
  readonly gainRamp?: AnimatableValue<number>;
  /**
   * Noise-reduction strength 0..1 (#58). Applied via spectral subtraction in
   * the export mixdown. 0 / absent ⇒ no processing. Preview is unaffected
   * (there's no live audio-processing graph yet).
   */
  readonly denoiseStrength?: number;
  readonly audioMuted: boolean;
  /** Primary color grade; absent ⇒ identity (no correction). */
  readonly grade?: ColorGrade;
  /** Shape mask (#13). Absent ⇒ no mask. */
  readonly mask?: ShapeMask;
  /**
   * Multicam angles (#49). When present the resolver samples `angleSelection`
   * per frame and renders `angles[selection]` instead of `assetId`. The clip's
   * own `assetId` is used as a fallback / for asset-metadata (duration, etc.).
   * `angleSelection` uses hold interpolation to make angle cuts hard-switched.
   */
  readonly multicam?: {
    readonly angles: readonly MediaAssetId[];
    readonly angleSelection: AnimatableValue<number>;
  };
}

export interface ShapeItem extends TrackItemBase {
  readonly type: "shape";
  readonly shape: "rectangle" | "ellipse" | "line";
  readonly fillColor: string;
  /** When present, overrides fillColor with a gradient. */
  readonly fillGradient?: GradientFill;
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
  readonly fillGradient?: GradientFill;
  readonly alignment: "left" | "center" | "right";
  readonly lineHeight: number;
}

export interface StickerItem extends TrackItemBase {
  readonly type: "sticker";
  /** An emoji glyph (or short string) rendered as an overlay graphic. */
  readonly content: string;
}

/** Audio waveform / spectrum visualizer overlay (#65). */
export interface AudioVizItem extends TrackItemBase {
  readonly type: "audioviz";
  /** The audio (or video-with-audio) asset whose waveform drives the visual. */
  readonly assetId: MediaAssetId;
  readonly style: "bars" | "wave" | "mirror";
  readonly color: string;
  /** Number of bars/samples drawn across the width. */
  readonly barCount: number;
}

export type TrackItem = ClipItem | ShapeItem | TextItem | StickerItem | AudioVizItem;
export type OverlayItem = TextItem | ShapeItem | StickerItem | AudioVizItem;

/** True for items composited as overlays (rendered from vector/text, not media). */
export const isOverlayItem = (item: TrackItem): item is OverlayItem =>
  item.type === "text" || item.type === "shape" || item.type === "sticker" || item.type === "audioviz";

/** Factory: an audio waveform visualizer overlay. */
export const makeAudioVizItem = (
  assetId: MediaAssetId,
  startFrame: number,
  durationFrames: number,
): Omit<AudioVizItem, "id"> => ({
  type: "audioviz",
  name: "Audio viz",
  startFrame,
  durationFrames,
  transform: identityTransform(),
  effects: [],
  locked: false,
  assetId,
  style: "bars",
  color: "#4f8cff",
  barCount: 48,
});

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

/** Factory: an emoji/graphic sticker overlay. */
export const makeStickerItem = (
  content: string,
  startFrame: number,
  durationFrames: number,
): Omit<StickerItem, "id"> => ({
  type: "sticker",
  name: "Sticker",
  startFrame,
  durationFrames,
  transform: identityTransform(),
  effects: [],
  locked: false,
  content,
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
  /** Track-level audio trim in dB (mixer fader), summed with per-clip gain. Absent ⇒ 0. */
  readonly gainDb?: number;
  /** Stereo pan, -1 (hard left) … +1 (hard right). Absent ⇒ 0 (center). */
  readonly pan?: number;
  /** Optional custom color used to tint the track lane and clips. */
  readonly color?: string;
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
  /** When set, a gradient fills the canvas behind all layers. */
  readonly backgroundGradient?: GradientFill;
}

// ---------------------------------------------------------------------------
// Subtitles / captions
// ---------------------------------------------------------------------------

export type SubtitleId = string & { readonly __brand: "SubtitleId" };

export interface Subtitle {
  readonly id: SubtitleId;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly text: string;
}

export interface SubtitleStyle {
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly fillColor: string;
  readonly backgroundColor: string;
  /** Vertical position as a fraction of canvas height (0 = top, 1 = bottom). */
  readonly positionY: number;
}

export const defaultSubtitleStyle = (): SubtitleStyle => ({
  fontFamily: "Inter, system-ui, sans-serif",
  fontSizePx: 48,
  fillColor: "#ffffff",
  backgroundColor: "#000000a0",
  positionY: 0.86,
});

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

/** A timeline bookmark at a given frame, with an optional label and color. */
export interface Marker {
  readonly id: MarkerId;
  readonly frame: number;
  readonly label: string;
  readonly color: string;
}

export const MARKER_COLORS: readonly string[] = [
  "#e0b65f",
  "#4f8cff",
  "#5fd0a0",
  "#e06f9e",
  "#b07fe0",
  "#e07f5f",
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
  readonly markers: readonly Marker[];
  readonly subtitles: readonly Subtitle[];
  readonly subtitleStyle: SubtitleStyle;
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
    markers: [],
    subtitles: [],
    subtitleStyle: defaultSubtitleStyle(),
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

// ---------------------------------------------------------------------------
// Rotoscoping keyframe evaluation (#60)
// ---------------------------------------------------------------------------

/**
 * Evaluate a mask's per-frame vertex positions. Returns `mask.points` verbatim
 * when the mask isn't animated. When animated, linearly interpolates each
 * vertex between neighboring keyframes; before the first or after the last
 * keyframe, returns that end's snapshot.
 */
export const sampleMaskPoints = (mask: ShapeMask, localFrame: number): readonly Vec2[] => {
  const kfs = mask.keyframes;
  if (!kfs || kfs.length === 0) return mask.points;
  if (kfs.length === 1) return kfs[0].points;
  if (localFrame <= kfs[0].frame) return kfs[0].points;
  const last = kfs[kfs.length - 1];
  if (localFrame >= last.frame) return last.points;
  // Locate the surrounding pair.
  let lo = 0;
  let hi = kfs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].frame <= localFrame) lo = mid;
    else hi = mid;
  }
  const a = kfs[lo];
  const b = kfs[hi];
  const span = b.frame - a.frame;
  const t = span === 0 ? 0 : (localFrame - a.frame) / span;
  const n = Math.min(a.points.length, b.points.length);
  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = a.points[i];
    const q = b.points[i];
    out[i] = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  }
  return out;
};

// ---------------------------------------------------------------------------
// Speed ramping
// ---------------------------------------------------------------------------

/** Instantaneous playback speed at a clip-local frame (respects a speed ramp). */
export const sampleClipSpeed = (clip: ClipItem, localFrame: number): number => {
  if (clip.speedRamp) return sampleAnimatable(clip.speedRamp, localFrame);
  return clip.speed;
};

/**
 * Source-media offset (in source frames, relative to `sourceInFrame`) reached
 * after `localFrame` timeline frames, integrating a possibly-ramped speed.
 * For a constant speed this collapses to `localFrame * speed`. The integral is
 * accumulated per whole frame — cheap, and exact for piecewise-linear ramps at
 * frame granularity.
 */
export const integrateClipSource = (clip: ClipItem, localFrame: number): number => {
  if (!clip.speedRamp || clip.speedRamp.kind === "static") {
    return localFrame * sampleClipSpeed(clip, 0);
  }
  const whole = Math.max(0, Math.floor(localFrame));
  let acc = 0;
  for (let f = 0; f < whole; f++) {
    // Midpoint speed of frame f keeps the sum symmetric under reversal.
    acc += sampleAnimatable(clip.speedRamp, f + 0.5);
  }
  const frac = localFrame - whole;
  if (frac > 0) acc += sampleAnimatable(clip.speedRamp, whole + frac * 0.5) * frac;
  return acc;
};
