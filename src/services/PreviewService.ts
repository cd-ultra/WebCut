/**
 * WebCut — PreviewService: timeline → pixels.
 *
 * Resolves the topmost visible video/image clip under the playhead and feeds
 * decoded frames into the WebGPU compositor (the FrameSink registered by
 * VideoPlayer). Decode strategy for preview is the browser's native media
 * stack via hidden <video> elements — hardware-accelerated, zero demux code —
 * while the WebCodecs DecodeBridge remains the frame-exact path for export.
 *
 * Modes:
 *  - Scrub/paused: seek the element to the mapped media time; push on `seeked`.
 *  - Playing: play() the element at clip speed; requestVideoFrameCallback
 *    pushes each presented frame and drift-corrects against the transport.
 */

import { fileSystemService } from "./FileSystemService";
import { transport, useTimelineStore } from "../store/timelineStore";
import {
  defaultCorridorKeyParams,
  isOverlayItem,
  sampleAnimatable,
  type BlendMode,
  type ClipItem,
  type CorridorKeyParams,
  type GradientFill,
  type MediaAsset,
  type MediaAssetId,
  type OverlayItem,
  type Project,
  type ProjectSettings,
  type ShapeItem,
  type StickerItem,
  type SubtitleStyle,
  type TextItem,
  type Vec2,
} from "../types/timeline";

interface SampledTransform {
  readonly pos: Vec2;
  readonly scale: Vec2;
  readonly rotation: number;
  readonly opacity: number;
}

export interface FrameSink {
  ingestLayerFrame(layerId: string, frame: VideoFrame | HTMLVideoElement | ImageBitmap, order: number): void;
  setLayerEffect(layerId: string, enabled: boolean, params: CorridorKeyParams): void;
  setLayerBlend(layerId: string, mode: BlendMode): void;
  /** Reconcile live layers; anything absent from the list is destroyed. */
  syncLayers(activeLayerIds: readonly string[]): void;
}

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

interface ActiveLayerClip {
  readonly clip: ClipItem;
  readonly asset: MediaAsset;
  readonly trackId: string;
  readonly trackMuted: boolean;
  /** Compositing order: ascending = bottom -> top. */
  readonly order: number;
}

interface ActiveOverlay {
  readonly item: OverlayItem;
  /** Own layer id (per-item, so multiple overlays can share a track). */
  readonly layerId: string;
  readonly order: number;
}

/** Max playhead/element drift before a hard re-seek during playback (seconds). */
const DRIFT_TOLERANCE_S = 0.12;

const resolveActiveClips = (project: Project, frame: number): ActiveLayerClip[] => {
  const wholeFrame = Math.floor(frame);
  // Every visible video track contributes one layer, bottom (index 0) first;
  // upper layers composite over lower ones with premultiplied alpha, so a
  // keyed clip on V2 reveals V1 through its transparent matte.
  const visualTracks = project.tracks
    .filter((track) => track.kind === "video" && !track.hidden)
    .sort((a, b) => a.index - b.index);
  const layers: ActiveLayerClip[] = [];
  for (const track of visualTracks) {
    for (const item of track.items) {
      if (item.type !== "clip") continue;
      if (wholeFrame < item.startFrame || wholeFrame >= item.startFrame + item.durationFrames) continue;
      const asset = project.assets.find((candidate) => candidate.id === item.assetId);
      if (!asset || asset.kind === "audio") continue;
      layers.push({ clip: item, asset, trackId: track.id, trackMuted: track.muted, order: track.index });
      break;
    }
  }
  return layers;
};

/** Text/shape overlays under the playhead, each its own compositing layer. */
const resolveActiveOverlays = (project: Project, frame: number): ActiveOverlay[] => {
  const wholeFrame = Math.floor(frame);
  const overlays: ActiveOverlay[] = [];
  const visualTracks = project.tracks
    .filter((track) => track.kind === "video" && !track.hidden)
    .sort((a, b) => a.index - b.index);
  for (const track of visualTracks) {
    let localIndex = 0;
    for (const item of track.items) {
      if (!isOverlayItem(item)) continue;
      if (wholeFrame < item.startFrame || wholeFrame >= item.startFrame + item.durationFrames) continue;
      // Overlays composite above clips on the same track; later items on top.
      overlays.push({ item, layerId: item.id, order: track.index + 0.5 + localIndex * 0.001 });
      localIndex += 1;
    }
  }
  return overlays;
};

