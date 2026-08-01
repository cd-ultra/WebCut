/**
 * WebCut — CorridorKey: hybrid chroma key + neural matting shader.
 *
 * A WGSL fragment pipeline modeled on neural-assisted matting frameworks:
 * a procedural chroma matte (YCbCr-space color distance with erosion,
 * feathering, and spill unmixing) is fused with a neural alpha matte streamed
 * from an ONNX Runtime Web session (WebGPU or WASM execution provider).
 *
 * Bind group layout (group 1 — effect-local):
 *   @binding(0) uniform  CorridorKeyUniforms
 *   @binding(1) sampler  linear clamp sampler
 *   @binding(2) texture  source frame (rgba8unorm-srgb view of decoded video)
 *   @binding(3) texture  neural alpha matte (r8unorm, ONNX session output)
 *
 * The neural matte binding is ALWAYS bound (a 1x1 white fallback texture when
 * no session is active) so the pipeline never needs a permutation recompile —
 * `useNeuralMatte` simply gates the blend in the shader.
 */

import {
  isIdentityCurves,
  isIdentityGrade,
  isIdentityHsl,
  type BlendMode,
  type ColorGrade,
  type CorridorKeyParams,
} from "../types/timeline";
import { identityCurveLut, identityLut3D } from "./lut";

// ---------------------------------------------------------------------------
// WGSL
// ---------------------------------------------------------------------------

