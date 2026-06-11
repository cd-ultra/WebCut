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

import type { CorridorKeyParams } from "../types/timeline";

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
};

@group(1) @binding(0) var<uniform> u : CorridorKeyUniforms;
@group(1) @binding(1) var linear_sampler : sampler;
@group(1) @binding(2) var source_tex : texture_2d<f32>;
@group(1) @binding(3) var neural_matte_tex : texture_2d<f32>;

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

  let suppressed = suppress_spill(src.rgb, matte);

  // Premultiplied alpha out — required for correct compositor blending.
  return vec4<f32>(suppressed * matte, matte * src.a);
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

/** Bytes in the CorridorKeyUniforms block (3 x vec4<f32>). */
export const CORRIDOR_KEY_UNIFORM_SIZE = 48;

/**
 * Pack params into a Float32Array laid out exactly as the WGSL uniform struct.
 * Call once per parameter change, then `queue.writeBuffer` the result.
 */
export const packCorridorKeyUniforms = (
  params: CorridorKeyParams,
  frameWidth: number,
  frameHeight: number,
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
  return data;
};

// ---------------------------------------------------------------------------
// GPU-side effect pass
// ---------------------------------------------------------------------------

export interface CorridorKeyPassResources {
  readonly pipeline: GPURenderPipeline;
  readonly uniformBuffer: GPUBuffer;
  readonly sampler: GPUSampler;
  readonly bindGroupLayout: GPUBindGroupLayout;
  /** 1x1 opaque-white fallback bound when no ONNX matte is streaming. */
  readonly fallbackMatteTexture: GPUTexture;
  destroy(): void;
}

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
    ],
  });

  const pipeline = device.createRenderPipeline({
    label: "corridor-key-pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [
        // group 0 reserved for compositor globals; effects own group 1.
        device.createBindGroupLayout({ entries: [] }),
        bindGroupLayout,
      ],
    }),
    vertex: { module, entryPoint: "vs_fullscreen" },
    fragment: {
      module,
      entryPoint: "fs_corridor_key",
      targets: [
        {
          format: targetFormat,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

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

  return {
    pipeline,
    uniformBuffer,
    sampler,
    bindGroupLayout,
    fallbackMatteTexture,
    destroy() {
      uniformBuffer.destroy();
      fallbackMatteTexture.destroy();
    },
  };
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