/** Linear gain [0,1] from a dB value, clamped to what an <audio> element allows. */
const dbToVolume = (gainDb: number): number => Math.min(1, Math.max(0, Math.pow(10, gainDb / 20)));

const corridorKeyOf = (clip: ClipItem): { enabled: boolean; params: CorridorKeyParams } => {
  const effect = clip.effects.find((candidate) => candidate.type === "corridor-key");
  if (effect && effect.type === "corridor-key") {
    return { enabled: effect.enabled, params: effect.params };
  }
  return { enabled: false, params: defaultCorridorKeyParams() };
};

class PreviewService {
  private sink: FrameSink | null = null;
  private videoElements = new Map<string, RVFCVideo>();
  private imageBitmaps = new Map<MediaAssetId, ImageBitmap>();
  private objectUrls = new Map<string, string>();
  /** Rasterized overlays, keyed by item id → { signature, premultiplied bitmap }. */
  private overlayCache = new Map<string, { sig: string; bitmap: ImageBitmap }>();
  private overlayCanvas: HTMLCanvasElement | null = null;

  private rvfcLoops = new Map<RVFCVideo, { handle: number; layerId: string; order: number }>();
  private unsubscribeTransport: (() => void) | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private pendingSync = false;

  registerSink(sink: FrameSink): () => void {
    this.sink = sink;
    this.unsubscribeTransport = transport.subscribe(() => this.scheduleSync());
    this.unsubscribeStore = useTimelineStore.subscribe(
      (state) => state.revision,
      () => this.scheduleSync(),
    );
    this.scheduleSync();
    return () => {
      this.unsubscribeTransport?.();
      this.unsubscribeStore?.();
      this.stopAllRvfcLoops();
      this.sink = null;
    };
  }

  /** Coalesce bursts of transport notifications into one sync per microtask. */
  private scheduleSync(): void {
    if (this.pendingSync) return;
    this.pendingSync = true;
    queueMicrotask(() => {
      this.pendingSync = false;
      void this.sync();
    });
  }

