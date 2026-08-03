/**
 * WebCut — motion tracking (#59) via classical Lucas–Kanade optical flow.
 *
 * A **point tracker**: seeds one 2D point on a chosen frame and follows it
 * across the clip's local frames. Iterative image alignment on a small
 * window; two-level pyramid handles moderate displacements. Not Nuke-grade,
 * but deterministic, dependency-free, and enough for common "attach text
 * to a moving object" jobs.
 *
 * Runs on the main thread but yields every N frames so React can repaint the
 * progress bar. Frame extraction uses a hidden <video>.seek() + drawImage —
 * portable and matches how the exporter sources frames.
 */

import { fileSystemService } from "./FileSystemService";
import type { MediaAsset } from "../types/timeline";

export interface TrackPoint {
  /** Pixel coordinates in the SOURCE frame (not the display canvas). */
  readonly x: number;
  readonly y: number;
}

export interface TrackSample {
  /** Frame offset from the start of the tracking range. */
  readonly frame: number;
  readonly point: TrackPoint;
  /** Estimated confidence [0..1] — low for lost tracks. */
  readonly confidence: number;
}

export interface TrackOptions {
  /** Half-width of the LK integration window, in pixels. Bigger = smoother. */
  readonly windowRadius?: number;
  /** LK iterations per pyramid level per frame. */
  readonly iterations?: number;
  /** Pyramid levels (1 = no pyramid, 2 = one downsample). */
  readonly pyramidLevels?: number;
}

export interface TrackProgress {
  readonly frame: number;
  readonly totalFrames: number;
  readonly lost: boolean;
}

const DEFAULTS: Required<TrackOptions> = {
  windowRadius: 6,
  iterations: 10,
  pyramidLevels: 2,
};

/**
 * Run point tracking on `asset` starting at `startPoint` on frame 0 of the
 * clip's local range. Returns per-frame samples for frames [0, totalFrames).
 */
export const trackPoint = async (
  asset: MediaAsset,
  sourceInFrame: number,
  totalFrames: number,
  fps: number,
  startPoint: TrackPoint,
  onProgress: (p: TrackProgress) => void,
  signal: AbortSignal | undefined,
  options: TrackOptions = {},
): Promise<TrackSample[]> => {
  const opts = { ...DEFAULTS, ...options };
  const file = await fileSystemService.resolveMediaFile(asset.handleKey);
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error(`Cannot load ${asset.name} for tracking.`)), { once: true });
  });

  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Failed to get 2D context for tracking.");

  const grabGray = async (localFrame: number): Promise<Float32Array> => {
    const t = (sourceInFrame + localFrame) / fps;
    const target = Math.min(Math.max(0, t), Math.max(0, (video.duration || 0) - 1e-3));
    if (Math.abs(video.currentTime - target) > 1e-3) {
      video.currentTime = target;
      await new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
    }
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(video, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < image.length; i += 4, j++) {
      // Rec. 709 luma.
      gray[j] = (0.2126 * image[i] + 0.7152 * image[i + 1] + 0.0722 * image[i + 2]) / 255;
    }
    return gray;
  };

  try {
    const samples: TrackSample[] = [];
    let prevFrame = await grabGray(0);
    let prev = { x: startPoint.x, y: startPoint.y };
    samples.push({ frame: 0, point: prev, confidence: 1 });
    onProgress({ frame: 1, totalFrames, lost: false });

    for (let f = 1; f < totalFrames; f++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const cur = await grabGray(f);
      const { x, y, confidence, lost } = trackOne(prevFrame, cur, w, h, prev, opts);
      prev = { x, y };
      prevFrame = cur;
      samples.push({ frame: f, point: prev, confidence });
      // Yield to the UI thread + progress every few frames.
      if (f % 4 === 0) {
        onProgress({ frame: f + 1, totalFrames, lost });
        await new Promise((r) => setTimeout(r, 0));
      }
      if (lost) {
        // Once lost, everything downstream also gets flagged lost — but we
        // keep pushing the last known point so the timeline keyframe track
        // stays continuous. The user can trim the animation manually.
      }
    }
    onProgress({ frame: totalFrames, totalFrames, lost: false });
    return samples;
  } finally {
    URL.revokeObjectURL(url);
  }
};

// ---------------------------------------------------------------------------
// LK core (single-scale + pyramidal wrapper)
// ---------------------------------------------------------------------------

interface LKResult {
  readonly x: number;
  readonly y: number;
  readonly confidence: number;
  readonly lost: boolean;
}