export const CORRIDOR_KEY_WGSL = /* wgsl */ `
struct CorridorKeyUniforms {
  // xyz = key color (linear RGB), w = similarity threshold
  key_color_similarity : vec4<f32>,
  // x = smoothness, y = edge erosion, z = feather radius px, w = spill suppression
  matte_params : vec4<f32>,
  // x = neural matte mix, y = use neural matte (0/1), zw = texel size (1/w, 1/h)
  neural_params : vec4<f32>,
  // xyz = grade lift, w = grade enabled (0/1)
  grade_lift : vec4<f32>,
  // xyz = grade gamma, w = brightness
  grade_gamma : vec4<f32>,
  // xyz = grade gain, w = contrast
  grade_gain : vec4<f32>,
  // x = saturation, y = temperature, z = tint, w = unused
  grade_misc : vec4<f32>,
  // x = curves enabled, y = 3D LUT enabled, z = HSL enabled, w = HSL center hue (0..1)
  grade_ext0 : vec4<f32>,
  // x = HSL half-width (0..1), y = HSL softness (0..1), z = HSL hue shift (0..1 signed), w = HSL sat scale
  grade_ext1 : vec4<f32>,
  // x = HSL lum scale, y = 3D LUT size, zw = unused
  grade_ext2 : vec4<f32>,
};

@group(1) @binding(0) var<uniform> u : CorridorKeyUniforms;
@group(1) @binding(1) var linear_sampler : sampler;
@group(1) @binding(2) var source_tex : texture_2d<f32>;
@group(1) @binding(3) var neural_matte_tex : texture_2d<f32>;
@group(1) @binding(4) var curve_lut_tex : texture_2d<f32>;
@group(1) @binding(5) var lut3d_tex : texture_3d<f32>;

// BT.709 RGB -> chroma plane (Cb, Cr). Luma is intentionally discarded so the
// key is exposure-invariant: shadows on the green screen survive the key.
fn rgb_to_chroma(rgb : vec3<f32>) -> vec2<f32> {
  let cb = -0.114572 * rgb.r - 0.385428 * rgb.g + 0.5 * rgb.b;
  let cr =  0.5      * rgb.r - 0.454153 * rgb.g - 0.045847 * rgb.b;
  return vec2<f32>(cb, cr);
}

fn luma709(rgb : vec3<f32>) -> f32 {
  return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Procedural matte for a single sample: 0 = keyed out, 1 = opaque.
fn chroma_matte(rgb : vec3<f32>) -> f32 {
  let key_chroma = rgb_to_chroma(u.key_color_similarity.xyz);
  let px_chroma  = rgb_to_chroma(rgb);
  let dist = distance(px_chroma, key_chroma);

  let similarity = u.key_color_similarity.w;
  let smoothness = max(u.matte_params.x, 1e-4);
  let erosion    = u.matte_params.y;

  // Erosion shifts the transparency threshold outward, eating into the
  // soft boundary band before the smoothstep ramp begins.
  let lo = similarity + erosion;
  let hi = lo + smoothness;
  return smoothstep(lo, hi, dist);
}

// 9-tap feather: a separable-quality blur approximated in a single pass with
// a 3x3 Gaussian kernel scaled by the feather radius. Cheap enough to run
// per-fragment; radius 0 collapses to a single center tap.
fn feathered_matte(uv : vec2<f32>, rgb_center : vec3<f32>) -> f32 {
  let radius = u.matte_params.z;
  let center = chroma_matte(rgb_center);
  if (radius < 0.01) {
    return center;
  }
  let texel = u.neural_params.zw * radius;
  var acc = center * 0.25;
  let offsets = array<vec2<f32>, 8>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0,  0.0),                       vec2<f32>(1.0,  0.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>(0.0,  1.0), vec2<f32>(1.0,  1.0)
  );
  let weights = array<f32, 8>(
    0.0625, 0.125, 0.0625,
    0.125,         0.125,
    0.0625, 0.125, 0.0625
  );
  for (var i = 0u; i < 8u; i = i + 1u) {
    let sample_rgb = textureSampleLevel(source_tex, linear_sampler, uv + offsets[i] * texel, 0.0).rgb;
    acc = acc + chroma_matte(sample_rgb) * weights[i];
  }
  return acc;
}

// Spill suppression with boundary-aware color unmixing. Boundary pixels
// (semi-transparent matte) receive the strongest treatment: the key color's
// chroma contribution is subtracted and the lost energy is redistributed to
// the complementary channels, which reads as "unmixing" the background from
// hair strands and motion-blurred edges.
fn suppress_spill(rgb : vec3<f32>, matte : f32) -> vec3<f32> {
  let strength = u.matte_params.w;
  if (strength < 1e-4) {
    return rgb;
  }
  let key = u.key_color_similarity.xyz;
  var out_rgb = rgb;

  // Dominance test against the strongest key channel (green for green screens).
  if (key.g >= key.r && key.g >= key.b) {
    let limit = max(out_rgb.r, out_rgb.b) + (1.0 - strength) * max(out_rgb.g - max(out_rgb.r, out_rgb.b), 0.0);
    let excess = max(out_rgb.g - limit, 0.0);
    out_rgb.g = out_rgb.g - excess;
    // Energy redistribution keeps perceived luminance stable after desaturation.
    let restore = excess * 0.5;
    out_rgb.r = out_rgb.r + restore * 0.6;
    out_rgb.b = out_rgb.b + restore * 0.4;
  } else if (key.b >= key.r && key.b >= key.g) {
    let limit = max(out_rgb.r, out_rgb.g) + (1.0 - strength) * max(out_rgb.b - max(out_rgb.r, out_rgb.g), 0.0);
    let excess = max(out_rgb.b - limit, 0.0);
    out_rgb.b = out_rgb.b - excess;
    let restore = excess * 0.5;
    out_rgb.r = out_rgb.r + restore * 0.4;
    out_rgb.g = out_rgb.g + restore * 0.6;
  } else {
    let limit = max(out_rgb.g, out_rgb.b) + (1.0 - strength) * max(out_rgb.r - max(out_rgb.g, out_rgb.b), 0.0);
    let excess = max(out_rgb.r - limit, 0.0);
    out_rgb.r = out_rgb.r - excess;
    let restore = excess * 0.5;
    out_rgb.g = out_rgb.g + restore * 0.5;
    out_rgb.b = out_rgb.b + restore * 0.5;
  }

  // Boundary pixels get the full unmix; solid foreground is left untouched.
  let boundary = 1.0 - abs(matte * 2.0 - 1.0); // peaks at matte = 0.5
  let mix_amount = strength * max(boundary, step(matte, 0.999) * 0.35);
  return mix(rgb, out_rgb, mix_amount);
}

// Primary color grade: ASC-CDL-style lift/gamma/gain, then brightness/contrast,
// saturation, and a simple temperature/tint white balance. Identity params
// (lift 0, gamma 1, gain 1, brightness 0, contrast 1, saturation 1, temp/tint 0)
// leave the color unchanged; the caller gates this with grade_lift.w.
fn rgb_to_hsl(c : vec3<f32>) -> vec3<f32> {
  let maxc = max(c.r, max(c.g, c.b));
  let minc = min(c.r, min(c.g, c.b));
  let l = (maxc + minc) * 0.5;
  let d = maxc - minc;
  var h = 0.0;
  var s = 0.0;
  if (d > 1e-5) {
    s = select(d / (2.0 - maxc - minc), d / (maxc + minc), l < 0.5);
    if (maxc == c.r) {
      h = (c.g - c.b) / d + select(6.0, 0.0, c.g >= c.b);
    } else if (maxc == c.g) {
      h = (c.b - c.r) / d + 2.0;
    } else {
      h = (c.r - c.g) / d + 4.0;
    }
    h = h / 6.0;
  }
  return vec3<f32>(h, s, l); // h in [0,1)
}

fn hue_to_rgb(p : f32, q : f32, t_in : f32) -> f32 {
  var t = fract(t_in);
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}

fn hsl_to_rgb(hsl : vec3<f32>) -> vec3<f32> {
  let h = hsl.x;
  let s = hsl.y;
  let l = hsl.z;
  if (s <= 1e-5) {
    return vec3<f32>(l, l, l);
  }
  let q = select(l + s - l * s, l * (1.0 + s), l < 0.5);
  let p = 2.0 * l - q;
  return vec3<f32>(hue_to_rgb(p, q, h + 1.0 / 3.0), hue_to_rgb(p, q, h), hue_to_rgb(p, q, h - 1.0 / 3.0));
}

// Shortest angular distance between two normalized hues (each in [0,1)).
fn hue_dist(a : f32, b : f32) -> f32 {
  let d = abs(fract(a) - fract(b));
  return min(d, 1.0 - d);
}

// HSL secondary qualifier: select a hue band (with soft feather) and shift its
// hue / scale its saturation and lightness. Non-selected pixels are untouched.
fn apply_hsl_secondary(rgb : vec3<f32>) -> vec3<f32> {
  let center = u.grade_ext0.w;
  let halfWidth = u.grade_ext1.x;
  let softness = max(u.grade_ext1.y, 1e-4);
  let hueShift = u.grade_ext1.z;
  let satScale = u.grade_ext1.w;
  let lumScale = u.grade_ext2.x;

  let hsl = rgb_to_hsl(rgb);
  let dist = hue_dist(hsl.x, center);
  // 1 inside the band, ramping to 0 across the softness feather. Weight by
  // saturation so near-greys (undefined hue) are excluded.
  let sel = (1.0 - smoothstep(halfWidth, halfWidth + softness, dist)) * smoothstep(0.02, 0.15, hsl.y);
  if (sel <= 1e-4) {
    return rgb;
  }
  var out_hsl = hsl;
  out_hsl.x = fract(hsl.x + hueShift * sel);
  out_hsl.y = clamp(hsl.y * mix(1.0, satScale, sel), 0.0, 1.0);
  out_hsl.z = clamp(hsl.z * mix(1.0, lumScale, sel), 0.0, 1.0);
  return hsl_to_rgb(out_hsl);
}

fn apply_grade(rgb : vec3<f32>) -> vec3<f32> {
  let lift = u.grade_lift.xyz;
  let gamma = max(u.grade_gamma.xyz, vec3<f32>(1e-3));
  let gain = u.grade_gain.xyz;
  let brightness = u.grade_gamma.w;
  let contrast = u.grade_gain.w;
  let saturation = u.grade_misc.x;
  let temperature = u.grade_misc.y;
  let tint = u.grade_misc.z;

  var c = clamp(rgb * gain + lift, vec3<f32>(0.0), vec3<f32>(1.0));
  c = pow(c, vec3<f32>(1.0) / gamma);
  c = (c - vec3<f32>(0.5)) * contrast + vec3<f32>(0.5) + vec3<f32>(brightness);
  let luma = dot(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(0.2126, 0.7152, 0.0722));
  c = mix(vec3<f32>(luma), c, saturation);
  c = c + vec3<f32>(temperature, tint, -temperature);
  c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));

  // Tone curves (#42): per-channel lookup into the baked 256×1 LUT.
  if (u.grade_ext0.x > 0.5) {
    c = vec3<f32>(
      textureSampleLevel(curve_lut_tex, linear_sampler, vec2<f32>(c.r, 0.5), 0.0).r,
      textureSampleLevel(curve_lut_tex, linear_sampler, vec2<f32>(c.g, 0.5), 0.0).g,
      textureSampleLevel(curve_lut_tex, linear_sampler, vec2<f32>(c.b, 0.5), 0.0).b,
    );
  }

  // HSL secondary (#43).
  if (u.grade_ext0.z > 0.5) {
    c = apply_hsl_secondary(c);
  }

  // 3D LUT (#44): sample the volume with half-texel-corrected coordinates.
  if (u.grade_ext0.y > 0.5) {
    let n = max(u.grade_ext2.y, 2.0);
    let scale = (n - 1.0) / n;
    let offset = 0.5 / n;
    let uvw = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)) * scale + vec3<f32>(offset);
    c = textureSampleLevel(lut3d_tex, linear_sampler, uvw, 0.0).rgb;
  }

  return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
}

struct FragmentInput {
  @location(0) uv : vec2<f32>,
};

@fragment
fn fs_corridor_key(input : FragmentInput) -> @location(0) vec4<f32> {
  let src = textureSampleLevel(source_tex, linear_sampler, input.uv, 0.0);
  var matte = feathered_matte(input.uv, src.rgb);

  // Fuse with the neural matte streamed from the ONNX session. The neural
  // matte is authoritative for topology (what IS foreground); the procedural
  // matte is authoritative for edge micro-detail. A multiplicative floor
  // blend preserves both.
  let use_neural = u.neural_params.y;
  if (use_neural > 0.5) {
    let neural = textureSampleLevel(neural_matte_tex, linear_sampler, input.uv, 0.0).r;
    let fused = min(matte, neural) * u.neural_params.x + matte * neural * (1.0 - u.neural_params.x);
    matte = mix(matte, fused, u.neural_params.x);
  }

  var graded = suppress_spill(src.rgb, matte);
  if (u.grade_lift.w > 0.5) {
    graded = apply_grade(graded);
  }

  // Premultiplied alpha out — required for correct compositor blending.
  return vec4<f32>(graded * matte, matte * src.a);
}
`;

