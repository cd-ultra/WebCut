/**
 * WebCut — ExportService: timeline → playable video file (#1).
 *
 * Renders the project offline through the SAME WebGPUCompositor the preview
 * uses (so the export matches the monitor), encodes with WebCodecs
 * `VideoEncoder`, mixes audio down through an `OfflineAudioContext` +
 * `AudioEncoder`, and muxes to MP4 (AVC/AAC) or WebM (VP9/Opus).
 *
 *   for each output frame f in [start, end):
 *     source each active clip (seek <video> / decode image / raster overlay)
 *       → compositor.ingestLayerFrame → compositor.render() to an OffscreenCanvas
 *     → new VideoFrame(canvas) → VideoEncoder.encode → muxer.addVideoChunk
 *
 * Audio is a separate offline mixdown of every audible clip (clip gain +
 * ramp + track gain + pan + speed), encoded and muxed alongside.
 *
 * Frame sourcing uses element seeking, so export runs slower than realtime —
 * it trades speed for exactness and reuses the browser's decoders.
 */

import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from "mp4-muxer";
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from "webm-muxer";
import { WebGPUCompositor } from "../effects/Compositor";
import { audibleTrackIds } from "./audioRouting";
import { projectChaptersToWebVtt } from "./chapters";
import { setExpressionFps } from "../expression";
import { fileSystemService } from "./FileSystemService";
import {
  corridorKeyOf,
  dbToVolume,
  drawAudioVizItem,
  drawParticleItem,
  drawShapeItem,
  drawStickerItem,
  drawSubtitle,
  drawTextItem,
  getWaveformPeaks,
  resolveActiveClips,
  resolveActiveOverlays,
} from "./PreviewService";
import {
  defaultCorridorKeyParams,
  reduceEffects,
  sampleAnimatable,
  sampleClipSpeed,
  sampleMaskPoints,
  type ClipItem,
  type MediaAsset,
  type OverlayItem,
  type Project,
} from "../types/timeline";

export type ExportFormat = "mp4" | "webm";

export interface ExportOptions {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly format: ExportFormat;
  /** Target video bitrate in bits per second. */
  readonly videoBitrate: number;
  /** Inclusive start / exclusive end of the export range, in timeline frames. */
  readonly startFrame: number;
  readonly endFrame: number;
}

export interface ExportProgress {
  readonly phase: "preparing" | "video" | "audio" | "finalizing";
  readonly frame: number;
  readonly totalFrames: number;
}

export interface ExportResult {
  readonly blob: Blob;
  readonly filename: string;
  /**
   * WebVTT chapter sidecar (#72) — empty when the project has no markers in
   * the export range. Saved alongside the video as `<filename>.chapters.vtt`.
   */
  readonly chaptersVtt: string;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.replace(/(.)/g, "$1$1") : c.padEnd(6, "0");
  return [parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255];
};

/** Codec picks per container, with WebCodecs config strings. */
const videoCodecFor = (format: ExportFormat) =>
  format === "mp4"
    ? { muxer: "avc" as const, encoder: "avc1.4d0028", webm: undefined }
    : { muxer: "vp9" as const, encoder: "vp09.00.10.08", webm: "V_VP9" };

const nextFrameEvent = (video: HTMLVideoElement): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done, { once: true });
  });

/**
 * Render + encode the whole project. Rejects with `AbortError` when the signal
 * fires. Must run on the main thread (WebGPU canvas + media elements).
 */
