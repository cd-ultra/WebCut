/**
 * WebCut — audio noise reduction / repair (#58).
 *
 * Classic STFT spectral subtraction:
 *   1. Frame the signal into 50%-overlapping Hann windows.
 *   2. FFT each frame.
 *   3. Estimate the noise magnitude spectrum from the quietest frames (the
 *      assumption being that noise-only frames exist somewhere in the clip).
 *   4. Subtract a `strength`-scaled noise spectrum from each frame's magnitude,
 *      flooring at a small fraction to avoid musical-noise artifacts.
 *   5. Inverse-FFT with the original phase and overlap-add.
 *
 * Pure DSP over an AudioBuffer — no model, deterministic, testable. Runs in the
 * export mixdown (there's no live audio-processing graph for preview yet, so
 * the effect is export-only; the UI says so).
 */

const FFT_SIZE = 1024;
const HOP = FFT_SIZE / 2;

// --- Iterative radix-2 Cooley–Tukey FFT (in-place) --------------------------

const bitReverse = (re: Float32Array, im: Float32Array): void => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
};

const fft = (re: Float32Array, im: Float32Array, inverse: boolean): void => {
  const n = re.length;
  bitReverse(re, im);
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI;
        const bI = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + len / 2] = aR - bR;
        im[i + k + len / 2] = aI - bI;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
};

const hannWindow = (size: number): Float32Array => {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
};

/**
 * Denoise a single channel via spectral subtraction. `strength` 0..1 scales
 * how aggressively the estimated noise floor is removed.
 */
export const denoiseChannel = (input: Float32Array, strength: number): Float32Array => {
  if (strength <= 0 || input.length < FFT_SIZE) return input.slice();
  const window = hannWindow(FFT_SIZE);
  const numFrames = Math.floor((input.length - FFT_SIZE) / HOP) + 1;
  if (numFrames <= 0) return input.slice();

  // Pass 1: compute per-frame magnitude spectra + per-frame energy.
  const mags: Float32Array[] = [];
  const phases: Float32Array[] = [];
  const energies: number[] = [];
  const bins = FFT_SIZE / 2 + 1;
  for (let f = 0; f < numFrames; f++) {
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    const start = f * HOP;
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = input[start + i] * window[i];
      re[i] = s;
      energy += s * s;
    }
    fft(re, im, false);
    const mag = new Float32Array(bins);
    const ph = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      ph[k] = Math.atan2(im[k], re[k]);
    }
    mags.push(mag);
    phases.push(ph);
    energies.push(energy);
  }

  // Noise estimate: average the magnitude spectra of the quietest 10% of frames.
  const order = energies.map((e, i) => ({ e, i })).sort((a, b) => a.e - b.e);
  const quietCount = Math.max(1, Math.floor(numFrames * 0.1));
  const noiseMag = new Float32Array(bins);
  for (let q = 0; q < quietCount; q++) {
    const mag = mags[order[q].i];
    for (let k = 0; k < bins; k++) noiseMag[k] += mag[k];
  }
  for (let k = 0; k < bins; k++) noiseMag[k] /= quietCount;

  // Pass 2: subtract + reconstruct via overlap-add.
  const out = new Float32Array(input.length);
  const norm = new Float32Array(input.length);
  const floor = 0.05; // spectral floor to suppress musical noise
  for (let f = 0; f < numFrames; f++) {
    const mag = mags[f];
    const ph = phases[f];
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    for (let k = 0; k < bins; k++) {
      const cleaned = Math.max(mag[k] - strength * noiseMag[k], floor * mag[k]);
      re[k] = cleaned * Math.cos(ph[k]);
      im[k] = cleaned * Math.sin(ph[k]);
      // Hermitian symmetry for the negative frequencies.
      if (k > 0 && k < FFT_SIZE / 2) {
        re[FFT_SIZE - k] = re[k];
        im[FFT_SIZE - k] = -im[k];
      }
    }
    fft(re, im, true);
    const start = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      out[start + i] += re[i] * window[i];
      norm[start + i] += window[i] * window[i];
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (norm[i] > 1e-6) out[i] /= norm[i];
  }
  return out;
};

/**
 * Denoise every channel of an AudioBuffer into a new buffer created on `ctx`.
 * Returns the original buffer unchanged when `strength <= 0`.
 */
export const denoiseAudioBuffer = (
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  strength: number,
): AudioBuffer => {
  if (strength <= 0) return buffer;
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.copyToChannel(denoiseChannel(buffer.getChannelData(ch), strength), ch);
  }
  return out;
};
