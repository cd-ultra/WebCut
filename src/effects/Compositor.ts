/**
 * WebCut — WebGPUCompositor: the shared timeline→pixels compositor.
 *
 * Extracted so the live preview (VideoPlayer, on a visible canvas) and the
 * offline exporter (ExportService, on an OffscreenCanvas) composite through the
 * exact same pipeline — a frame that renders one way in the monitor renders the
 * same way in the exported file.
 *
 * One `LayerState` per video track, drawn bottom→top with premultiplied-alpha
 * "over" (or the track's blend mode). Each layer owns a uniform buffer, an
 * optional source texture, and optional per-layer grade LUT textures.
 */

import {
  CORRIDOR_KEY_UNIFORM_SIZE,
  createCorridorKeyPass,
  createCurveLutTexture,
  createLut3dTexture,
  NeuralMatteStreamer,
  packCorridorKeyUniforms,
  writeCurveLutTexture,
  writeLut3dTexture,
  type CorridorKeyPassResources,
  type TransitionUniform,
} from "./CorridorKeyShader";
import { bakeCurveLut, curvesNeedLut, getLut } from "./lut";
import {
  defaultCorridorKeyParams,
  type BlendMode,
  type ColorGrade,
  type CorridorKeyParams,
  type EffectParams,
} from "../types/timeline";

export interface RendererInit {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
}

export interface LayerState {
  texture: GPUTexture | null;
  width: number;
  height: number;
  uniformBuffer: GPUBuffer;
  params: CorridorKeyParams;
  enabled: boolean;
  order: number;
  hasFrame: boolean;
  blendMode: BlendMode;
  grade: ColorGrade | null;
  /** Baked per-channel tone-curve LUT (256×1), or null when identity. */
  curveLutTexture: GPUTexture | null;
  /** Applied 3D LUT volume texture, or null when none. */
  lut3dTexture: GPUTexture | null;
  /** Edge length of the current 3D LUT (for shader half-texel correction). */
  lut3dSize: number;
  /** Per-frame transition state (fade alpha, wipe kind + progress). */
  transition: TransitionUniform | null;
  /** Per-frame reduced effect params (b/c/blur/sharpen). */
  effectParams: EffectParams | null;
}

export class WebGPUCompositor {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private keyPass: CorridorKeyPassResources;
  private matteStreamer: NeuralMatteStreamer;
  private emptyBindGroup: GPUBindGroup;

  /** One compositing layer per video track, drawn bottom -> top. */
  private layers = new Map<string, LayerState>();
  private destroyed = false;
  /** Canvas clear color (project background), linear-ish sRGB in [0,1]. */
  private clearColor: GPUColor = { r: 0, g: 0, b: 0, a: 1 };

  setBackgroundColor(rgb: readonly [number, number, number]): void {
    this.clearColor = { r: rgb[0], g: rgb[1], b: rgb[2], a: 1 };
  }

  constructor(init: RendererInit) {
    this.device = init.device;
    this.context = init.context;
    this.keyPass = createCorridorKeyPass(init.device, init.format);
    this.matteStreamer = new NeuralMatteStreamer(init.device);
    this.emptyBindGroup = init.device.createBindGroup({
      layout: init.device.createBindGroupLayout({ entries: [] }),
      entries: [],
    });
  }