  private async sync(): Promise<void> {
    const sink = this.sink;
    if (!sink) return;

    const { project } = useTimelineStore.getState();
    const frame = transport.getFrame();
    const fps = project.settings.frameRate;
    const actives = resolveActiveClips(project, frame);
    const overlays = resolveActiveOverlays(project, frame);

    const wholeFrame = Math.floor(frame);
    const bgGradient = project.settings.backgroundGradient;
    const activeSubtitle = project.subtitles.find((s) => wholeFrame >= s.startFrame && wholeFrame < s.endFrame);

    const BG_ID = "__bg";
    const SUB_ID = "__subtitle";
    const layerIds = [...actives.map((layer) => layer.trackId), ...overlays.map((o) => o.layerId)];
    if (bgGradient) layerIds.push(BG_ID);
    if (activeSubtitle) layerIds.push(SUB_ID);
    sink.syncLayers(layerIds);

    // Injected background-gradient layer (drawn beneath everything).
    if (bgGradient) {
      sink.setLayerEffect(BG_ID, false, defaultCorridorKeyParams());
      const sig = `bg|${project.settings.width}x${project.settings.height}|${JSON.stringify(bgGradient)}`;
      const bmp = await this.cachedRaster(BG_ID, sig, project.settings, (ctx, w, h) => {
        ctx.fillStyle = backgroundGradientStyle(ctx, bgGradient, w, h);
        ctx.fillRect(0, 0, w, h);
      });
      if (bmp) sink.ingestLayerFrame(BG_ID, bmp, -1);
    }

    // Overlays (text/shape/sticker): rasterize to a premultiplied bitmap and
    // ingest as an alpha layer. The compositor's disabled-key path forwards
    // source alpha, so transparent regions composite correctly.
    const activeOverlayIds = new Set(layerIds);
    this.pruneOverlayCache(activeOverlayIds);
    for (const { item, layerId, order } of overlays) {
      sink.setLayerEffect(layerId, false, defaultCorridorKeyParams());
      sink.setLayerBlend(layerId, item.blendMode ?? "normal");
      const bitmap = await this.getOverlayBitmap(item, project.settings, frame);
      if (bitmap) sink.ingestLayerFrame(layerId, bitmap, order);
    }

    // Injected subtitle layer (drawn above everything).
    if (activeSubtitle) {
      sink.setLayerEffect(SUB_ID, false, defaultCorridorKeyParams());
      const style = project.subtitleStyle;
      const sig = `sub|${project.settings.width}x${project.settings.height}|${activeSubtitle.text}|${JSON.stringify(style)}`;
      const bmp = await this.cachedRaster(SUB_ID, sig, project.settings, (ctx, w, h) =>
        drawSubtitle(ctx, w, h, activeSubtitle.text, style),
      );
      if (bmp) sink.ingestLayerFrame(SUB_ID, bmp, 1_000_000);
    }

    if (actives.length === 0) {
      this.stopAllRvfcLoops();
      this.pauseAllExcept(new Set());
      return;
    }

    const playing = transport.isPlaying();
    const keepVideos = new Set<RVFCVideo>();

    for (const { clip, asset, trackId, trackMuted, order } of actives) {
      const key = corridorKeyOf(clip);
      sink.setLayerEffect(trackId, key.enabled, key.params);
      sink.setLayerBlend(trackId, clip.blendMode ?? "normal");

      if (asset.kind === "image") {
        const bitmap = await this.getImageBitmap(asset);
        if (bitmap) sink.ingestLayerFrame(trackId, bitmap, order);
        continue;
      }

      // Cache per track: the same source file on two tracks needs two
      // independent elements (each layer seeks its own media time).
      const video = await this.getVideoElement(asset, `${trackId}:${asset.handleKey}`);
      if (!video) continue;
      keepVideos.add(video);

      // Per-clip audio: apply gain + mute (track mute overrides).
      video.muted = clip.audioMuted || trackMuted;
      video.volume = dbToVolume(clip.audioGainDb);

      const localFrame = frame - clip.startFrame;
      const mediaTimeS = (clip.sourceInFrame + localFrame * clip.speed) / fps;
      const clampedTimeS = Math.min(Math.max(0, mediaTimeS), Math.max(0, video.duration - 1 / fps));

      if (playing && clip.speed > 0) {
        video.playbackRate = Math.min(16, clip.speed);
        if (Math.abs(video.currentTime - clampedTimeS) > DRIFT_TOLERANCE_S) {
          video.currentTime = clampedTimeS;
        }
        if (video.paused) {
          void video.play().catch(() => {
            /* muted autoplay is permitted; ignore pause races */
          });
        }
        this.ensureRvfcLoop(video, trackId, order);
      } else {
        this.stopRvfcLoop(video);
        if (!video.paused) video.pause();
        if (Math.abs(video.currentTime - clampedTimeS) > 0.5 / fps) {
          video.currentTime = clampedTimeS;
          const pushWhenSeeked = () => {
            if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              this.sink?.ingestLayerFrame(trackId, video, order);
            }
          };
          video.addEventListener("seeked", pushWhenSeeked, { once: true });
        } else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          sink.ingestLayerFrame(trackId, video, order);
        }
      }
    }

    // Retire loops/elements for tracks that no longer have an active clip.
    for (const video of [...this.rvfcLoops.keys()]) {
      if (!keepVideos.has(video)) this.stopRvfcLoop(video);
    }
    this.pauseAllExcept(keepVideos);
  }

  // -- per-presented-frame push during playback ------------------------------

  private ensureRvfcLoop(video: RVFCVideo, layerId: string, order: number): void {
    const existing = this.rvfcLoops.get(video);
    if (existing) {
      existing.layerId = layerId;
      existing.order = order;
      return;
    }
    const entry = { handle: 0, layerId, order };
    this.rvfcLoops.set(video, entry);

    if (typeof video.requestVideoFrameCallback === "function") {
      const onFrame = () => {
        if (this.rvfcLoops.get(video) !== entry) return;
        this.sink?.ingestLayerFrame(entry.layerId, video, entry.order);
        entry.handle = video.requestVideoFrameCallback!(onFrame);
      };
      entry.handle = video.requestVideoFrameCallback(onFrame);
    } else {
      const onTick = () => {
        if (this.rvfcLoops.get(video) !== entry) return;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          this.sink?.ingestLayerFrame(entry.layerId, video, entry.order);
        }
        entry.handle = requestAnimationFrame(onTick);
      };
      entry.handle = requestAnimationFrame(onTick);
    }
  }

  private stopRvfcLoop(video: RVFCVideo): void {
    const entry = this.rvfcLoops.get(video);
    if (!entry) return;
    if (typeof video.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(entry.handle);
    } else {
      cancelAnimationFrame(entry.handle);
    }
    this.rvfcLoops.delete(video);
  }

  private stopAllRvfcLoops(): void {
    for (const video of [...this.rvfcLoops.keys()]) this.stopRvfcLoop(video);
  }

  private pauseAllExcept(keep: ReadonlySet<RVFCVideo>): void {
    for (const video of this.videoElements.values()) {
      if (!keep.has(video) && !video.paused) video.pause();
    }
  }

  // -- element / bitmap caches ------------------------------------------------

  private async getVideoElement(asset: MediaAsset, cacheKey: string): Promise<RVFCVideo | null> {
    const cached = this.videoElements.get(cacheKey);
    if (cached) return cached;
    try {
      const file = await fileSystemService.resolveMediaFile(asset.handleKey);
      const url = URL.createObjectURL(file);
      this.objectUrls.set(cacheKey, url);
      const video = document.createElement("video") as RVFCVideo;
      video.src = url;
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error(`Cannot decode "${asset.name}"`));
      });
      this.videoElements.set(cacheKey, video);
      return video;
    } catch (error) {
      console.error("[WebCut] preview decode failed:", error);
      return null;
    }
  }

  private async getImageBitmap(asset: MediaAsset): Promise<ImageBitmap | null> {
    const cached = this.imageBitmaps.get(asset.id);
    if (cached) return cached;
    try {
      const file = await fileSystemService.resolveMediaFile(asset.handleKey);
      const bitmap = await createImageBitmap(file);
      this.imageBitmaps.set(asset.id, bitmap);
      return bitmap;
    } catch (error) {
      console.error("[WebCut] image decode failed:", error);
      return null;
    }
  }

  // -- overlay rasterization --------------------------------------------------

  private async getOverlayBitmap(
    item: OverlayItem,
    settings: ProjectSettings,
    frame: number,
  ): Promise<ImageBitmap | null> {
    const local = Math.max(0, frame - item.startFrame);
    const t: SampledTransform = {
      pos: sampleAnimatable(item.transform.position, local),
      scale: sampleAnimatable(item.transform.scale, local),
      rotation: sampleAnimatable(item.transform.rotation, local),
      opacity: sampleAnimatable(item.transform.opacity, local),
    };
    const sig = overlaySignature(item, settings, t);
    const cached = this.overlayCache.get(item.id);
    if (cached && cached.sig === sig) return cached.bitmap;
    try {
      const bitmap = await this.rasterizeOverlay(item, settings, t);
      cached?.bitmap.close();
      this.overlayCache.set(item.id, { sig, bitmap });
      return bitmap;
    } catch (error) {
      console.error("[WebCut] overlay render failed:", error);
      return cached?.bitmap ?? null;
    }
  }

  private async rasterizeOverlay(
    item: OverlayItem,
    settings: ProjectSettings,
    t: SampledTransform,
  ): Promise<ImageBitmap> {
    const w = settings.width;
    const h = settings.height;
    let canvas = this.overlayCanvas;
    if (!canvas) {
      canvas = document.createElement("canvas");
      this.overlayCanvas = canvas;
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, t.opacity));
    // Transform: position is relative to canvas center; scale/rotate about it.
    ctx.translate(w / 2 + t.pos.x, h / 2 + t.pos.y);
    ctx.rotate((t.rotation * Math.PI) / 180);
    ctx.scale(t.scale.x, t.scale.y);
    if (item.type === "text") drawTextItem(ctx, item);
    else if (item.type === "shape") drawShapeItem(ctx, item, w, h);
    else drawStickerItem(ctx, item);
    ctx.restore();
    // Premultiply so the compositor's premultiplied "over" blend is correct.
    return createImageBitmap(canvas, { premultiplyAlpha: "premultiply" });
  }

  /** Rasterize a full-canvas layer (background / subtitle) with signature caching. */
  private async cachedRaster(
    key: string,
    sig: string,
    settings: ProjectSettings,
    draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  ): Promise<ImageBitmap | null> {
    const cached = this.overlayCache.get(key);
    if (cached && cached.sig === sig) return cached.bitmap;
    try {
      const canvas = this.overlayCanvas ?? (this.overlayCanvas = document.createElement("canvas"));
      canvas.width = settings.width;
      canvas.height = settings.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return cached?.bitmap ?? null;
      ctx.clearRect(0, 0, settings.width, settings.height);
      draw(ctx, settings.width, settings.height);
      const bitmap = await createImageBitmap(canvas, { premultiplyAlpha: "premultiply" });
      cached?.bitmap.close();
      this.overlayCache.set(key, { sig, bitmap });
      return bitmap;
    } catch (error) {
      console.error("[WebCut] layer render failed:", error);
      return cached?.bitmap ?? null;
    }
  }

  private pruneOverlayCache(active: ReadonlySet<string>): void {
    for (const [id, entry] of this.overlayCache) {
      if (!active.has(id)) {
        entry.bitmap.close();
        this.overlayCache.delete(id);
      }
    }
  }

  dispose(): void {
    this.stopAllRvfcLoops();
    for (const video of this.videoElements.values()) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    for (const bitmap of this.imageBitmaps.values()) bitmap.close();
    for (const entry of this.overlayCache.values()) entry.bitmap.close();
    this.videoElements.clear();
    this.imageBitmaps.clear();
    this.objectUrls.clear();
    this.overlayCache.clear();
  }
}

