/**
 * WebCut — warp stabilizer (#61).
 *
 * Two-pass stabilization built on the point-tracker's LK core:
 *   1. Analyze: track a sparse grid of points frame-to-frame and aggregate
 *      per-frame camera motion (median translation).
 *   2. Smooth: convolve the raw path with a Gaussian window.
 *   3. Apply: bake the (raw − smooth) residual as inverse position keyframes
 *      on the clip's transform.position — this cancels the shakiness.
 *   4. (Optional) crop-to-fit: also write a constant scale keyframe > 1 so
 *      the moving frame edges never expose the empty canvas.
 *
 * Translation-only (no rotation / scale) in this MVP — Nuke-grade stabilization
 * needs affine or homography. Follow-up.
 */

import { openFrameGrabber, trackOne, MOTION_TRACK_DEFAULTS, type LKOptions } from "./motionTrack";
import type { MediaAsset } from "../types/timeline";

export interface StabilizeOptions {
  /** Grid spacing in normalized units [0..1]; 0.1 = a 10×10 grid inside the frame. */
  readonly gridSpacing?: number;
  /** Smoothing window sigma in frames (larger = smoother, less responsive). */
  readonly smoothSigma?: number;
  /**
   * Add a constant scale > 1 so the moving frame never exposes empty canvas.
   * `null` disables crop-to-fit. Set to the max residual magnitude in pixels
   * to auto-compute — the UI wires this after the analyze pass.
   */
  readonly cropToFit?: boolean;
  readonly lkOptions?: LKOptions;
}

export interface StabilizeProgress {
  readonly frame: number;
  readonly totalFrames: number;
  readonly phase: "analyzing" | "smoothing" | "done";
}

export interface StabilizeResult {
  /** Per-frame residual translation (pixels) that cancels the shake, in source coords. */
  readonly residuals: Array<{ frame: number; dx: number; dy: number }>;
  /** Recommended crop scale > 1 to hide edge exposure. 1 = no crop needed. */
  readonly recommendedCropScale: number;
  /** Max |dx|, |dy| across the residual path — used to derive the crop scale. */
  readonly maxDx: number;
  readonly maxDy: number;
}

const DEFAULT_OPTIONS: Required<Omit<StabilizeOptions, "lkOptions">> & { readonly lkOptions: Required<LKOptions> } = {
  gridSpacing: 0.15,
  smoothSigma: 20,
  cropToFit: true,
  lkOptions: MOTION_TRACK_DEFAULTS,
};

/** 1D Gaussian smoothing with reflection at the edges. */
const gaussianSmooth = (input: number[], sigma: number): number[] => {
  if (sigma <= 0) return input.slice();
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const k = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(k);
    sum += k;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const N = input.length;
  const out = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = Math.max(0, Math.min(N - 1, i + j));
      acc += input[idx] * kernel[j + radius];
    }
    out[i] = acc;
  }
  return out;
};

/**
 * Analyze a clip's frames and compute residual motion. Doesn't mutate the
 * project — the caller decides how to apply the result (write position +
 * scale keyframes, or preview).
 */
export const analyzeStabilization = async (
  asset: MediaAsset,
  sourceInFrame: number,
  totalFrames: number,
  fps: number,
  onProgress: (p: StabilizeProgress) => void,
  signal: AbortSignal | undefined,
  options: StabilizeOptions = {},
): Promise<StabilizeResult> => {
  const opts = { ...DEFAULT_OPTIONS, ...options, lkOptions: { ...MOTION_TRACK_DEFAULTS, ...options.lkOptions } };
  const grabber = await openFrameGrabber(asset, sourceInFrame, fps);
  const w = grabber.width;
  const h = grabber.height;

  // Seed a sparse grid of tracking points inside the frame (avoiding a 10%
  // border to reduce edge instability).
  const border = 0.1;
  const gridPointsSource: Array<{ x: number; y: number }> = [];
  for (let ny = border; ny < 1 - border + 1e-6; ny += opts.gridSpacing) {
    for (let nx = border; nx < 1 - border + 1e-6; nx += opts.gridSpacing) {
      gridPointsSource.push({ x: nx * w, y: ny * h });
    }
  }
  if (gridPointsSource.length === 0) {
    grabber.dispose();
    return { residuals: [], recommendedCropScale: 1, maxDx: 0, maxDy: 0 };
  }

  try {
    // Raw camera path (cumulative). Frame 0 has zero displacement by def.
    const rawX = [0];
    const rawY = [0];

    let prevFrame = await grabber.grab(0);
    let currentGrid = gridPointsSource.slice();

    for (let f = 1; f < totalFrames; f++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const cur = await grabber.grab(f);

      // Track each grid point independently, then take the median displacement.
      const dxs: number[] = [];
      const dys: number[] = [];
      const nextGrid: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < currentGrid.length; i++) {
        const seed = currentGrid[i];
        const result = trackOne(prevFrame, cur, w, h, seed, opts.lkOptions);
        if (result.confidence >= 0.3) {
          dxs.push(result.x - seed.x);
          dys.push(result.y - seed.y);
          nextGrid.push({ x: result.x, y: result.y });
        } else {
          // Reset lost points back to their seed for the next iteration.
          nextGrid.push({ x: gridPointsSource[i].x, y: gridPointsSource[i].y });
        }
      }
      const medianDx = dxs.length > 0 ? median(dxs) : 0;
      const medianDy = dys.length > 0 ? median(dys) : 0;
      rawX.push(rawX[rawX.length - 1] + medianDx);
      rawY.push(rawY[rawY.length - 1] + medianDy);

      // Refresh the grid periodically to prevent lock-in on shifted regions.
      currentGrid = f % 20 === 0 ? gridPointsSource.slice() : nextGrid;

      prevFrame = cur;
      if (f % 4 === 0) {
        onProgress({ frame: f + 1, totalFrames, phase: "analyzing" });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    onProgress({ frame: totalFrames, totalFrames, phase: "smoothing" });
    const smoothX = gaussianSmooth(rawX, opts.smoothSigma);
    const smoothY = gaussianSmooth(rawY, opts.smoothSigma);

    // Residual = raw − smooth. Inverse of this residual, applied as position
    // offset, cancels the shakiness while preserving the smoothed camera.
    const residuals: Array<{ frame: number; dx: number; dy: number }> = [];
    let maxDx = 0;
    let maxDy = 0;
    for (let f = 0; f < rawX.length; f++) {
      const dx = rawX[f] - smoothX[f];
      const dy = rawY[f] - smoothY[f];
      residuals.push({ frame: f, dx: -dx, dy: -dy });
      maxDx = Math.max(maxDx, Math.abs(dx));
      maxDy = Math.max(maxDy, Math.abs(dy));
    }

    const recommendedCropScale = opts.cropToFit
      ? Math.max(1.0, 1 + 2 * Math.max(maxDx / w, maxDy / h))
      : 1;

    onProgress({ frame: totalFrames, totalFrames, phase: "done" });
    return { residuals, recommendedCropScale, maxDx, maxDy };
  } finally {
    grabber.dispose();
  }
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) * 0.5 : sorted[mid];
};
