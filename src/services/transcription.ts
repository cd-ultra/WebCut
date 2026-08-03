/**
 * WebCut — automatic transcription (#8) via browser Whisper.
 *
 * Runs the export range through an OfflineAudioContext mixdown at 16 kHz mono,
 * then dynamically imports @xenova/transformers (transformers.js) to invoke
 * the openai/whisper-tiny.en pipeline. Segments are pushed into the project as
 * Subtitle records via the store.
 *
 * The transformers.js library is >40 MB unpacked; we DYNAMICALLY import it so
 * it never touches the initial page load. Model weights download to the
 * browser Cache API on first use (~40 MB fp16 tiny.en) and are re-used after.
 *
 * Requires cross-origin isolation for WebAssembly SIMD + threads (already set
 * in vite.config.ts / vercel.json).
 */

import { fileSystemService } from "./FileSystemService";
import type { ClipItem, Project } from "../types/timeline";

export interface TranscribeOptions {
  /** Inclusive start / exclusive end of the transcription range, in frames. */
  readonly startFrame: number;
  readonly endFrame: number;
  /**
   * Whisper model repo id on Hugging Face. tiny.en is smallest & fastest;
   * bump to `Xenova/whisper-base.en` (~140 MB) for better accuracy.
   */
  readonly modelId?: string;
}

export interface TranscribeProgress {
  readonly phase: "loading-model" | "mixing" | "transcribing" | "finalizing";
  /** Fraction complete, 0..1 (best-effort — transformers.js phases are opaque). */
  readonly progress: number;
  readonly message?: string;
}

export interface Segment {
  /** Start time in seconds relative to the transcription range. */
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
}

export interface TranscribeResult {
  readonly segments: readonly Segment[];
}

// Whisper is trained on 16 kHz mono PCM — mismatched sample rate silently
// destroys accuracy, so this is a hard requirement of the pipeline.
const WHISPER_SAMPLE_RATE = 16_000;

/**
 * Mix down every audible clip in the range to a mono Float32Array at 16 kHz.
 * Reuses the same routing pattern as ExportService's mixdown (clip gain +
 * gain ramp + track gain + speed).
 */
const mixdownForTranscription = async (
  project: Project,
  startFrame: number,
  endFrame: number,
  onProgress: (p: TranscribeProgress) => void,
  signal?: AbortSignal,
): Promise<Float32Array> => {
  const fps = project.settings.frameRate;
  const durationSec = (endFrame - startFrame) / fps;
  const length = Math.max(1, Math.ceil(durationSec * WHISPER_SAMPLE_RATE));
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: WHISPER_SAMPLE_RATE });

  for (const track of project.tracks) {
    if (track.muted) continue;
    const trackGain = track.gainDb ?? 0;
    for (const item of track.items) {
      if (item.type !== "clip" || item.audioMuted) continue;
      const clip = item as ClipItem;
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset || (asset.kind !== "audio" && asset.kind !== "video")) continue;
      if (clip.startFrame >= endFrame || clip.startFrame + clip.durationFrames <= startFrame) continue;

      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      let buffer: AudioBuffer;
      try {
        const file = await fileSystemService.resolveMediaFile(asset.handleKey);
        buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      } catch {
        continue;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = Math.max(0.01, Math.abs(clip.speed));

      const gain = ctx.createGain();
      const baseDb = clip.audioGainDb + trackGain;
      gain.gain.value = Math.pow(10, baseDb / 20);

      src.connect(gain).connect(ctx.destination);
      const when = (clip.startFrame - startFrame) / fps;
      src.start(Math.max(0, when), clip.sourceInFrame / fps, clip.durationFrames / fps);
    }
  }

  onProgress({ phase: "mixing", progress: 0.2, message: "Mixing audio…" });
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
};

// Cache the loaded pipeline across invocations so the model download only
// hits the network once per session.
let cachedPipeline: unknown = null;
let cachedModelId: string | null = null;

const loadWhisperPipeline = async (modelId: string): Promise<(pcm: Float32Array, opts: unknown) => Promise<unknown>> => {
  if (cachedPipeline && cachedModelId === modelId) return cachedPipeline as (pcm: Float32Array, opts: unknown) => Promise<unknown>;
  // Dynamic import: keeps the ~46 MB library out of the initial bundle.
  const mod = await import("@xenova/transformers");
  // transformers.js `pipeline` is the standard entrypoint; it downloads the
  // model + tokenizer + processor and returns a callable.
  const pipe = await mod.pipeline("automatic-speech-recognition", modelId);
  cachedPipeline = pipe;
  cachedModelId = modelId;
  return pipe as unknown as (pcm: Float32Array, opts: unknown) => Promise<unknown>;
};

/**
 * Transcribe the audible tracks over the export range. Returns segments with
 * timings relative to `startFrame` (not absolute project time — the caller
 * offsets them into project frames when creating Subtitles).
 */
export const transcribeProject = async (
  project: Project,
  options: TranscribeOptions,
  onProgress: (p: TranscribeProgress) => void,
  signal?: AbortSignal,
): Promise<TranscribeResult> => {
  const modelId = options.modelId ?? "Xenova/whisper-tiny.en";
  onProgress({ phase: "loading-model", progress: 0, message: `Loading ${modelId}…` });
  const pipe = await loadWhisperPipeline(modelId);
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

  const pcm = await mixdownForTranscription(project, options.startFrame, options.endFrame, onProgress, signal);
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

  onProgress({ phase: "transcribing", progress: 0.5, message: "Transcribing…" });
  // `return_timestamps: true` makes transformers.js chunk long-form audio and
  // emit per-chunk timings; `chunk_length_s` is the model's native 30 s frame.
  const raw = (await pipe(pcm, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  } as unknown)) as { chunks?: Array<{ timestamp: [number | null, number | null]; text: string }> } | { text: string };

  onProgress({ phase: "finalizing", progress: 0.95 });
  const segments: Segment[] = [];
  if ("chunks" in raw && Array.isArray(raw.chunks)) {
    for (const c of raw.chunks) {
      const [s, e] = c.timestamp;
      if (s == null || e == null || !c.text.trim()) continue;
      segments.push({ startSec: s, endSec: Math.max(s + 0.1, e), text: c.text.trim() });
    }
  } else if ("text" in raw && raw.text.trim()) {
    // Single-utterance fallback for short audio: pin to the whole range.
    const durSec = (options.endFrame - options.startFrame) / project.settings.frameRate;
    segments.push({ startSec: 0, endSec: durSec, text: raw.text.trim() });
  }

  onProgress({ phase: "finalizing", progress: 1 });
  return { segments };
};

/** Convert model segment times to project frames. */
export const segmentsToSubtitleFrames = (
  segments: readonly Segment[],
  startFrame: number,
  frameRate: number,
): Array<{ startFrame: number; endFrame: number; text: string }> =>
  segments.map((s) => ({
    startFrame: startFrame + Math.round(s.startSec * frameRate),
    endFrame: startFrame + Math.max(1, Math.round(s.endSec * frameRate)),
    text: s.text,
  }));