// -- overlay drawing (module-level, pure) ------------------------------------

const STICKER_BASE_PX = 220;

const overlaySignature = (item: OverlayItem, settings: ProjectSettings, t: SampledTransform): string => {
  const base = `${settings.width}x${settings.height}|${t.pos.x},${t.pos.y}|${t.scale.x},${t.scale.y}|${t.rotation}|${t.opacity}`;
  if (item.type === "text") {
    return `text|${base}|${item.text}|${item.fontFamily}|${item.fontSizePx}|${item.fontWeight}|${item.fillColor}|${item.alignment}|${item.lineHeight}|${JSON.stringify(item.fillGradient ?? null)}`;
  }
  if (item.type === "sticker") {
    return `sticker|${base}|${item.content}`;
  }
  return `shape|${base}|${item.shape}|${item.fillColor}|${item.strokeColor}|${item.strokeWidthPx}|${item.cornerRadiusPx}|${JSON.stringify(item.fillGradient ?? null)}`;
};

/** Build a CanvasGradient in local coordinates (centered at origin), sized to `extent`. */
const gradientStyle = (ctx: CanvasRenderingContext2D, gradient: GradientFill, extent: number): CanvasGradient => {
  let grad: CanvasGradient;
  if (gradient.kind === "radial") {
    grad = ctx.createRadialGradient(0, 0, 0, 0, 0, extent / 2);
  } else {
    const rad = (gradient.angle * Math.PI) / 180;
    const dx = (Math.cos(rad) * extent) / 2;
    const dy = (Math.sin(rad) * extent) / 2;
    grad = ctx.createLinearGradient(-dx, -dy, dx, dy);
  }
  for (const stop of gradient.stops) grad.addColorStop(Math.min(1, Math.max(0, stop.at)), stop.color);
  return grad;
};

