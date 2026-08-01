/**
 * WebCut — audio loudness (ITU-R BS.1770 / EBU R128) and auto-ducking.
 *
 * Two capabilities, both pure DSP over decoded PCM (AudioBuffer):
 *
 *  • Integrated loudness in LUFS (#54): K-weighting (a two-stage biquad —
 *    high-shelf + high-pass), 400 ms mean-square blocks with the absolute
 *    (−70 LUFS) and relative (−10 LU) gates from BS.1770-4, plus true-ish
 *    sample peak. Used to normalize clips to a delivery target (e.g. −14 LUFS
 *    for streaming, −23 for broadcast).
 *
 *  • Auto-ducking (#53): derive a smoothed loudness envelope from a dialogue
 *    buffer and turn it into gain-automation keyframes that pull a music bed
 *    down whenever dialogue is present, with attack/release smoothing.
 */

import { createId, type Keyframe, type KeyframeId } from "../types/timeline";

// ---------------------------------------------------------------------------
// K-weighting biquads (48 kHz reference coefficients, retuned per sample rate)
// ---------------------------------------------------------------------------

interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

/**
 * BS.1770 pre-filter (stage 1): high-frequency shelving boost modeling the
 * acoustic effect of the head. Coefficients derived for the working sample
 * rate via the bilinear transform of the reference analog prototype.
 */
const shelvingFilter = (fs: number): Biquad => {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
};

/** BS.1770 pre-filter (stage 2): a simple high-pass ("RLB") weighting. */
const highpassFilter = (fs: number): Biquad => {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / fs);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
};

const applyBiquad = (input: Float32Array, f: Biquad): Float32Array => {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
};

export interface LoudnessResult {
  /** Integrated (gated) loudness, LUFS. -Infinity for silence. */
  readonly integratedLufs: number;
  /** Sample peak, dBFS. */
  readonly peakDb: number;
}

/** Per-channel weighting from BS.1770 (mono/stereo; surround unused here). */
const channelWeight = (channelCount: number, channel: number): number => {
  // L, R = 1.0; C = 1.0; Ls, Rs = 1.41. We only ever see 1–2 channels.
  void channelCount;
  return channel < 2 ? 1.0 : 1.41;
};

/** Measure integrated loudness (LUFS) and sample peak of an AudioBuffer. */
export const measureLoudness = (buffer: AudioBuffer): LoudnessResult => {
  const fs = buffer.sampleRate;
  const shelf = shelvingFilter(fs);
  const hp = highpassFilter(fs);
  const channels = buffer.numberOfChannels;

  // K-weight every channel and accumulate weighted mean-square per 400 ms block.
  const blockSize = Math.round(0.4 * fs);
  const hop = Math.round(0.1 * fs); // 75% overlap
  const weighted: Float32Array[] = [];
  let peak = 0;
  for (let ch = 0; ch < channels; ch++) {
    const raw = buffer.getChannelData(ch);
    for (let i = 0; i < raw.length; i++) peak = Math.max(peak, Math.abs(raw[i]));
    weighted.push(applyBiquad(applyBiquad(raw, shelf), hp));
  }

  const totalSamples = buffer.length;
  const blockLoudness: number[] = [];
  for (let start = 0; start + blockSize <= totalSamples; start += hop) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const data = weighted[ch];
      let ms = 0;
      for (let i = 0; i < blockSize; i++) {
        const s = data[start + i];
        ms += s * s;
      }
      sum += channelWeight(channels, ch) * (ms / blockSize);
    }
    // Loudness of the block, LKFS.
    blockLoudness.push(-0.691 + 10 * Math.log10(sum + 1e-12));
  }

  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  if (blockLoudness.length === 0) return { integratedLufs: -Infinity, peakDb };

  // Absolute gate at -70 LUFS.
  const meanSquareFromLoudness = (l: number) => Math.pow(10, (l + 0.691) / 10);
  const absGated = blockLoudness.filter((l) => l > -70);
  if (absGated.length === 0) return { integratedLufs: -Infinity, peakDb };
  const absMean = absGated.reduce((a, l) => a + meanSquareFromLoudness(l), 0) / absGated.length;
  const absLoudness = -0.691 + 10 * Math.log10(absMean + 1e-12);

  // Relative gate at -10 LU below the absolute-gated mean.
  const relThreshold = absLoudness - 10;
  const relGated = blockLoudness.filter((l) => l > relThreshold && l > -70);
  if (relGated.length === 0) return { integratedLufs: absLoudness, peakDb };
  const relMean = relGated.reduce((a, l) => a + meanSquareFromLoudness(l), 0) / relGated.length;
  const integratedLufs = -0.691 + 10 * Math.log10(relMean + 1e-12);

  return { integratedLufs, peakDb };
};

