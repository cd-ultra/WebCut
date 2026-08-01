/**
 * WebCut — color LUTs: tone-curve baking + 3D `.cube` LUT parsing/registry.
 *
 * Two independent lookup mechanisms feed the CorridorKey grade pass:
 *
 *  • Tone curves (#42) are baked on the CPU into a 256×1 RGBA8 texture. The
 *    shader does one lookup per channel (sampling with that channel's value as
 *    the U coordinate and reading the matching output channel), which realizes
 *    per-channel RGB curves plus a shared master curve.
 *
 *  • 3D LUTs (#44) are parsed from Adobe `.cube` files into an N×N×N RGBA8
 *    volume. Because the bytes are large and non-serializable, they live in a
 *    module-level registry keyed by id; a ColorGrade references a LUT by id.
 */

import {
  identityCurves,
  isIdentityCurves,
  type CurvePoint,
  type GradeCurves,
} from "../types/timeline";

// ---------------------------------------------------------------------------
// Monotone tone-curve evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a curve defined by sorted control points at x∈[0,1] using
 * Fritsch–Carlson monotone cubic Hermite interpolation — smooth, but never
 * overshoots between points (no ringing that would clip highlights/shadows).
 */
export const evalCurve = (points: readonly CurvePoint[], x: number): number => {
  const n = points.length;
  if (n === 0) return x;
  if (n === 1) return clamp01(points[0][1]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  if (x <= xs[0]) return clamp01(ys[0]);
  if (x >= xs[n - 1]) return clamp01(ys[n - 1]);

  // Secant slopes and monotone tangents.
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(1e-6, xs[i + 1] - xs[i]);
    slope[i] = (ys[i + 1] - ys[i]) / dx[i];
  }
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (slope[i - 1] + slope[i]) / 2;
    }
  }
  // Clamp tangents to preserve monotonicity (Fritsch–Carlson).
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / slope[i];
      const b = m[i + 1] / slope[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * slope[i];
        m[i + 1] = t * b * slope[i];
      }
    }
  }

  // Locate the segment containing x.
  let i = 0;
  while (i < n - 1 && x > xs[i + 1]) i++;
  const h = dx[i];
  const t = (x - xs[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const y = h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  return clamp01(y);
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Bake per-channel + master tone curves into a 256×1 RGBA8 buffer. For each
 * input level v the master curve is applied first, then the channel curve; the
 * shader reads channel c's output by sampling at coord v and taking `.c`.
 */
export const bakeCurveLut = (curves: GradeCurves): Uint8Array => {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const mv = evalCurve(curves.master, v);
    out[i * 4 + 0] = Math.round(evalCurve(curves.red, mv) * 255);
    out[i * 4 + 1] = Math.round(evalCurve(curves.green, mv) * 255);
    out[i * 4 + 2] = Math.round(evalCurve(curves.blue, mv) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
};

/** Identity 256×1 ramp used as the always-bound fallback LUT texture. */
export const identityCurveLut = (): Uint8Array => bakeCurveLut(identityCurves());

export const curvesNeedLut = (curves: GradeCurves | undefined): boolean =>
  !!curves && !isIdentityCurves(curves);

// ---------------------------------------------------------------------------
// 3D `.cube` LUT parsing
// ---------------------------------------------------------------------------

export interface Lut3D {
  readonly size: number;
  /** N³ × RGBA8, ordered red-fastest (matches WebGPU writeTexture layout). */
  readonly data: Uint8Array;
  /** Optional per-file domain (defaults to 0..1). */
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
}

/**
 * Parse an Adobe/IRIDAS `.cube` 3D LUT. Supports LUT_3D_SIZE, DOMAIN_MIN/MAX,
 * comments (#), and TITLE. Throws on malformed input.
 */
export const parseCubeLut = (text: string): Lut3D => {
  let size = 0;
  const domainMin: [number, number, number] = [0, 0, 0];
  const domainMax: [number, number, number] = [1, 1, 1];
  const entries: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("TITLE")) continue;
    if (upper.startsWith("LUT_1D_SIZE")) {
      throw new Error("1D .cube LUTs are not supported (use a 3D LUT).");
    }
    if (upper.startsWith("LUT_3D_SIZE")) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (upper.startsWith("DOMAIN_MIN")) {
      const p = line.split(/\s+/).slice(1).map(Number);
      domainMin[0] = p[0]; domainMin[1] = p[1]; domainMin[2] = p[2];
      continue;
    }
    if (upper.startsWith("DOMAIN_MAX")) {
      const p = line.split(/\s+/).slice(1).map(Number);
      domainMax[0] = p[0]; domainMax[1] = p[1]; domainMax[2] = p[2];
      continue;
    }
    // A data row: three floats.
    const parts = line.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.every((v) => Number.isFinite(v))) {
      entries.push(parts[0], parts[1], parts[2]);
    }
  }

  if (size < 2 || size > 64) {
    throw new Error(`Unsupported or missing LUT_3D_SIZE (${size}).`);
  }
  const expected = size * size * size;
  if (entries.length / 3 !== expected) {
    throw new Error(`.cube entry count ${entries.length / 3} ≠ expected ${expected}.`);
  }

  const data = new Uint8Array(expected * 4);
  for (let i = 0; i < expected; i++) {
    data[i * 4 + 0] = Math.round(clamp01(entries[i * 3 + 0]) * 255);
    data[i * 4 + 1] = Math.round(clamp01(entries[i * 3 + 1]) * 255);
    data[i * 4 + 2] = Math.round(clamp01(entries[i * 3 + 2]) * 255);
    data[i * 4 + 3] = 255;
  }
  return { size, data, domainMin, domainMax };
};

/** A minimal 2×2×2 identity cube — the always-bound fallback 3D texture. */
export const identityLut3D = (): Lut3D => {
  const size = 2;
  const data = new Uint8Array(size * size * size * 4);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        data[i++] = r * 255;
        data[i++] = g * 255;
        data[i++] = b * 255;
        data[i++] = 255;
      }
    }
  }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
};

// ---------------------------------------------------------------------------
// LUT registry (session-scoped; not serialized with the project)
// ---------------------------------------------------------------------------

const lutRegistry = new Map<string, { name: string; lut: Lut3D }>();

export const registerLut = (name: string, lut: Lut3D): string => {
  const id = `lut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  lutRegistry.set(id, { name, lut });
  return id;
};

export const getLut = (id: string): { name: string; lut: Lut3D } | undefined => lutRegistry.get(id);