  private ensureLayer(layerId: string, order: number): LayerState {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = {
        texture: null,
        width: 0,
        height: 0,
        uniformBuffer: this.device.createBuffer({
          label: `layer-uniforms-${layerId}`,
          size: CORRIDOR_KEY_UNIFORM_SIZE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        params: defaultCorridorKeyParams(),
        enabled: false,
        order,
        hasFrame: false,
        blendMode: "normal",
        grade: null,
        curveLutTexture: null,
        lut3dTexture: null,
        lut3dSize: 2,
        transition: null,
        effectParams: null,
      };
      this.layers.set(layerId, layer);
    }
    layer.order = order;
    return layer;
  }

  setLayerTransition(layerId: string, transition: TransitionUniform | null): void {
    if (this.destroyed) return;
    const layer = this.ensureLayer(layerId, this.layers.get(layerId)?.order ?? 0);
    layer.transition = transition;
  }

  setLayerEffectParams(layerId: string, params: EffectParams | null): void {
    if (this.destroyed) return;
    const layer = this.ensureLayer(layerId, this.layers.get(layerId)?.order ?? 0);
    layer.effectParams = params;
  }

  setLayerBlend(layerId: string, mode: BlendMode): void {
    if (this.destroyed) return;
    const layer = this.ensureLayer(layerId, this.layers.get(layerId)?.order ?? 0);
    layer.blendMode = mode;
  }

  setLayerGrade(layerId: string, grade: ColorGrade | null): void {
    if (this.destroyed) return;
    const layer = this.ensureLayer(layerId, this.layers.get(layerId)?.order ?? 0);
    // Grade objects are immutable in the store, so reference equality is a
    // reliable "unchanged" signal — skip the (potentially per-frame) LUT rebuild.
    if (layer.grade === grade) return;
    layer.grade = grade;
    this.rebuildLayerLuts(layer, grade);
  }

  /** Bake/upload the per-layer tone-curve + 3D LUT textures for a grade. */
  private rebuildLayerLuts(layer: LayerState, grade: ColorGrade | null): void {
    // Tone curves → 256×1 LUT (only when non-identity).
    if (grade && curvesNeedLut(grade.curves)) {
      if (!layer.curveLutTexture) layer.curveLutTexture = createCurveLutTexture(this.device);
      writeCurveLutTexture(this.device, layer.curveLutTexture, bakeCurveLut(grade.curves!));
    } else if (layer.curveLutTexture) {
      layer.curveLutTexture.destroy();
      layer.curveLutTexture = null;
    }

    // 3D LUT → volume texture, resolved from the session registry by id.
    const entry = grade?.lut3dId ? getLut(grade.lut3dId) : undefined;
    if (entry) {
      const { size, data } = entry.lut;
      if (!layer.lut3dTexture || layer.lut3dSize !== size) {
        layer.lut3dTexture?.destroy();
        layer.lut3dTexture = createLut3dTexture(this.device, size);
        layer.lut3dSize = size;
      }
      writeLut3dTexture(this.device, layer.lut3dTexture, size, data);
    } else if (layer.lut3dTexture) {
      layer.lut3dTexture.destroy();
      layer.lut3dTexture = null;
      layer.lut3dSize = 2;
    }
  }

  /** Drop layers whose tracks no longer have a clip under the playhead. */
  syncLayers(activeLayerIds: readonly string[]): void {
    if (this.destroyed) return;
    const keep = new Set(activeLayerIds);
    for (const [id, layer] of this.layers) {
      if (!keep.has(id)) {
        layer.texture?.destroy();
        layer.uniformBuffer.destroy();
        layer.curveLutTexture?.destroy();
        layer.lut3dTexture?.destroy();
        this.layers.delete(id);
      }
    }
  }

  setLayerEffect(layerId: string, enabled: boolean, params: CorridorKeyParams): void {
    if (this.destroyed) return;
    // Create the layer if needed: effects arrive before the first frame.
    const layer = this.ensureLayer(layerId, this.layers.get(layerId)?.order ?? 0);
    layer.enabled = enabled;
    layer.params = params;
  }

  /**
   * Ingest one decoded frame into a layer. Accepts a WebCodecs VideoFrame
   * (zero-copy GPU upload via copyExternalImageToTexture), a video element,
   * or an ImageBitmap.
   */
  ingestLayerFrame(layerId: string, frame: VideoFrame | HTMLVideoElement | ImageBitmap, order: number): void {
    if (this.destroyed) return;
    const width =
      frame instanceof VideoFrame ? frame.displayWidth : frame instanceof ImageBitmap ? frame.width : frame.videoWidth;
    const height =
      frame instanceof VideoFrame
        ? frame.displayHeight
        : frame instanceof ImageBitmap
          ? frame.height
          : frame.videoHeight;
    if (width === 0 || height === 0) return;

    const layer = this.ensureLayer(layerId, order);
    if (!layer.texture || width !== layer.width || height !== layer.height) {
      layer.texture?.destroy();
      layer.texture = this.device.createTexture({
        label: `layer-frame-${layerId}`,
        size: { width, height },
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      layer.width = width;
      layer.height = height;
    }

    this.device.queue.copyExternalImageToTexture(
      { source: frame },
      { texture: layer.texture },
      { width, height },
    );
    layer.hasFrame = true;
  }

  /** Forward an ONNX inference result into the matte binding slot. */
  pushNeuralMatte(data: Float32Array | Uint8Array, width: number, height: number): void {
    this.matteStreamer.pushMatte(data, width, height);
  }

  render(): void {
    if (this.destroyed) return;
    const canvasTexture = this.context.getCurrentTexture();
    const encoder = this.device.createCommandEncoder({ label: "frame-encoder" });

    const drawable = [...this.layers.values()]
      .filter((layer) => layer.hasFrame && layer.texture)
      .sort((a, b) => a.order - b.order);

    // Uniform writes happen at queue scope, before the pass executes — each
    // layer owns its own buffer so all writes land for the same submit.
    for (const layer of drawable) {
      this.device.queue.writeBuffer(
        layer.uniformBuffer,
        0,
        packCorridorKeyUniforms(
          layer.enabled ? layer.params : { ...layer.params, similarity: -1, smoothness: 0.0001 },
          layer.width,
          layer.height,
          layer.grade,
          layer.lut3dSize,
          layer.transition,
          layer.effectParams,
        ),
      );
    }

    const pass = encoder.beginRenderPass({
      label: "composite-pass",
      colorAttachments: [
        {
          view: canvasTexture.createView(),
          clearValue: this.clearColor,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    if (drawable.length > 0) {
      pass.setBindGroup(0, this.emptyBindGroup);
      for (const layer of drawable) {
        // Per-layer blend mode selects the matching pipeline variant.
        pass.setPipeline(this.keyPass.pipelines[layer.blendMode]);
        const bindGroup = this.device.createBindGroup({
          label: "layer-bind-group",
          layout: this.keyPass.bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: layer.uniformBuffer } },
            { binding: 1, resource: this.keyPass.sampler },
            { binding: 2, resource: layer.texture!.createView() },
            {
              binding: 3,
              resource: layer.params.useNeuralMatte
                ? this.matteStreamer.view
                : this.keyPass.fallbackMatteTexture.createView(),
            },
            {
              binding: 4,
              resource: (layer.curveLutTexture ?? this.keyPass.fallbackCurveLut).createView(),
            },
            {
              binding: 5,
              resource: (layer.lut3dTexture ?? this.keyPass.fallbackLut3d).createView(),
            },
          ],
        });
        pass.setBindGroup(1, bindGroup);
        pass.draw(3); // fullscreen triangle
      }
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.destroyed = true;
    for (const layer of this.layers.values()) {
      layer.texture?.destroy();
      layer.uniformBuffer.destroy();
      layer.curveLutTexture?.destroy();
      layer.lut3dTexture?.destroy();
    }
    this.layers.clear();
    this.keyPass.destroy();
    this.matteStreamer.destroy();
  }
}
