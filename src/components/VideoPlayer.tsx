/**
 * WebCut — VideoPlayer: the WebGPU program monitor.
 *
 * Owns the canvas `webgpu` context and a persistent render pipeline:
 *
 *   WebCodecs VideoDecoder ──VideoFrame──▶ importExternalTexture / copyExternal
 *        │                                          │
 *        ▼                                          ▼
 *   ingestVideoFrame()  ──────────────▶  rgba8 source GPUTexture
 *                                                   │
 *                       CorridorKey pass (group 1: uniforms+sampler+src+matte)
 *                                                   │
 *                                                   ▼
 *                                        swapchain texture (canvas)
 *
 * The render loop is driven by the transport side-channel, NOT React state:
 * scrubbing the playhead invalidates the frame and the rAF loop redraws —
 * React only re-renders this component on structural changes (resolution,
 * effect toggles).
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  CORRIDOR_KEY_UNIFORM_SIZE,
  createCorridorKeyPass,
  NeuralMatteStreamer,
  packCorridorKeyUniforms,
  type CorridorKeyPassResources,
} from "../effects/CorridorKeyShader";
import { previewService } from "../services/PreviewService";
import { transport, useTimelineStore } from "../store/timelineStore";
import { defaultCorridorKeyParams, type CorridorKeyParams } from "../types/timeline";

// ---------------------------------------------------------------------------
// GPU renderer (plain class — lives outside React's render cycle)
// ---------------------------------------------------------------------------

interface RendererInit {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
}

class WebGPUCompositor {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private keyPass: CorridorKeyPassResources;
  private matteStreamer: NeuralMatteStreamer;
  private emptyBindGroup: GPUBindGroup;

  /** One compositing layer per video track, drawn bottom -> top. */
  private layers = new Map<string, LayerState>();
  private destroyed = false;

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
      };
      this.layers.set(layerId, layer);
    }
    layer.order = order;
    return layer;
  }

  /** Drop layers whose tracks no longer have a clip under the playhead. */
  syncLayers(activeLayerIds: readonly string[]): void {
    if (this.destroyed) return;
    const keep = new Set(activeLayerIds);
    for (const [id, layer] of this.layers) {
      if (!keep.has(id)) {
        layer.texture?.destroy();
        layer.uniformBuffer.destroy();
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
        ),
      );
    }

    const pass = encoder.beginRenderPass({
      label: "composite-pass",
      colorAttachments: [
        {
          view: canvasTexture.createView(),
          clearValue: { r: 0.04, g: 0.045, b: 0.055, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    if (drawable.length > 0) {
      pass.setPipeline(this.keyPass.pipeline);
      pass.setBindGroup(0, this.emptyBindGroup);
      for (const layer of drawable) {
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
          ],
        });
        pass.setBindGroup(1, bindGroup);
        pass.draw(3); // fullscreen triangle, premultiplied "over" blend
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
    }
    this.layers.clear();
    this.keyPass.destroy();
    this.matteStreamer.destroy();
  }
}

interface LayerState {
  texture: GPUTexture | null;
  width: number;
  height: number;
  uniformBuffer: GPUBuffer;
  params: CorridorKeyParams;
  enabled: boolean;
  order: number;
  hasFrame: boolean;
}

// ---------------------------------------------------------------------------
// WebCodecs decode bridge
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around a hardware VideoDecoder. Encoded chunks (from a demuxer
 * such as mp4box.js) are queued in; decoded VideoFrames flow into the
 * compositor and are closed immediately after GPU upload to release the
 * decoder's frame pool.
 */
export class DecodeBridge {
  private decoder: VideoDecoder | null = null;

  constructor(private readonly onFrame: (frame: VideoFrame) => void) {}

  async configure(config: VideoDecoderConfig): Promise<void> {
    if (typeof VideoDecoder === "undefined") {
      throw new Error("WebCodecs VideoDecoder is unavailable in this browser.");
    }
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) {
      throw new Error(`Codec configuration not supported: ${config.codec}`);
    }
    this.decoder?.close();
    this.decoder = new VideoDecoder({
      output: (frame) => {
        try {
          this.onFrame(frame);
        } finally {
          frame.close();
        }
      },
      error: (error) => console.error("[WebCut] VideoDecoder error:", error),
    });
    this.decoder.configure(config);
  }

  decode(chunk: EncodedVideoChunk): void {
    this.decoder?.decode(chunk);
  }

  async flush(): Promise<void> {
    await this.decoder?.flush();
  }

  close(): void {
    if (this.decoder && this.decoder.state !== "closed") {
      this.decoder.close();
    }
    this.decoder = null;
  }
}