/** Standalone fullscreen-triangle vertex stage shared by effect passes. */
export const FULLSCREEN_VERTEX_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) index : u32) -> VertexOutput {
  // Single oversized triangle: no vertex buffer, no index buffer.
  var out : VertexOutput;
  let x = f32(i32(index & 1u) * 4 - 1);
  let y = f32(i32(index >> 1u) * 4 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}
`;

// ---------------------------------------------------------------------------
// Uniform packing
// ---------------------------------------------------------------------------

/** Bytes in the CorridorKeyUniforms block (10 x vec4<f32>). */
export const CORRIDOR_KEY_UNIFORM_SIZE = 160;

/**
 * Pack params into a Float32Array laid out exactly as the WGSL uniform struct.
 * Call once per parameter change, then `queue.writeBuffer` the result. When
 * `grade` is omitted the grade is identity and disabled (byte-for-byte the same
 * output as before grading existed).
 */
export const packCorridorKeyUniforms = (
  params: CorridorKeyParams,
  frameWidth: number,
  frameHeight: number,
  grade?: ColorGrade | null,
  lut3dSize?: number,
): Float32Array => {
  const data = new Float32Array(CORRIDOR_KEY_UNIFORM_SIZE / 4);
  data[0] = params.keyColor[0];
  data[1] = params.keyColor[1];
  data[2] = params.keyColor[2];
  data[3] = params.similarity;
  data[4] = params.smoothness;
  data[5] = params.edgeErosion;
  data[6] = params.featherRadiusPx;
  data[7] = params.spillSuppression;
  data[8] = params.neuralMatteMix;
  data[9] = params.useNeuralMatte ? 1 : 0;
  data[10] = frameWidth > 0 ? 1 / frameWidth : 0;
  data[11] = frameHeight > 0 ? 1 / frameHeight : 0;

  // grade_lift (xyz lift, w enabled)
  const g = grade ?? null;
  const enabled = g && !isIdentityGrade(g) ? 1 : 0;
  data[12] = g ? g.lift[0] : 0;
  data[13] = g ? g.lift[1] : 0;
  data[14] = g ? g.lift[2] : 0;
  data[15] = enabled;
  // grade_gamma (xyz gamma, w brightness)
  data[16] = g ? g.gamma[0] : 1;
  data[17] = g ? g.gamma[1] : 1;
  data[18] = g ? g.gamma[2] : 1;
  data[19] = g ? g.brightness : 0;
  // grade_gain (xyz gain, w contrast)
  data[20] = g ? g.gain[0] : 1;
  data[21] = g ? g.gain[1] : 1;
  data[22] = g ? g.gain[2] : 1;
  data[23] = g ? g.contrast : 1;
  // grade_misc (saturation, temperature, tint, unused)
  data[24] = g ? g.saturation : 1;
  data[25] = g ? g.temperature : 0;
  data[26] = g ? g.tint : 0;
  data[27] = 0;

  // grade_ext0 (curves enabled, 3D LUT enabled, HSL enabled, HSL center hue 0..1)
  const curvesOn = g && g.curves && !isIdentityCurves(g.curves) ? 1 : 0;
  const lutOn = g && g.lut3dId ? 1 : 0;
  const hsl = g?.hsl;
  const hslOn = hsl && !isIdentityHsl(hsl) ? 1 : 0;
  data[28] = curvesOn;
  data[29] = lutOn;
  data[30] = hslOn;
  data[31] = hsl ? (((hsl.centerHue % 360) + 360) % 360) / 360 : 0.5;
  // grade_ext1 (HSL half-width, softness, hue shift, sat scale) — all in turns.
  data[32] = hsl ? hsl.hueWidth / 360 : 0;
  data[33] = hsl ? hsl.softness / 360 : 0;
  data[34] = hsl ? hsl.hueShift / 360 : 0;
  data[35] = hsl ? hsl.satScale : 1;
  // grade_ext2 (HSL lum scale, 3D LUT size, unused, unused)
  data[36] = hsl ? hsl.lumScale : 1;
  data[37] = lut3dSize ?? 2;
  data[38] = 0;
  data[39] = 0;
  return data;
};

// ---------------------------------------------------------------------------
// GPU-side effect pass
// ---------------------------------------------------------------------------

export interface CorridorKeyPassResources {
  readonly pipeline: GPURenderPipeline;
  /** One pipeline per blend mode (all share the shader + bind group layout). */
  readonly pipelines: Record<BlendMode, GPURenderPipeline>;
  readonly uniformBuffer: GPUBuffer;
  readonly sampler: GPUSampler;
  readonly bindGroupLayout: GPUBindGroupLayout;
  /** 1x1 opaque-white fallback bound when no ONNX matte is streaming. */
  readonly fallbackMatteTexture: GPUTexture;
  /** 256×1 identity ramp bound when a layer has no active tone curves. */
  readonly fallbackCurveLut: GPUTexture;
  /** 2×2×2 identity cube bound when a layer has no active 3D LUT. */
  readonly fallbackLut3d: GPUTexture;
  destroy(): void;
}

/** Blend state per mode. Alpha is kept as premultiplied "over" so coverage is stable. */
const BLEND_STATES: Record<BlendMode, GPUBlendState> = {
  normal: {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  },
  multiply: {
    color: { srcFactor: "dst", dstFactor: "zero", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  },
  screen: {
    color: { srcFactor: "one-minus-dst", dstFactor: "one", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  },
  add: {
    color: { srcFactor: "one", dstFactor: "one", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  },
};

export const createCorridorKeyPass = (
  device: GPUDevice,
  targetFormat: GPUTextureFormat,
): CorridorKeyPassResources => {
  const module = device.createShaderModule({
    label: "corridor-key-shader",
    code: FULLSCREEN_VERTEX_WGSL + CORRIDOR_KEY_WGSL,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "corridor-key-bgl",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [
      // group 0 reserved for compositor globals; effects own group 1.
      device.createBindGroupLayout({ entries: [] }),
      bindGroupLayout,
    ],
  });

  const buildPipeline = (mode: BlendMode): GPURenderPipeline =>
    device.createRenderPipeline({
      label: `corridor-key-pipeline-${mode}`,
      layout: pipelineLayout,
      vertex: { module, entryPoint: "vs_fullscreen" },
      fragment: {
        module,
        entryPoint: "fs_corridor_key",
        targets: [{ format: targetFormat, blend: BLEND_STATES[mode] }],
      },
      primitive: { topology: "triangle-list" },
    });

  const pipeline = buildPipeline("normal");
  // Build blend-mode variants defensively: a rejected blend combo must not take
  // down the whole compositor — fall back to the normal pipeline instead.
  const pipelines: Record<BlendMode, GPURenderPipeline> = {
    normal: pipeline,
    multiply: pipeline,
    screen: pipeline,
    add: pipeline,
  };
  for (const mode of ["multiply", "screen", "add"] as const) {
    try {
      pipelines[mode] = buildPipeline(mode);
    } catch (error) {
      console.warn(`[WebCut] blend mode "${mode}" unavailable, using normal:`, error);
    }
  }

  const uniformBuffer = device.createBuffer({
    label: "corridor-key-uniforms",
    size: CORRIDOR_KEY_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const sampler = device.createSampler({
    label: "corridor-key-sampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const fallbackMatteTexture = device.createTexture({
    label: "corridor-key-fallback-matte",
    size: { width: 1, height: 1 },
    format: "r8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: fallbackMatteTexture },
    new Uint8Array([255]),
    { bytesPerRow: 256 },
    { width: 1, height: 1 },
  );

  const fallbackCurveLut = createCurveLutTexture(device);
  writeCurveLutTexture(device, fallbackCurveLut, identityCurveLut());

  const identity3d = identityLut3D();
  const fallbackLut3d = createLut3dTexture(device, identity3d.size);
  writeLut3dTexture(device, fallbackLut3d, identity3d.size, identity3d.data);

  return {
    pipeline,
    pipelines,
    uniformBuffer,
    sampler,
    bindGroupLayout,
    fallbackMatteTexture,
    fallbackCurveLut,
    fallbackLut3d,
    destroy() {
      uniformBuffer.destroy();
      fallbackMatteTexture.destroy();
      fallbackCurveLut.destroy();
      fallbackLut3d.destroy();
    },
  };
};

// ---------------------------------------------------------------------------
// LUT texture helpers (shared by the compositor for per-layer grade LUTs)
// ---------------------------------------------------------------------------

/** Allocate the 256×1 RGBA8 texture that holds a baked tone-curve LUT. */
export const createCurveLutTexture = (device: GPUDevice): GPUTexture =>
  device.createTexture({
    label: "grade-curve-lut",
    size: { width: 256, height: 1 },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

/** Upload a baked 256×4 curve LUT (from bakeCurveLut) into its texture. */
export const writeCurveLutTexture = (device: GPUDevice, texture: GPUTexture, data: Uint8Array): void => {
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: 256 * 4, rowsPerImage: 1 },
    { width: 256, height: 1 },
  );
};

/** Allocate an N×N×N RGBA8 3D texture for a parsed .cube LUT. */
export const createLut3dTexture = (device: GPUDevice, size: number): GPUTexture =>
  device.createTexture({
    label: "grade-lut3d",
    dimension: "3d",
    size: { width: size, height: size, depthOrArrayLayers: size },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

/** Upload a parsed 3D LUT (red-fastest RGBA8) into its volume texture. */
export const writeLut3dTexture = (
  device: GPUDevice,
  texture: GPUTexture,
  size: number,
  data: Uint8Array,
): void => {
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: size * 4, rowsPerImage: size },
    { width: size, height: size, depthOrArrayLayers: size },
  );
};

/**
 * ONNX Runtime Web integration point.
 *
 * NeuralMatteStreamer owns a GPUTexture that an ONNX session continuously
 * refreshes with segmentation output (e.g. MODNet / RVM portrait matting).
 * Each inference result (a Float32Array or Uint8Array alpha map) is uploaded
 * with queue.writeTexture; the render loop binds `texture` at @binding(3).
 *
 * The streamer is deliberately decoupled from ort's types so the module
 * compiles without onnxruntime-web imports in the render path — sessions are
 * created lazily in a worker (see runInference signature).
 */
export class NeuralMatteStreamer {
  private texture: GPUTexture;
  private width: number;
  private height: number;

  constructor(
    private readonly device: GPUDevice,
    initialWidth = 512,
    initialHeight = 288,
  ) {
    this.width = initialWidth;
    this.height = initialHeight;
    this.texture = this.allocate(initialWidth, initialHeight);
  }

  private allocate(width: number, height: number): GPUTexture {
    return this.device.createTexture({
      label: "neural-matte-stream",
      size: { width, height },
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  get view(): GPUTextureView {
    return this.texture.createView();
  }

  /**
   * Upload one inference result. Accepts the raw tensor data from an ort
   * session (`results.output.data`): float [0,1] or uint8 [0,255], in
   * row-major HxW layout.
   */
  pushMatte(data: Float32Array | Uint8Array, width: number, height: number): void {
    if (width !== this.width || height !== this.height) {
      this.texture.destroy();
      this.texture = this.allocate(width, height);
      this.width = width;
      this.height = height;
    }

    let bytes: Uint8Array;
    if (data instanceof Float32Array) {
      bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        bytes[i] = Math.min(255, Math.max(0, Math.round(data[i] * 255)));
      }
    } else {
      bytes = data;
    }

    // WebGPU requires bytesPerRow % 256 == 0 for writeTexture from buffers,
    // but writeTexture from ArrayBuffer data allows tight packing per spec.
    this.device.queue.writeTexture(
      { texture: this.texture },
      bytes,
      { bytesPerRow: width, rowsPerImage: height },
      { width, height },
    );
  }

  destroy(): void {
    this.texture.destroy();
  }
}