const drawTextItem = (ctx: CanvasRenderingContext2D, item: TextItem): void => {
  const lines = item.text.split("\n");
  const lineHeight = item.fontSizePx * item.lineHeight;
  ctx.fillStyle = item.fillGradient
    ? gradientStyle(ctx, item.fillGradient, item.fontSizePx * Math.max(2, lines.length))
    : item.fillColor;
  ctx.textAlign = item.alignment;
  ctx.textBaseline = "middle";
  ctx.font = `${item.fontWeight} ${item.fontSizePx}px ${item.fontFamily}`;
  let y = -((lines.length - 1) * lineHeight) / 2;
  for (const line of lines) {
    ctx.fillText(line, 0, y);
    y += lineHeight;
  }
};

/** Full-canvas gradient (not centered), for the project background layer. */
const backgroundGradientStyle = (
  ctx: CanvasRenderingContext2D,
  gradient: GradientFill,
  w: number,
  h: number,
): CanvasGradient => {
  let grad: CanvasGradient;
  if (gradient.kind === "radial") {
    grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) / 2);
  } else {
    const rad = (gradient.angle * Math.PI) / 180;
    const dx = (Math.cos(rad) * w) / 2;
    const dy = (Math.sin(rad) * h) / 2;
    grad = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
  }
  for (const stop of gradient.stops) grad.addColorStop(Math.min(1, Math.max(0, stop.at)), stop.color);
  return grad;
};