/** Gain (dB) to apply so `current` LUFS reaches `target` LUFS. */
export const gainToTargetLufs = (current: number, target: number): number => {
  if (!Number.isFinite(current)) return 0;
  return target - current;
};

/** Common delivery targets (LUFS). */
export const LUFS_TARGETS: readonly { readonly label: string; readonly lufs: number }[] = [
  { label: "Streaming (−14)", lufs: -14 },
  { label: "Podcast (−16)", lufs: -16 },
  { label: "Broadcast R128 (−23)", lufs: -23 },
];

// ---------------------------------------------------------------------------
// Auto-ducking
// ---------------------------------------------------------------------------

export interface DuckOptions {
  /** Loudness (dBFS RMS) above which dialogue is considered "present". */
  readonly thresholdDb: number;
  /** How far to pull the music down while ducked, dB (negative). */
  readonly duckDb: number;
  /** Ramp-down time entering a duck, in frames. */
  readonly attackFrames: number;
  /** Ramp-up time leaving a duck, in frames. */
  readonly releaseFrames: number;
}

export const defaultDuckOptions = (): DuckOptions => ({
  thresholdDb: -40,
  duckDb: -12,
  attackFrames: 3,
  releaseFrames: 12,
});

/**
 * Build gain-automation keyframes (dB, over the music clip's local frames) that
 * duck under a dialogue buffer. `frameCount` is the music clip's duration in
 * frames; `dialogueOffsetFrames` aligns the dialogue buffer's start to the
 * music clip's local frame 0.
 */
export const computeDuckingKeyframes = (
  dialogue: AudioBuffer,
  fps: number,
  frameCount: number,
  dialogueOffsetFrames: number,
  opts: DuckOptions = defaultDuckOptions(),
): Keyframe<number>[] => {
  const fs = dialogue.sampleRate;
  const samplesPerFrame = fs / fps;
  const ch0 = dialogue.getChannelData(0);

  // Per-frame RMS envelope of the dialogue, in dBFS.
  const present: boolean[] = new Array(frameCount).fill(false);
  for (let f = 0; f < frameCount; f++) {
    const dialogueFrame = f - dialogueOffsetFrames;
    if (dialogueFrame < 0) continue;
    const start = Math.floor(dialogueFrame * samplesPerFrame);
    const end = Math.min(ch0.length, Math.floor((dialogueFrame + 1) * samplesPerFrame));
    if (start >= ch0.length) break;
    let ms = 0;
    let n = 0;
    for (let i = start; i < end; i++) {
      ms += ch0[i] * ch0[i];
      n++;
    }
    const rmsDb = n > 0 ? 10 * Math.log10(ms / n + 1e-12) : -Infinity;
    present[f] = rmsDb > opts.thresholdDb;
  }

  // Target gain per frame with attack/release smoothing toward duck/unity.
  const gain: number[] = new Array(frameCount).fill(0);
  let current = 0;
  for (let f = 0; f < frameCount; f++) {
    const target = present[f] ? opts.duckDb : 0;
    const step = target < current ? -opts.duckDb / Math.max(1, opts.attackFrames) : opts.duckDb / Math.max(1, opts.releaseFrames);
    // Move `current` toward target by at most |step| (step is a positive magnitude here).
    const mag = Math.abs(step);
    if (current < target) current = Math.min(target, current + mag);
    else if (current > target) current = Math.max(target, current - mag);
    gain[f] = current;
  }

  // Emit keyframes only where the gain changes slope (compress flat runs).
  const keyframes: Keyframe<number>[] = [];
  const push = (frame: number, value: number) =>
    keyframes.push({ id: createId<KeyframeId>(), frame, value, interpolation: "linear" });
  for (let f = 0; f < frameCount; f++) {
    const prev = f > 0 ? gain[f - 1] : gain[0];
    const next = f < frameCount - 1 ? gain[f + 1] : gain[f];
    const isCorner = f === 0 || f === frameCount - 1 || Math.sign(gain[f] - prev) !== Math.sign(next - gain[f]);
    if (isCorner) push(f, gain[f]);
  }
  return keyframes;
};

// ---------------------------------------------------------------------------
// Decode helper
// ---------------------------------------------------------------------------

let sharedCtx: AudioContext | OfflineAudioContext | null = null;

/** Decode a media File/Blob's audio track into an AudioBuffer for analysis. */
export const decodeAudio = async (data: ArrayBuffer): Promise<AudioBuffer> => {
  if (!sharedCtx) {
    const Ctor =
      (window.AudioContext as typeof AudioContext) ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new Ctor();
  }
  // decodeAudioData wants its own copy of the buffer.
  return sharedCtx.decodeAudioData(data.slice(0));
};