export const exportProject = async (
  project: Project,
  options: ExportOptions,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<ExportResult> => {
  const { width, height, frameRate, format, videoBitrate, startFrame, endFrame } = options;
  const totalFrames = Math.max(1, endFrame - startFrame);
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  };

  onProgress({ phase: "preparing", frame: 0, totalFrames });

  // --- WebGPU offscreen compositor -----------------------------------------
  if (!("gpu" in navigator)) throw new Error("WebGPU is required to export.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter available for export.");
  const device = await adapter.requestDevice({ label: "webcut-export-device" });
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Failed to acquire an offscreen 'webgpu' context.");
  const gpuFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: gpuFormat, alphaMode: "opaque" });
  const compositor = new WebGPUCompositor({ device, context, format: gpuFormat });
  compositor.setBackgroundColor(hexToRgb(project.settings.backgroundColor));

  // --- Muxer + video encoder -----------------------------------------------
  const codec = videoCodecFor(format);
  const mp4Target = format === "mp4" ? new Mp4Target() : null;
  const webmTarget = format === "webm" ? new WebmTarget() : null;
  const hasAudio = projectHasAudio(project, startFrame, endFrame);

  const mp4Muxer = mp4Target
    ? new Mp4Muxer({
        target: mp4Target,
        video: { codec: "avc", width, height, frameRate },
        audio: hasAudio ? { codec: "aac", numberOfChannels: 2, sampleRate: project.settings.sampleRate } : undefined,
        fastStart: "in-memory",
        firstTimestampBehavior: "offset",
      })
    : null;
  const webmMuxer = webmTarget
    ? new WebmMuxer({
        target: webmTarget,
        video: { codec: "V_VP9", width, height, frameRate },
        audio: hasAudio ? { codec: "A_OPUS", numberOfChannels: 2, sampleRate: 48000 } : undefined,
        firstTimestampBehavior: "offset",
      })
    : null;

  const addVideoChunk = (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
    if (mp4Muxer) mp4Muxer.addVideoChunk(chunk, meta);
    else webmMuxer!.addVideoChunk(chunk, meta);
  };
  const addAudioChunk = (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
    if (mp4Muxer) mp4Muxer.addAudioChunk(chunk, meta);
    else webmMuxer!.addAudioChunk(chunk, meta);
  };

  let encoderError: unknown = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => addVideoChunk(chunk, meta ?? undefined),
    error: (e) => { encoderError = e; },
  });
  videoEncoder.configure({
    codec: codec.encoder,
    width,
    height,
    bitrate: videoBitrate,
    framerate: frameRate,
    ...(format === "mp4" ? { avc: { format: "avc" as const } } : {}),
  });

  // --- Frame sourcing caches -----------------------------------------------
  const videoEls = new Map<string, HTMLVideoElement>();
  const imageBitmaps = new Map<string, ImageBitmap>();
  const objectUrls: string[] = [];
  const rasterCanvas = new OffscreenCanvas(width, height);
  const rctx = rasterCanvas.getContext("2d")!;

  const getVideoEl = async (asset: MediaAsset, key: string): Promise<HTMLVideoElement> => {
    let el = videoEls.get(key);
    if (el) return el;
    const file = await fileSystemService.resolveMediaFile(asset.handleKey);
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    el = document.createElement("video");
    el.src = url;
    el.muted = true;
    el.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      el!.addEventListener("loadeddata", () => resolve(), { once: true });
      el!.addEventListener("error", () => reject(new Error(`Failed to load ${asset.name}`)), { once: true });
    });
    videoEls.set(key, el);
    return el;
  };

  const getImage = async (asset: MediaAsset): Promise<ImageBitmap | null> => {
    const cached = imageBitmaps.get(asset.handleKey);
    if (cached) return cached;
    try {
      const file = await fileSystemService.resolveMediaFile(asset.handleKey);
      const bmp = await createImageBitmap(file);
      imageBitmaps.set(asset.handleKey, bmp);
      return bmp;
    } catch {
      return null;
    }
  };

  const rasterizeOverlay = async (item: OverlayItem, frame: number): Promise<ImageBitmap> => {
    const local = Math.max(0, frame - item.startFrame);
    const pos = sampleAnimatable(item.transform.position, local);
    const scale = sampleAnimatable(item.transform.scale, local);
    const rotation = sampleAnimatable(item.transform.rotation, local);
    const opacity = sampleAnimatable(item.transform.opacity, local);
    rctx.clearRect(0, 0, width, height);
    rctx.save();
    rctx.globalAlpha = Math.min(1, Math.max(0, opacity));
    rctx.translate(width / 2 + pos.x, height / 2 + pos.y);
    rctx.rotate((rotation * Math.PI) / 180);
    rctx.scale(scale.x, scale.y);
    if (item.type === "text") drawTextItem(rctx as unknown as CanvasRenderingContext2D, item);
    else if (item.type === "shape") drawShapeItem(rctx as unknown as CanvasRenderingContext2D, item, width, height);
    else if (item.type === "sticker") drawStickerItem(rctx as unknown as CanvasRenderingContext2D, item);
    else if (item.type === "particles") drawParticleItem(rctx as unknown as CanvasRenderingContext2D, item, width, height, local, frameRate);
    else {
      const asset = project.assets.find((a) => a.id === item.assetId);
      const peaks = asset ? await getWaveformPeaks(asset) : null;
      drawAudioVizItem(rctx as unknown as CanvasRenderingContext2D, item, peaks, local, item.durationFrames);
    }
    rctx.restore();
    return createImageBitmap(rasterCanvas, { premultiplyAlpha: "premultiply" });
  };

  // --- Video frame loop -----------------------------------------------------
  try {
    const fps = frameRate;
    setExpressionFps(fps); // #63: expressions read time = frame / fps
    const keyInterval = Math.round(fps * 2); // keyframe every ~2s
    for (let i = 0; i < totalFrames; i++) {
      checkAbort();
      if (encoderError) throw encoderError;
      const f = startFrame + i;

      const clips = resolveActiveClips(project, f);
      const overlays = resolveActiveOverlays(project, f);
      const activeIds: string[] = [];

      for (const { clip, asset, layerId, order, transition } of clips) {
        const key = corridorKeyOf(clip);
        compositor.setLayerEffect(layerId, key.enabled, key.params);
        compositor.setLayerBlend(layerId, clip.blendMode ?? "normal");
        compositor.setLayerGrade(layerId, clip.grade ?? null);
        compositor.setLayerTransition(layerId, transition);
        compositor.setLayerEffectParams(layerId, reduceEffects(clip.effects, f - clip.startFrame));
        compositor.setLayerMask(
          layerId,
          clip.mask ? { ...clip.mask, points: sampleMaskPoints(clip.mask, f - clip.startFrame) } : null,
        );
        activeIds.push(layerId);
        if (asset.kind === "image") {
          const bmp = await getImage(asset);
          if (bmp) compositor.ingestLayerFrame(layerId, bmp, order);
          continue;
        }
        // Nested sequence (#50): rasterize the nested project frame.
        if (asset.kind === "sequence" && asset.nestedProject) {
          const localFrame = f - clip.startFrame;
          const nestedFrame = clip.sourceInFrame + localFrame * clip.speed;
          const { rasterizeNestedFrame } = await import("./nestedSequence");
          const bmp = await rasterizeNestedFrame(asset.nestedProject, nestedFrame);
          compositor.ingestLayerFrame(layerId, bmp, order);
          bmp.close();
          continue;
        }
        const el = await getVideoEl(asset, `${layerId}:${asset.handleKey}`);
        const localFrame = f - clip.startFrame;
        const srcTime = (clip.sourceInFrame + localFrame * Math.abs(sampleClipSpeed(clip, localFrame))) / fps;
        const t = Math.min(Math.max(0, srcTime), Math.max(0, (el.duration || 0) - 1e-3));
        if (Math.abs(el.currentTime - t) > 1e-3) {
          el.currentTime = t;
          await nextFrameEvent(el);
        }
        compositor.ingestLayerFrame(layerId, el, order);
      }

      for (const { item, layerId, order } of overlays) {
        compositor.setLayerEffect(layerId, false, defaultCorridorKeyParams());
        compositor.setLayerBlend(layerId, item.blendMode ?? "normal");
        activeIds.push(layerId);
        const bmp = await rasterizeOverlay(item, f);
        compositor.ingestLayerFrame(layerId, bmp, order);
        bmp.close();
      }

      const sub = project.subtitles.find((s) => f >= s.startFrame && f < s.endFrame);
      if (sub) {
        rctx.clearRect(0, 0, width, height);
        drawSubtitle(rctx as unknown as CanvasRenderingContext2D, width, height, sub.text, project.subtitleStyle);
        const bmp = await createImageBitmap(rasterCanvas, { premultiplyAlpha: "premultiply" });
        compositor.setLayerEffect("__subtitle__", false, defaultCorridorKeyParams());
        compositor.ingestLayerFrame("__subtitle__", bmp, 1_000_000);
        activeIds.push("__subtitle__");
        bmp.close();
      }

      compositor.syncLayers(activeIds);
      compositor.render();
      await device.queue.onSubmittedWorkDone();

      const timestamp = Math.round((i * 1_000_000) / fps);
      const vframe = new VideoFrame(canvas, { timestamp, duration: Math.round(1_000_000 / fps) });
      videoEncoder.encode(vframe, { keyFrame: i % keyInterval === 0 });
      vframe.close();

      // Backpressure: don't let the encode queue grow unbounded.
      while (videoEncoder.encodeQueueSize > 8) {
        await new Promise((r) => setTimeout(r, 4));
        checkAbort();
      }

      onProgress({ phase: "video", frame: i + 1, totalFrames });
    }

    await videoEncoder.flush();
    if (encoderError) throw encoderError;

    // --- Audio mixdown + encode --------------------------------------------
    if (hasAudio) {
      onProgress({ phase: "audio", frame: totalFrames, totalFrames });
      const audioSampleRate = format === "mp4" ? project.settings.sampleRate : 48000;
      await mixAndEncodeAudio(project, options, audioSampleRate, addAudioChunk, format, signal);
    }

    onProgress({ phase: "finalizing", frame: totalFrames, totalFrames });
    if (mp4Muxer) mp4Muxer.finalize();
    else webmMuxer!.finalize();

    const buffer = mp4Target ? mp4Target.buffer : webmTarget!.buffer;
    const blob = new Blob([buffer], { type: format === "mp4" ? "video/mp4" : "video/webm" });
    const filename = `${project.name.replace(/[^\w.-]+/g, "_") || "webcut"}.${format}`;
    const chaptersVtt = projectChaptersToWebVtt(project, startFrame, endFrame);
    return { blob, filename, chaptersVtt };
  } finally {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    for (const bmp of imageBitmaps.values()) bmp.close();
    for (const el of videoEls.values()) {
      el.removeAttribute("src");
      el.load();
    }
    try { videoEncoder.close(); } catch { /* already closed */ }
    compositor.destroy();
    device.destroy();
  }
};