// ---------------------------------------------------------------------------
// WebGPU bootstrap
// ---------------------------------------------------------------------------

export interface GpuStatus {
  readonly phase: "initializing" | "ready" | "unsupported" | "error";
  readonly detail?: string;
  readonly adapterInfo?: string;
}

const initWebGPU = async (canvas: HTMLCanvasElement): Promise<RendererInit & { adapterInfo: string }> => {
  if (!("gpu" in navigator)) {
    throw Object.assign(new Error("navigator.gpu is undefined — this browser does not expose WebGPU."), {
      unsupported: true,
    });
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    throw Object.assign(new Error("No WebGPU adapter available (GPU may be blocklisted)."), { unsupported: true });
  }
  const device = await adapter.requestDevice({ label: "webcut-device" });
  device.lost.then((info) => {
    if (info.reason !== "destroyed") {
      console.error(`[WebCut] GPU device lost: ${info.message}`);
    }
  });

  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("Failed to acquire 'webgpu' canvas context.");
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const info = adapter.info;
  const adapterInfo = info ? [info.vendor, info.architecture].filter(Boolean).join(" / ") : "unknown adapter";
  return { device, context, format, adapterInfo };
};

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export const VideoPlayer = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<WebGPUCompositor | null>(null);
  const [status, setStatus] = useState<GpuStatus>({ phase: "initializing" });

  const settings = useTimelineStore((state) => state.project.settings);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let rafHandle = 0;
    let compositor: WebGPUCompositor | null = null;
    let unregisterSink: (() => void) | null = null;

    (async () => {
      try {
        const init = await initWebGPU(canvas);
        if (disposed) {
          init.device.destroy();
          return;
        }
        compositor = new WebGPUCompositor(init);
        compositorRef.current = compositor;
        unregisterSink = previewService.registerSink(compositor);
        setStatus({ phase: "ready", adapterInfo: init.adapterInfo });

        // Continuous render loop: redraws are cheap (single pass) and keep
        // the swapchain valid across resizes/scrubs without dirty tracking.
        const loop = () => {
          if (disposed) return;
          compositor?.render();
          rafHandle = requestAnimationFrame(loop);
        };
        rafHandle = requestAnimationFrame(loop);
      } catch (error) {
        if (disposed) return;
        const unsupported = (error as { unsupported?: boolean }).unsupported === true;
        setStatus({
          phase: unsupported ? "unsupported" : "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    // Scrub invalidation: the transport notifies per-frame; the rAF loop
    // already repaints, so we only need this hook for future seek-decode.
    const unsubscribe = transport.subscribe(() => {
      /* frame-accurate seek requests dispatch to DecodeBridge here */
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(rafHandle);
      unsubscribe();
      unregisterSink?.();
      compositorRef.current = null;
      compositor?.destroy();
    };
  }, []);

  // Keep the drawing buffer matched to project resolution (CSS handles fit).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = settings.width;
    canvas.height = settings.height;
  }, [settings.width, settings.height]);

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      <canvas
        ref={canvasRef}
        className="max-h-full max-w-full object-contain"
        style={{ aspectRatio: `${settings.width} / ${settings.height}` }}
      />

      {status.phase === "initializing" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-neutral-400">
          <Loader2 className="h-6 w-6 animate-spin" />
          Initializing WebGPU pipeline…
        </div>
      )}

      {(status.phase === "unsupported" || status.phase === "error") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <p className="max-w-md text-sm leading-relaxed text-neutral-300">
            {status.phase === "unsupported"
              ? "WebGPU is not available. WebCut requires Chrome/Edge 113+ with hardware acceleration enabled (chrome://gpu)."
              : `Render pipeline failed: ${status.detail}`}
          </p>
        </div>
      )}

      {status.phase === "ready" && status.adapterInfo && (
        <span className="absolute bottom-2 right-3 rounded bg-black/60 px-2 py-0.5 font-mono text-[10px] text-neutral-500">
          WebGPU · {status.adapterInfo}
        </span>
      )}
    </div>
  );
};
