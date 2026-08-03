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
 *
 * Audio (#100): clips on audio tracks have no visual layer, so they're resolved
 * separately by `resolveActiveAudioClips` and driven through hidden <audio>
 * elements with the same seek/drift/play logic. Every element — video and audio
 * alike — is routed through the shared `audioGraph` mixer so track gain, pan,
 * mute and solo apply uniformly and match the export mixdown.
 */

import { audioGraph } from "./AudioGraph";
import { audibleTrackIds } from "./audioRouting";
import { fileSystemService } from "./FileSystemService";
import { getUseProxies } from "./ProxyService";
import { getWaveform } from "./waveform";
import { getExpressionFps, setExpressionFps } from "../expression";
import { transport, useTimelineStore } from "../store/timelineStore";
import {
  defaultCorridorKeyParams,
  integrateClipSource,
  isOverlayItem,
  reduceEffects,
  sampleAnimatable,
  sampleClipSpeed,
  sampleMaskPoints,
  type BlendMode,
  type ClipItem,
  type ColorGrade,
  type CorridorKeyParams,
  type GradientFill,
  type MediaAsset,
  type MediaAssetId,
  type AudioVizItem,
  type OverlayItem,
  type ParticleItem,
  type Project,
  type ProjectSettings,
  type ShapeItem,
  type StickerItem,
  type SubtitleStyle,
  type TextItem,
  type TrackId,
  type Vec2,
} from "../types/timeline";

export interface SampledTransform {
  readonly pos: Vec2;
  readonly scale: Vec2;
  readonly rotation: number;
  readonly opacity: number;
}

export interface FrameSink {
  ingestLayerFrame(layerId: string, frame: VideoFrame | HTMLVideoElement | ImageBitmap, order: number): void;
  setLayerEffect(layerId: string, enabled: boolean, params: CorridorKeyParams): void;
  setLayerBlend(layerId: string, mode: BlendMode): void;
  setLayerGrade(layerId: string, grade: ColorGrade | null): void;
  setLayerTransition(layerId: string, transition: import("../effects/CorridorKeyShader").TransitionUniform | null): void;
  setLayerEffectParams(layerId: string, params: import("../types/timeline").EffectParams | null): void;
  setLayerMask(layerId: string, mask: import("../types/timeline").ShapeMask | null): void;
  /** Reconcile live layers; anything absent from the list is destroyed. */
  syncLayers(activeLayerIds: readonly string[]): void;
}

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const EMPTY_VIDEO_SET: ReadonlySet<RVFCVideo> = new Set();
const EMPTY_AUDIO_SET: ReadonlySet<HTMLAudioElement> = new Set();

export interface ActiveLayerClip {
  readonly clip: ClipItem;
  readonly asset: MediaAsset;
  readonly trackId: TrackId;
  /** Per-active-clip layer id; distinct from `trackId` so two clips can co-exist during a transition. */
  readonly layerId: string;
  readonly trackMuted: boolean;
  /** Track-level mixer trim (dB), summed with per-clip gain. */
  readonly trackGainDb: number;
  /** Compositing order: ascending = bottom -> top. */
  readonly order: number;
  /** Per-frame transition uniform, or null when the clip isn't in a transition. */
  readonly transition: import("../effects/CorridorKeyShader").TransitionUniform | null;
}

export interface ActiveOverlay {
  readonly item: OverlayItem;
  /** Own layer id (per-item, so multiple overlays can share a track). */
  readonly layerId: string;
  readonly order: number;
}

/** Max playhead/element drift before a hard re-seek during playback (seconds). */
const DRIFT_TOLERANCE_S = 0.12;

/** Numeric encoding of a transition kind for the shader uniform. */
const TRANSITION_KIND: Record<string, number> = {
  fade: 1,
  "wipe-left": 2,
  "wipe-right": 3,
  "wipe-up": 4,
  "wipe-down": 5,
};

export const resolveActiveClips = (project: Project, frame: number): ActiveLayerClip[] => {
  const wholeFrame = Math.floor(frame);
  // Every visible video track contributes at least one layer, bottom (index 0)
  // first; upper layers composite over lower ones with premultiplied alpha, so
  // a keyed clip on V2 reveals V1 through its transparent matte. During a
  // transition, both the outgoing and incoming clip on the SAME track are
  // active — each gets its own layer id + transition uniform.
  const visualTracks = project.tracks
    .filter((track) => track.kind === "video" && !track.hidden)
    .sort((a, b) => a.index - b.index);
  const layers: ActiveLayerClip[] = [];
  for (const track of visualTracks) {
    const activeClips: ClipItem[] = [];
    for (const item of track.items) {
      if (item.type !== "clip") continue;
      if (wholeFrame < item.startFrame || wholeFrame >= item.startFrame + item.durationFrames) continue;
      activeClips.push(item);
    }
    if (activeClips.length === 0) continue;

    // Order by startFrame so index 0 is the outgoing clip when there's overlap.
    activeClips.sort((a, b) => a.startFrame - b.startFrame);

    for (let i = 0; i < activeClips.length; i++) {
      const clip = activeClips[i];
      // Multicam (#49): pick the active angle by sampling the animatable, else
      // fall back to the clip's own assetId.
      let effectiveAssetId = clip.assetId;
      if (clip.multicam && clip.multicam.angles.length > 0) {
        const idx = Math.max(
          0,
          Math.min(
            clip.multicam.angles.length - 1,
            Math.round(sampleAnimatable(clip.multicam.angleSelection, wholeFrame - clip.startFrame)),
          ),
        );
        effectiveAssetId = clip.multicam.angles[idx];
      }
      const asset = project.assets.find((candidate) => candidate.id === effectiveAssetId);
      if (!asset || asset.kind === "audio") continue;

      // Transition uniform: only set for a pair of overlapping clips where the
      // later one carries `transitionIn`. The earlier clip becomes "outgoing".
      let transition: import("../effects/CorridorKeyShader").TransitionUniform | null = null;
      if (i > 0 && clip.transitionIn) {
        const t = clip.transitionIn;
        const N = Math.max(1, t.frames);
        const progress = Math.max(0, Math.min(1, (wholeFrame - clip.startFrame) / N));
        if (progress < 1) {
          const kind = TRANSITION_KIND[t.kind] ?? 1;
          if (t.kind === "fade") {
            transition = { alpha: progress, kind: 0, progress: 0 };
          } else {
            transition = { alpha: 1, kind, progress };
          }
        }
      } else if (i + 1 < activeClips.length && activeClips[i + 1].transitionIn) {
        const incoming = activeClips[i + 1];
        const t = incoming.transitionIn;
        if (t) {
          const N = Math.max(1, t.frames);
          const progress = Math.max(0, Math.min(1, (wholeFrame - incoming.startFrame) / N));
          if (progress < 1 && t.kind === "fade") {
            transition = { alpha: 1 - progress, kind: 0, progress: 0 };
          } else if (progress < 1) {
            // For a wipe, the outgoing clip stays fully opaque underneath the incoming wipe edge.
            transition = { alpha: 1, kind: 0, progress: 0 };
          }
        }
      }

      // Sub-order: outgoing (i=0) below, incoming (i=1) above — so a wipe reveals correctly.
      const order = track.index + i * 0.001;
      layers.push({
        clip,
        asset,
        trackId: track.id,
        layerId: `${track.id}:${clip.id}`,
        trackMuted: track.muted,
        trackGainDb: track.gainDb ?? 0,
        order,
        transition,
      });
    }
  }
  return layers;
};

/** Text/shape overlays under the playhead, each its own compositing layer. */
export const resolveActiveOverlays = (project: Project, frame: number): ActiveOverlay[] => {
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
export const dbToVolume = (gainDb: number): number => Math.min(1, Math.max(0, Math.pow(10, gainDb / 20)));

/** A clip whose audio is driven by a dedicated element rather than a video layer. */
export interface ActiveAudioClip {
  readonly clip: ClipItem;
  readonly asset: MediaAsset;
  readonly trackId: TrackId;
  /** Cache key for the backing <audio> element (per clip, so overlaps work). */
  readonly elementKey: string;
  readonly trackGainDb: number;
}

/**
 * Clips under the playhead whose audio must come from a dedicated <audio>
 * element (#100).
 *
 * A clip belongs to this path when it sits on an audio track OR its asset is
 * audio-only. Clips on video tracks backed by video assets are excluded: their
 * audio already comes from the <video> element the compositor is using, and
 * driving a second element would double the sound.
 *
 * That partition is also what makes detached audio (#99) correct — the
 * detached copy lives on an audio track (this path) while its source clip
 * carries `audioMuted`, so exactly one element produces sound.
 *
 * Muted/un-soloed tracks are still returned so their elements stay in sync and
 * resume instantly when unmuted; audibility is applied as gain by the caller.
 */
export const resolveActiveAudioClips = (project: Project, frame: number): ActiveAudioClip[] => {
  const wholeFrame = Math.floor(frame);
  const out: ActiveAudioClip[] = [];
  for (const track of project.tracks) {
    for (const item of track.items) {
      if (item.type !== "clip") continue;
      if (wholeFrame < item.startFrame || wholeFrame >= item.startFrame + item.durationFrames) continue;
      const asset = project.assets.find((candidate) => candidate.id === item.assetId);
      if (!asset) continue;
      // Sequences carry no directly-decodable audio track of their own.
      if (asset.kind === "image" || asset.kind === "sequence") continue;
      const ownedByAudioPath = track.kind === "audio" || asset.kind === "audio";
      if (!ownedByAudioPath) continue;
      out.push({
        clip: item,
        asset,
        trackId: track.id,
        elementKey: `audio:${item.id}:${asset.handleKey}`,
        trackGainDb: track.gainDb ?? 0,
      });
    }
  }
  return out;
};

export const corridorKeyOf = (clip: ClipItem): { enabled: boolean; params: CorridorKeyParams } => {
  const effect = clip.effects.find((candidate) => candidate.type === "corridor-key");
  if (effect && effect.type === "corridor-key") {
    return { enabled: effect.enabled, params: effect.params };
  }
  return { enabled: false, params: defaultCorridorKeyParams() };
};

class PreviewService {
  private sink: FrameSink | null = null;
  private videoElements = new Map<string, RVFCVideo>();
  /** Audio-only elements for clips with no visual layer (#100). */
  private audioElements = new Map<string, HTMLAudioElement>();
  /** Element keys that failed to decode, so we don't retry them every sync. */
  private audioLoadFailures = new Set<string>();
  private imageBitmaps = new Map<MediaAssetId, ImageBitmap>();
  private objectUrls = new Map<string, string>();
  /** Rasterized overlays, keyed by item id → { signature, premultiplied bitmap }. */
  private overlayCache = new Map<string, { sig: string; bitmap: ImageBitmap }>();
  private overlayCanvas: HTMLCanvasElement | null = null;

  private rvfcLoops = new Map<RVFCVideo, { handle: number; layerId: string; order: number }>();
  private unsubscribeTransport: (() => void) | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private syncing = false;
  private dirty = false;

  registerSink(sink: FrameSink): () => void {
    this.sink = sink;
    this.unsubscribeTransport = transport.subscribe(() => {
      // Pausing/scrubbing must silence media immediately — don't wait for the
      // async sync (which may be mid-decode). This is the authoritative stop.
      if (!transport.isPlaying()) {
        this.pauseAllExcept(EMPTY_VIDEO_SET);
        this.pauseAudioExcept(EMPTY_AUDIO_SET);
      } else {
        // Pressing play is a user gesture — the moment to lift the autoplay
        // suspension on the WebAudio context that all preview audio flows through.
        void audioGraph.resume();
      }
      this.scheduleSync();
    });
    this.unsubscribeStore = useTimelineStore.subscribe(
      (state) => state.revision,
      () => this.scheduleSync(),
    );
    this.scheduleSync();
    return () => {
      this.unsubscribeTransport?.();
      this.unsubscribeStore?.();
      this.stopAllRvfcLoops();
      this.pauseAllExcept(EMPTY_VIDEO_SET);
      this.pauseAudioExcept(EMPTY_AUDIO_SET);
      this.sink = null;
    };
  }

  /**
   * Run syncs strictly sequentially. Overlapping async syncs would each issue
   * play()/seek on the same elements, doubling audio; a trailing `dirty` pass
   * guarantees the final state (e.g. a pause) is always applied.
   */
  private scheduleSync(): void {
    this.dirty = true;
    if (this.syncing) return;
    void this.runSyncLoop();
  }

  private async runSyncLoop(): Promise<void> {
    this.syncing = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        await this.sync();
      }
    } finally {
      this.syncing = false;
    }
  }

  private async sync(): Promise<void> {
    const sink = this.sink;
    if (!sink) return;

    const { project } = useTimelineStore.getState();
    const frame = transport.getFrame();
    const fps = project.settings.frameRate;
    setExpressionFps(fps); // #63: expressions read time = frame / fps
    const actives = resolveActiveClips(project, frame);
    const overlays = resolveActiveOverlays(project, frame);
    const audioClips = resolveActiveAudioClips(project, frame);
    const audible = audibleTrackIds(project);

    // Track channel strips carry mute/solo (as a 0/1 gate) and pan. The dB
    // trim stays folded into per-clip gain below, matching the existing video
    // path and the export mixdown.
    for (const track of project.tracks) {
      audioGraph.setTrackMix(track.id, audible.has(track.id) ? 1 : 0, track.pan ?? 0);
    }

    const wholeFrame = Math.floor(frame);
    const bgGradient = project.settings.backgroundGradient;
    const activeSubtitle = project.subtitles.find((s) => wholeFrame >= s.startFrame && wholeFrame < s.endFrame);

    const BG_ID = "__bg";
    const SUB_ID = "__subtitle";
    const layerIds = [...actives.map((layer) => layer.layerId), ...overlays.map((o) => o.layerId)];
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

    // No visual layer doesn't mean no sound: an audio-only project still has
    // to play. Retire the video elements, then fall through to the audio pass.
    if (actives.length === 0) {
      this.stopAllRvfcLoops();
      this.pauseAllExcept(EMPTY_VIDEO_SET);
    }

    const keepVideos = new Set<RVFCVideo>();

    for (const { clip, asset, trackId, layerId, trackMuted, trackGainDb, order, transition } of actives) {
      const key = corridorKeyOf(clip);
      sink.setLayerEffect(layerId, key.enabled, key.params);
      sink.setLayerBlend(layerId, clip.blendMode ?? "normal");
      sink.setLayerGrade(layerId, clip.grade ?? null);
      sink.setLayerTransition(layerId, transition);
      sink.setLayerEffectParams(layerId, reduceEffects(clip.effects, frame - clip.startFrame));
      // Rotoscoping (#60): sample the possibly-animated vertex positions at
      // the clip-local frame before uploading the mask.
      sink.setLayerMask(
        layerId,
        clip.mask ? { ...clip.mask, points: sampleMaskPoints(clip.mask, frame - clip.startFrame) } : null,
      );

      if (asset.kind === "image") {
        const bitmap = await this.getImageBitmap(asset);
        if (bitmap) sink.ingestLayerFrame(layerId, bitmap, order);
        continue;
      }

      // Nested sequence (#50): rasterize the nested project at the mapped
      // local frame into an ImageBitmap and feed it as a layer source.
      if (asset.kind === "sequence" && asset.nestedProject) {
        const localFrame = frame - clip.startFrame;
        const nestedFrame = clip.sourceInFrame + localFrame * clip.speed;
        try {
          const { rasterizeNestedFrame } = await import("./nestedSequence");
          const bitmap = await rasterizeNestedFrame(asset.nestedProject, nestedFrame);
          sink.ingestLayerFrame(layerId, bitmap, order);
        } catch (err) {
          console.error("[WebCut] nested sequence render failed:", err);
        }
        continue;
      }

      // Cache per layer: the same source file on two layers (e.g. two clips
      // from the same asset overlapping during a transition) needs two
      // independent elements, each seeking its own media time.
      const video = await this.getVideoElement(asset, `${layerId}:${asset.handleKey}`);
      if (!video) continue;
      keepVideos.add(video);

      const localFrame = frame - clip.startFrame;
      // Per-clip audio: clip gain + keyframed gain ramp + track mixer trim.
      // (Mute/solo overrides everything.) Fade audio with the transition.
      const rampDb = clip.gainRamp ? sampleAnimatable(clip.gainRamp, localFrame) : 0;
      const transitionAlpha = transition?.alpha ?? 1;
      const silenced = clip.audioMuted || trackMuted || !audible.has(trackId);
      this.applyElementAudio(
        video,
        trackId,
        silenced ? 0 : dbToVolume(clip.audioGainDb + rampDb + trackGainDb) * transitionAlpha,
      );

      // Ramp-aware source mapping: integrate the (possibly keyframed) speed.
      const instantSpeed = sampleClipSpeed(clip, localFrame);
      const mediaTimeS = (clip.sourceInFrame + integrateClipSource(clip, localFrame)) / fps;
      const clampedTimeS = Math.min(Math.max(0, mediaTimeS), Math.max(0, video.duration - 1 / fps));

      // Read the transport fresh here (not once at the top): a pause during an
      // earlier `await` in this sync must not leave the video playing.
      if (transport.isPlaying() && instantSpeed > 0) {
        video.playbackRate = Math.min(16, instantSpeed);
        if (Math.abs(video.currentTime - clampedTimeS) > DRIFT_TOLERANCE_S) {
          video.currentTime = clampedTimeS;
        }
        if (video.paused) {
          void video.play().catch(() => {
            /* playback only starts from a user gesture; ignore pause races */
          });
        }
        this.ensureRvfcLoop(video, layerId, order);
      } else {
        this.stopRvfcLoop(video);
        if (!video.paused) video.pause();
        if (Math.abs(video.currentTime - clampedTimeS) > 0.5 / fps) {
          video.currentTime = clampedTimeS;
          const pushWhenSeeked = () => {
            if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              this.sink?.ingestLayerFrame(layerId, video, order);
            }
          };
          video.addEventListener("seeked", pushWhenSeeked, { once: true });
        } else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          sink.ingestLayerFrame(layerId, video, order);
        }
      }
    }

    // Retire loops/elements for tracks that no longer have an active clip.
    for (const video of [...this.rvfcLoops.keys()]) {
      if (!keepVideos.has(video)) this.stopRvfcLoop(video);
    }
    this.pauseAllExcept(keepVideos);

    await this.syncAudioClips(audioClips, audible, frame, fps);
  }

  /**
   * Drive the <audio> elements for clips with no visual layer (#100). Mirrors
   * the video branch above: same source mapping, same drift tolerance, same
   * play/pause gating on the transport.
   */
  private async syncAudioClips(
    audioClips: readonly ActiveAudioClip[],
    audible: ReadonlySet<TrackId>,
    frame: number,
    fps: number,
  ): Promise<void> {
    const keep = new Set<HTMLAudioElement>();

    for (const { clip, asset, trackId, elementKey, trackGainDb } of audioClips) {
      const element = await this.getAudioElement(asset, elementKey);
      if (!element) continue;
      keep.add(element);

      const localFrame = frame - clip.startFrame;
      const rampDb = clip.gainRamp ? sampleAnimatable(clip.gainRamp, localFrame) : 0;
      const silenced = clip.audioMuted || !audible.has(trackId);
      this.applyElementAudio(
        element,
        trackId,
        silenced ? 0 : dbToVolume(clip.audioGainDb + rampDb + trackGainDb),
      );

      const instantSpeed = sampleClipSpeed(clip, localFrame);
      const mediaTimeS = (clip.sourceInFrame + integrateClipSource(clip, localFrame)) / fps;
      const duration = Number.isFinite(element.duration) ? element.duration : mediaTimeS + 1;
      const clampedTimeS = Math.min(Math.max(0, mediaTimeS), Math.max(0, duration - 1 / fps));

      // Transport is re-read here for the same reason as the video branch: a
      // pause during an earlier await must not leave audio running.
      if (transport.isPlaying() && instantSpeed > 0) {
        element.playbackRate = Math.min(16, instantSpeed);
        if (Math.abs(element.currentTime - clampedTimeS) > DRIFT_TOLERANCE_S) {
          element.currentTime = clampedTimeS;
        }
        if (element.paused) {
          void element.play().catch(() => {
            /* gesture/pause races settle on the next sync */
          });
        }
      } else {
        if (!element.paused) element.pause();
        if (Math.abs(element.currentTime - clampedTimeS) > 0.5 / fps) {
          element.currentTime = clampedTimeS;
        }
      }
    }

    this.pauseAudioExcept(keep);
  }

  /**
   * Apply a clip's linear gain, preferring the mixer graph so track pan/solo
   * apply. Falls back to plain element volume when WebAudio is unusable —
   * without this, a failed graph would silence preview entirely.
   */
  private applyElementAudio(element: HTMLMediaElement, trackId: TrackId, linearGain: number): void {
    if (audioGraph.enabled && audioGraph.attach(element, trackId)) {
      audioGraph.setClipGain(element, linearGain);
      return;
    }
    element.muted = linearGain <= 0;
    element.volume = Math.max(0, Math.min(1, linearGain));
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

  private pauseAudioExcept(keep: ReadonlySet<HTMLAudioElement>): void {
    for (const element of this.audioElements.values()) {
      if (!keep.has(element) && !element.paused) element.pause();
    }
  }

  // -- element / bitmap caches ------------------------------------------------

  private async getVideoElement(asset: MediaAsset, cacheKey: string): Promise<RVFCVideo | null> {
    const cached = this.videoElements.get(cacheKey);
    if (cached) return cached;
    // Proxy preference (#51): if a proxy exists and proxies are enabled
    // globally, load the smaller/faster file. Export always uses the original.
    // If the proxy fails to load (malformed re-encode), fall back to the
    // original so the preview never goes black on a bad proxy.
    const useProxy = !!asset.proxyHandleKey && getUseProxies();
    const tryLoad = async (handleKey: string): Promise<RVFCVideo> => {
      const file = await fileSystemService.resolveMediaFile(handleKey);
      const url = URL.createObjectURL(file);
      this.objectUrls.set(cacheKey, url);
      const video = document.createElement("video") as RVFCVideo;
      video.src = url;
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      // No crossOrigin: the source is a same-origin blob: URL. Setting
      // crossOrigin forces CORS mode, which a blob response can't satisfy and
      // which interacts badly with COEP:require-corp on the deployed build.
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error(`Cannot decode "${asset.name}"`));
      });
      return video;
    };
    try {
      const video = await tryLoad(useProxy ? asset.proxyHandleKey! : asset.handleKey);
      this.videoElements.set(cacheKey, video);
      return video;
    } catch (error) {
      if (useProxy) {
        // Proxy was bad — retry with the original source.
        try {
          const video = await tryLoad(asset.handleKey);
          this.videoElements.set(cacheKey, video);
          return video;
        } catch (fallbackError) {
          console.error("[WebCut] preview decode failed (proxy + original):", fallbackError);
          return null;
        }
      }
      console.error("[WebCut] preview decode failed:", error);
      return null;
    }
  }

  /**
   * Hidden <audio> element for a clip with no visual layer (#100).
   *
   * Always loads the ORIGINAL source, never a proxy: proxies (#51) exist to
   * make video decode cheap and may re-encode or drop audio entirely. An
   * <audio> element happily decodes just the audio track of a video file,
   * which is exactly what a detached-audio clip (#99) points at.
   */
  private async getAudioElement(asset: MediaAsset, cacheKey: string): Promise<HTMLAudioElement | null> {
    const cached = this.audioElements.get(cacheKey);
    if (cached) return cached;
    // A video asset with no audio track fails here on every sync otherwise —
    // remember the miss so it's attempted (and reported) exactly once.
    if (this.audioLoadFailures.has(cacheKey)) return null;
    try {
      const file = await fileSystemService.resolveMediaFile(asset.handleKey);
      const url = URL.createObjectURL(file);
      this.objectUrls.set(cacheKey, url);
      const element = document.createElement("audio");
      element.src = url;
      element.preload = "auto";
      // No crossOrigin — same-origin blob: URL, and CORS mode would both fail
      // here and block the MediaElementSource the mixer graph needs.
      await new Promise<void>((resolve, reject) => {
        element.onloadeddata = () => resolve();
        element.onerror = () => reject(new Error(`Cannot decode audio for "${asset.name}"`));
      });
      this.audioElements.set(cacheKey, element);
      return element;
    } catch (error) {
      this.audioLoadFailures.add(cacheKey);
      console.error("[WebCut] preview audio decode failed:", error);
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
    // Audio visualizer + particles re-rasterize per frame (they animate with
    // playback), so their signature carries the local frame; static overlays
    // cache normally.
    const sig = item.type === "audioviz" || item.type === "particles"
      ? `${overlaySignature(item, settings, t)}|f${local}`
      : overlaySignature(item, settings, t);
    const cached = this.overlayCache.get(item.id);
    if (cached && cached.sig === sig) return cached.bitmap;
    try {
      // Pre-load waveform peaks for the visualizer before the synchronous draw.
      let peaks: readonly number[] | null = null;
      if (item.type === "audioviz") {
        const asset = useTimelineStore.getState().project.assets.find((a) => a.id === item.assetId);
        if (asset) peaks = await getWaveformPeaks(asset);
      }
      const bitmap = await this.rasterizeOverlay(item, settings, t, local, peaks);
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
    localFrame = 0,
    peaks: readonly number[] | null = null,
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
    else if (item.type === "sticker") drawStickerItem(ctx, item);
    else if (item.type === "audioviz") drawAudioVizItem(ctx, item, peaks, localFrame, item.durationFrames);
    else drawParticleItem(ctx, item, w, h, localFrame, getExpressionFps());
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
      audioGraph.release(video);
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    for (const element of this.audioElements.values()) {
      audioGraph.release(element);
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    for (const bitmap of this.imageBitmaps.values()) bitmap.close();
    for (const entry of this.overlayCache.values()) entry.bitmap.close();
    this.videoElements.clear();
    this.audioElements.clear();
    this.audioLoadFailures.clear();
    this.imageBitmaps.clear();
    this.objectUrls.clear();
    this.overlayCache.clear();
    audioGraph.dispose();
  }
}

// -- overlay drawing (module-level, pure) ------------------------------------

const STICKER_BASE_PX = 220;

/**
 * Waveform-peak cache for the audio visualizer overlay (#65). Keyed by the
 * asset's handleKey; a `null` sentinel means "loaded but no waveform".
 */
const audioVizPeaks = new Map<string, number[] | null>();

/** Load (and memoize) an asset's normalized waveform peaks for the visualizer. */
export const getWaveformPeaks = async (asset: MediaAsset): Promise<number[] | null> => {
  const key = asset.handleKey;
  if (audioVizPeaks.has(key)) return audioVizPeaks.get(key) ?? null;
  const peaks = await getWaveform(asset);
  audioVizPeaks.set(key, peaks);
  return peaks;
};

/**
 * Draw the audio waveform visualizer, centered at the current (already
 * transformed) origin. `localFrame` scrolls the window across the peaks so the
 * visual reacts to playback. Pure — the caller supplies the peaks.
 */
export const drawAudioVizItem = (
  ctx: CanvasRenderingContext2D,
  item: AudioVizItem,
  peaks: readonly number[] | null,
  localFrame: number,
  totalFrames: number,
): void => {
  const W = 960;
  const H = 280;
  const n = Math.max(4, Math.min(256, item.barCount));
  ctx.fillStyle = item.color;
  ctx.strokeStyle = item.color;
  ctx.lineWidth = Math.max(2, W / n / 3);

  const sampleAt = (i: number): number => {
    if (!peaks || peaks.length === 0) return 0.05;
    const frac = totalFrames > 0 ? localFrame / totalFrames : 0;
    const center = Math.floor(frac * peaks.length);
    const idx = center - Math.floor(n / 2) + i;
    if (idx < 0 || idx >= peaks.length) return 0;
    return Math.max(0, Math.min(1, peaks[idx]));
  };

  if (item.style === "wave") {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = -W / 2 + (i / (n - 1)) * W;
      const y = -sampleAt(i) * H * 0.5;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    return;
  }
  drawAudioVizBars(ctx, item, sampleAt, W, H, n);
};

const drawAudioVizBars = (
  ctx: CanvasRenderingContext2D,
  item: AudioVizItem,
  sampleAt: (i: number) => number,
  W: number,
  H: number,
  n: number,
): void => {
  const barW = (W / n) * 0.7;
  for (let i = 0; i < n; i++) {
    const v = sampleAt(i);
    const bh = Math.max(2, v * H);
    const x = -W / 2 + (i / n) * W;
    if (item.style === "mirror") {
      ctx.fillRect(x, -bh * 0.5, barW, bh);
    } else {
      // "bars" — grow upward from a baseline.
      ctx.fillRect(x, H * 0.5 - bh, barW, bh);
    }
  }
};

// Deterministic hash → [0,1) for the particle emitter.
const particleHash = (n: number): number => {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Draw a particle emitter (#64) deterministically for the given frame. No
 * simulation history is kept — each particle's state is a closed-form function
 * of its (seeded) birth parameters and age, so preview and export match and any
 * frame can be rendered in isolation. Drawn in the item's transformed space
 * (origin at the item center).
 */
export const drawParticleItem = (
  ctx: CanvasRenderingContext2D,
  item: ParticleItem,
  w: number,
  h: number,
  localFrame: number,
  fps: number,
): void => {
  const t = localFrame / (fps || 30);
  const emitterX = (item.originX - 0.5) * w;
  const emitterY = (item.originY - 0.5) * h;
  const rate = Math.max(1, item.rate);
  const lifetime = Math.max(0.05, item.lifetime);
  const iMax = Math.floor(t * rate);
  const iMin = Math.max(0, Math.ceil((t - lifetime) * rate));
  const baseAlpha = ctx.globalAlpha;
  ctx.fillStyle = item.color;

  for (let i = iMin; i <= iMax; i++) {
    const birth = i / rate;
    const age = t - birth;
    if (age < 0 || age > lifetime) continue;
    const r1 = particleHash(item.seed + i * 1.13);
    const r2 = particleHash(item.seed + i * 2.71 + 0.5);
    const angleDeg = item.direction + (r1 - 0.5) * item.spread;
    const angle = (angleDeg * Math.PI) / 180;
    const speed = item.speed * (0.7 + 0.6 * r2);
    // direction 0 = up (negative y).
    const vx = Math.sin(angle) * speed;
    const vy = -Math.cos(angle) * speed;
    const x = emitterX + vx * age;
    const y = emitterY + vy * age + 0.5 * item.gravity * age * age;
    const lifeT = age / lifetime;
    const radius = Math.max(0.5, item.size * (1 - 0.4 * lifeT));
    ctx.globalAlpha = baseAlpha * Math.max(0, 1 - lifeT);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = baseAlpha;
};

const overlaySignature = (item: OverlayItem, settings: ProjectSettings, t: SampledTransform): string => {
  const base = `${settings.width}x${settings.height}|${t.pos.x},${t.pos.y}|${t.scale.x},${t.scale.y}|${t.rotation}|${t.opacity}`;
  if (item.type === "text") {
    return `text|${base}|${item.text}|${item.fontFamily}|${item.fontSizePx}|${item.fontWeight}|${item.fillColor}|${item.alignment}|${item.lineHeight}|${JSON.stringify(item.fillGradient ?? null)}`;
  }
  if (item.type === "sticker") {
    return `sticker|${base}|${item.content}`;
  }
  if (item.type === "audioviz") {
    return `audioviz|${base}|${item.assetId}|${item.style}|${item.color}|${item.barCount}`;
  }
  if (item.type === "particles") {
    return `particles|${base}|${item.originX},${item.originY}|${item.rate}|${item.lifetime}|${item.speed}|${item.direction}|${item.spread}|${item.gravity}|${item.size}|${item.color}|${item.seed}`;
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

export const drawTextItem = (ctx: CanvasRenderingContext2D, item: TextItem): void => {
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

export const drawSubtitle = (
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

export const drawStickerItem = (ctx: CanvasRenderingContext2D, item: StickerItem): void => {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${STICKER_BASE_PX}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif`;
  ctx.fillText(item.content, 0, 0);
};

export const drawShapeItem = (ctx: CanvasRenderingContext2D, item: ShapeItem, w: number, h: number): void => {
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
