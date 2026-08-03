/**
 * WebCut — scene / cut detection (#56).
 *
 * Two independent detectors that both emit clip-local frame offsets where a
 * clip could be split:
 *
 *   • Silence: decode the clip's audio, compute a per-frame RMS envelope, and
 *     find gaps that stay below a threshold for a minimum duration. The split
 *     point is the middle of each silent gap (a natural "sentence boundary").
 *
 *   • Shot change: grayscale frame differencing via the shared FrameGrabber.
 *     A normalized sum-of-absolute-differences spike above a threshold (and
 *     past a refractory window) marks a hard cut.
 *
 * Neither mutates the project — the caller splits at the returned frames using
 * the store's splitItemAtFrame.
 */

import { decodeAudio } from "./loudness";
import { fileSystemService } from "./FileSystemService";
import { openFrameGrabber } from "./motionTrack";
import type { MediaAsset } from "../types/timeline";

export type DetectMode = "silence" | "shots";

export interface SilenceOptions {
  /** RMS level below which audio counts as "silent", in dBFS. */
  readonly thresholdDb: number;
  /** Minimum silent-gap length to trigger a split, in frames. */
  readonly minGapFrames: number;
}

export interface ShotOptions {
  /** Normalized frame-difference [0..1] above which a cut is declared. */
  readonly threshold: number;
  /** Minimum frames between successive cuts (refractory period). */
  readonly minGapFrames: number;
}

export interface DetectProgress {
  readonly frame: number;
  readonly totalFrames: number;
}

export const defaultSilenceOptions = (): SilenceOptions => ({ thresholdDb: -45, minGapFrames: 12 });
export const defaultShotOptions = (): ShotOptions => ({ threshold: 0.28, minGapFrames: 8 });

/**
 * Detect silence-bounded split points within a clip. Returns clip-local frame
 * offsets (0 < f < durationFrames). Empty when the asset has no audio.
 */
export const detectSilenceSplits = async (
  asset: MediaAsset,
  sourceInFrame: number,
  totalFrames: number,
  fps: number,
  options: SilenceOptions = defaultSilenceOptions(),
): Promise<number[]> => {
  let buffer: AudioBuffer;
  try {
    const file = await fileSystemService.resolveMediaFile(asset.handleKey);
    buffer = await decodeAudio(await file.arrayBuffer());
  } catch {
    return [];
  }
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const samplesPerFrame = sr / fps;

  // Per-frame RMS in dBFS, over the clip's local range.
  const isSilent: boolean[] = new Array(totalFrames).fill(false);
  for (let f = 0; f < totalFrames; f++) {
    const start = Math.floor((sourceInFrame + f) * samplesPerFrame);
    const end = Math.min(ch.length, Math.floor((sourceInFrame + f + 1) * samplesPerFrame));
    if (start >= ch.length) break;
    let ms = 0;
    let n = 0;
    for (let i = start; i < end; i++) { ms += ch[i] * ch[i]; n++; }
    const rmsDb = n > 0 ? 10 * Math.log10(ms / n + 1e-12) : -Infinity;
    isSilent[f] = rmsDb < options.thresholdDb;
  }

  // Collapse silent runs; split at the middle of any run >= minGapFrames.
  const splits: number[] = [];
  let runStart = -1;
  for (let f = 0; f <= totalFrames; f++) {
    const silent = f < totalFrames && isSilent[f];
    if (silent && runStart < 0) runStart = f;
    else if (!silent && runStart >= 0) {
      const len = f - runStart;
      if (len >= options.minGapFrames) {
        const mid = Math.round(runStart + len / 2);
        if (mid > 0 && mid < totalFrames) splits.push(mid);
      }
      runStart = -1;
    }
  }
  return splits;
};

/**
 * Detect hard-cut split points by grayscale frame differencing. Returns
 * clip-local frame offsets. `onProgress` fires periodically for the UI.
 */
export const detectShotSplits = async (
  asset: MediaAsset,
  sourceInFrame: number,
  totalFrames: number,
  fps: number,
  onProgress: (p: DetectProgress) => void,
  signal: AbortSignal | undefined,
  options: ShotOptions = defaultShotOptions(),
): Promise<number[]> => {
  if (asset.kind === "audio") return [];
  const grabber = await openFrameGrabber(asset, sourceInFrame, fps);
  const w = grabber.width;
  const h = grabber.height;
  const pixelCount = w * h;
  try {
    const splits: number[] = [];
    let prev = await grabber.grab(0);
    let lastCut = -options.minGapFrames;
    for (let f = 1; f < totalFrames; f++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const cur = await grabber.grab(f);
      // Mean absolute difference (already in [0,1] since gray is normalized).
      let sad = 0;
      for (let i = 0; i < pixelCount; i++) sad += Math.abs(cur[i] - prev[i]);
      const diff = sad / pixelCount;
      if (diff > options.threshold && f - lastCut >= options.minGapFrames) {
        splits.push(f);
        lastCut = f;
      }
      prev = cur;
      if (f % 4 === 0) {
        onProgress({ frame: f + 1, totalFrames });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    onProgress({ frame: totalFrames, totalFrames });
    return splits;
  } finally {
    grabber.dispose();
  }
};