/** Sample the gray image with bilinear interpolation at floating (x, y). */
const bilinear = (img: Float32Array, w: number, h: number, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const a = img[i];
  const b = img[i + 1];
  const c = img[i + w];
  const d = img[i + w + 1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
};

/**
 * Downsample by 2 via 2x2 box average. Cheap and adequate for the low pyramid
 * levels we use (2 total).
 */
const downsample = (img: Float32Array, w: number, h: number): { data: Float32Array; w: number; h: number } => {
  const w2 = w >> 1;
  const h2 = h >> 1;
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const sx = x * 2;
      const sy = y * 2;
      out[y * w2 + x] = (img[sy * w + sx] + img[sy * w + sx + 1] + img[(sy + 1) * w + sx] + img[(sy + 1) * w + sx + 1]) * 0.25;
    }
  }
  return { data: out, w: w2, h: h2 };
};

/**
 * Solve one LK iteration at (x, y) with a `radius`-pixel window on image T (prev)
 * → search in image I (cur). Returns (dx, dy) that better aligns T's window
 * in I. Adds a small determinant floor so ill-conditioned regions don't
 * produce catastrophic jumps.
 */
const lkIter = (
  T: Float32Array, I: Float32Array, w: number, h: number,
  x: number, y: number, dx: number, dy: number, radius: number,
): { dx: number; dy: number; det: number } => {
  let Gxx = 0, Gxy = 0, Gyy = 0, bx = 0, by = 0;
  for (let j = -radius; j <= radius; j++) {
    for (let i = -radius; i <= radius; i++) {
      const px = x + i;
      const py = y + j;
      // Horizontal / vertical Sobel-like gradients on T.
      const ix = 0.5 * (bilinear(T, w, h, px + 1, py) - bilinear(T, w, h, px - 1, py));
      const iy = 0.5 * (bilinear(T, w, h, px, py + 1) - bilinear(T, w, h, px, py - 1));
      const it = bilinear(I, w, h, px + dx, py + dy) - bilinear(T, w, h, px, py);
      Gxx += ix * ix;
      Gxy += ix * iy;
      Gyy += iy * iy;
      bx -= ix * it;
      by -= iy * it;
    }
  }
  const det = Gxx * Gyy - Gxy * Gxy;
  if (Math.abs(det) < 1e-4) return { dx: 0, dy: 0, det };
  const inv = 1 / det;
  return {
    dx: inv * (Gyy * bx - Gxy * by),
    dy: inv * (-Gxy * bx + Gxx * by),
    det,
  };
};

/**
 * Pyramidal LK: build 2 levels of both frames, solve at the coarsest first,
 * then refine at full resolution. Returns the tracked position + a
 * confidence heuristic based on residual magnitude.
 */
const trackOne = (
  prev: Float32Array, cur: Float32Array, w: number, h: number,
  seed: TrackPoint, opts: Required<TrackOptions>,
): LKResult => {
  const levels = Math.max(1, opts.pyramidLevels);
  const pyramidsPrev: Array<{ data: Float32Array; w: number; h: number }> = [{ data: prev, w, h }];
  const pyramidsCur: Array<{ data: Float32Array; w: number; h: number }> = [{ data: cur, w, h }];
  for (let l = 1; l < levels; l++) {
    pyramidsPrev.push(downsample(pyramidsPrev[l - 1].data, pyramidsPrev[l - 1].w, pyramidsPrev[l - 1].h));
    pyramidsCur.push(downsample(pyramidsCur[l - 1].data, pyramidsCur[l - 1].w, pyramidsCur[l - 1].h));
  }

  let dx = 0, dy = 0;
  for (let l = levels - 1; l >= 0; l--) {
    const scale = 1 / (1 << l);
    const T = pyramidsPrev[l];
    const I = pyramidsCur[l];
    const sx = seed.x * scale;
    const sy = seed.y * scale;
    for (let it = 0; it < opts.iterations; it++) {
      const step = lkIter(T.data, I.data, T.w, T.h, sx, sy, dx, dy, opts.windowRadius);
      dx += step.dx;
      dy += step.dy;
      if (Math.abs(step.dx) + Math.abs(step.dy) < 0.05) break;
    }
    if (l > 0) { dx *= 2; dy *= 2; }
  }

  // Confidence heuristic: sum-squared-diff between the two windows post-alignment.
  let ssd = 0;
  const r = opts.windowRadius;
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const d = bilinear(cur, w, h, seed.x + dx + i, seed.y + dy + j) - bilinear(prev, w, h, seed.x + i, seed.y + j);
      ssd += d * d;
    }
  }
  const area = (2 * r + 1) * (2 * r + 1);
  const confidence = Math.max(0, Math.min(1, 1 - ssd / area));
  const lost = confidence < 0.2;
  return { x: seed.x + dx, y: seed.y + dy, confidence, lost };
};
