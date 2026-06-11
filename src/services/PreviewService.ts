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
  type ClipItem,
  type CorridorKeyParams,
  type MediaAsset,
  type MediaAssetId,
  type Project,
} from "../types/timeline";

export interface FrameSink {
  ingestLayerFrame(layerId: string, frame: VideoFrame | HTMLVideoElement | ImageBitmap, order: number): void;
  setLayerEffect(layerId: string, enabled: boolean, params: CorridorKeyParams): void;
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
  /** Compositing order: ascending = bottom -> top. */
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
      layers.push({ clip: item, asset, trackId: track.id, order: track.index });
      break;
    }
  }
  return layers;
};

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

    sink.syncLayers(actives.map((layer) => layer.trackId));

    if (actives.length === 0) {
      this.stopAllRvfcLoops();
      this.pauseAllExcept(new Set());
      return;
    }

    const playing = transport.isPlaying();
    const keepVideos = new Set<RVFCVideo>();

    for (const { clip, asset, trackId, order } of actives) {
      const key = corridorKeyOf(clip);
      sink.setLayerEffect(trackId, key.enabled, key.params);

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

  dispose(): void {
    this.stopAllRvfcLoops();
    for (const video of this.videoElements.values()) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    for (const bitmap of this.imageBitmaps.values()) bitmap.close();
    this.videoElements.clear();
    this.imageBitmaps.clear();
    this.objectUrls.clear();
  }
}

export const previewService = new PreviewService();

// Dev console handle (see timelineStore.ts for rationale).
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __webcutPreview?: PreviewService }).__webcutPreview = previewService;
}