// ---------------------------------------------------------------------------
// Audio mixdown
// ---------------------------------------------------------------------------

const projectHasAudio = (project: Project, startFrame: number, endFrame: number): boolean => {
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const item of track.items) {
      if (item.type !== "clip" || item.audioMuted) continue;
      const asset = project.assets.find((a) => a.id === item.assetId);
      if (!asset || (asset.kind !== "audio" && asset.kind !== "video")) continue;
      if (item.startFrame < endFrame && item.startFrame + item.durationFrames > startFrame) return true;
    }
  }
  return false;
};

const decodeCache = new Map<string, AudioBuffer>();
const denoiseCache = new Map<string, AudioBuffer>();

const mixAndEncodeAudio = async (
  project: Project,
  options: ExportOptions,
  sampleRate: number,
  addAudioChunk: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void,
  format: ExportFormat,
  signal?: AbortSignal,
): Promise<void> => {
  const { frameRate, startFrame, endFrame } = options;
  const durationSec = (endFrame - startFrame) / frameRate;
  const length = Math.max(1, Math.ceil(durationSec * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });

  // Mute/solo comes from the shared rule so the render matches what preview
  // played back (see services/audioRouting.ts).
  const audible = audibleTrackIds(project);

  for (const track of project.tracks) {
    if (!audible.has(track.id)) continue;
    const trackGain = track.gainDb ?? 0;
    const pan = track.pan ?? 0;
    for (const item of track.items) {
      if (item.type !== "clip" || item.audioMuted) continue;
      const clip = item as ClipItem;
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset || (asset.kind !== "audio" && asset.kind !== "video")) continue;
      if (clip.startFrame >= endFrame || clip.startFrame + clip.durationFrames <= startFrame) continue;

      let buffer = decodeCache.get(asset.handleKey);
      if (!buffer) {
        try {
          const file = await fileSystemService.resolveMediaFile(asset.handleKey);
          buffer = await ctx.decodeAudioData(await file.arrayBuffer());
          decodeCache.set(asset.handleKey, buffer);
        } catch {
          continue; // asset has no decodable audio track — skip
        }
      }
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");

      // Noise reduction (#58): spectral subtraction on the decoded buffer.
      // Cached separately per (asset, strength) so a shared source isn't
      // re-denoised for every clip that references it.
      let playBuffer = buffer;
      const strength = clip.denoiseStrength ?? 0;
      if (strength > 0) {
        const key = `${asset.handleKey}|dn${strength.toFixed(2)}`;
        let denoised = denoiseCache.get(key);
        if (!denoised) {
          const { denoiseAudioBuffer } = await import("./denoise");
          denoised = denoiseAudioBuffer(ctx, buffer, strength);
          denoiseCache.set(key, denoised);
        }
        playBuffer = denoised;
      }

      const src = ctx.createBufferSource();
      src.buffer = playBuffer;
      src.playbackRate.value = Math.max(0.01, Math.abs(clip.speed));

      const gainNode = ctx.createGain();
      const baseDb = clip.audioGainDb + trackGain;
      // Apply keyframed gain ramp (dB) on top of the base gain.
      const when = (clip.startFrame - startFrame) / frameRate;
      if (clip.gainRamp && clip.gainRamp.kind === "animated") {
        const kfs = clip.gainRamp.keyframes;
        gainNode.gain.setValueAtTime(dbToVolume(baseDb + sampleAnimatable(clip.gainRamp, 0)), Math.max(0, when));
        for (const kf of kfs) {
          const t = Math.max(0, when + kf.frame / frameRate);
          gainNode.gain.linearRampToValueAtTime(dbToVolume(baseDb + kf.value), t);
        }
      } else {
        gainNode.gain.value = dbToVolume(baseDb);
      }

      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));

      // Fade transitions apply an audio-side gain envelope too. Wipes leave
      // audio at full volume — matches Premiere/FCP conventions.
      if (clip.transitionIn && clip.transitionIn.kind === "fade") {
        const dur = clip.transitionIn.frames / frameRate;
        gainNode.gain.setValueAtTime(0, Math.max(0, when));
        gainNode.gain.linearRampToValueAtTime(dbToVolume(baseDb), Math.max(0, when) + dur);
      }
      if (clip.transitionOut && clip.transitionOut.kind === "fade") {
        const dur = clip.transitionOut.frames / frameRate;
        const outStart = when + (clip.durationFrames - clip.transitionOut.frames) / frameRate;
        gainNode.gain.setValueAtTime(dbToVolume(baseDb), Math.max(0, outStart));
        gainNode.gain.linearRampToValueAtTime(0, Math.max(0, outStart) + dur);
      }

      src.connect(gainNode).connect(panner).connect(ctx.destination);
      const offset = clip.sourceInFrame / frameRate;
      const playDur = clip.durationFrames / frameRate;
      src.start(Math.max(0, when), offset, playDur);
    }
  }

  const rendered = await ctx.startRendering();

  // Encode the mixdown. AAC wants the container sample rate; Opus is fixed 48k.
  let audioError: unknown = null;
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => addAudioChunk(chunk, meta ?? undefined),
    error: (e) => { audioError = e; },
  });
  audioEncoder.configure({
    codec: format === "mp4" ? "mp4a.40.2" : "opus",
    sampleRate,
    numberOfChannels: 2,
    bitrate: 192_000,
  });

  const channels = 2;
  const block = 1024;
  const left = rendered.getChannelData(0);
  const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rendered.getChannelData(0);
  for (let i = 0; i < rendered.length; i += block) {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    if (audioError) throw audioError;
    const frames = Math.min(block, rendered.length - i);
    const planar = new Float32Array(frames * channels);
    planar.set(left.subarray(i, i + frames), 0);
    planar.set(right.subarray(i, i + frames), frames);
    const data = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round((i / sampleRate) * 1_000_000),
      data: planar,
    });
    audioEncoder.encode(data);
    data.close();
    while (audioEncoder.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 2));
  }
  await audioEncoder.flush();
  if (audioError) throw audioError;
  audioEncoder.close();
};

/** Longest clip end across all tracks, in frames (the natural export end). */
export const projectEndFrame = (project: Project): number => {
  let max = 0;
  for (const track of project.tracks) {
    for (const item of track.items) max = Math.max(max, item.startFrame + item.durationFrames);
  }
  return max;
};