const drawSubtitle = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  text: string,
  style: SubtitleStyle,
): void => {
  const lines = text.split("\n");
  const lineHeight = style.fontSizePx * 1.25;
  ctx.font = `600 ${style.fontSizePx}px ${style.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const baseY = h * style.positionY - ((lines.length - 1) * lineHeight) / 2;
  const padX = style.fontSizePx * 0.4;
  const padY = style.fontSizePx * 0.2;
  lines.forEach((line, i) => {
    const y = baseY + i * lineHeight;
    const metrics = ctx.measureText(line);
    const boxW = metrics.width + padX * 2;
    const boxH = lineHeight + padY;
    ctx.fillStyle = style.backgroundColor;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(w / 2 - boxW / 2, y - boxH / 2, boxW, boxH, 8);
      ctx.fill();
    } else {
      ctx.fillRect(w / 2 - boxW / 2, y - boxH / 2, boxW, boxH);
    }
    ctx.fillStyle = style.fillColor;
    ctx.fillText(line, w / 2, y);
  });
};

const drawStickerItem = (ctx: CanvasRenderingContext2D, item: StickerItem): void => {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${STICKER_BASE_PX}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif`;
  ctx.fillText(item.content, 0, 0);
};

const drawShapeItem = (ctx: CanvasRenderingContext2D, item: ShapeItem, w: number, h: number): void => {
  // Shapes carry no explicit size — a base extent (40% of the short side) is
  // scaled by the item's transform for sizing.
  const base = Math.min(w, h) * 0.4;
  ctx.fillStyle = item.fillGradient ? gradientStyle(ctx, item.fillGradient, base) : item.fillColor;
  ctx.strokeStyle = item.strokeColor;
  ctx.lineWidth = item.strokeWidthPx;
  if (item.shape === "rectangle") {
    ctx.beginPath();
    if (item.cornerRadiusPx > 0 && typeof ctx.roundRect === "function") {
      ctx.roundRect(-base / 2, -base / 2, base, base, item.cornerRadiusPx);
    } else {
      ctx.rect(-base / 2, -base / 2, base, base);
    }
    ctx.fill();
    if (item.strokeWidthPx > 0) ctx.stroke();
  } else if (item.shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(0, 0, base / 2, base / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    if (item.strokeWidthPx > 0) ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(-base / 2, 0);
    ctx.lineTo(base / 2, 0);
    ctx.lineWidth = Math.max(2, item.strokeWidthPx);
    ctx.stroke();
  }
};

export const previewService = new PreviewService();

// Dev console handle (see timelineStore.ts for rationale).
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __webcutPreview?: PreviewService }).__webcutPreview = previewService;
}
