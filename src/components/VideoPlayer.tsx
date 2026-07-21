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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Gauge, Loader2, Maximize2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import {
  CORRIDOR_KEY_UNIFORM_SIZE,
  createCorridorKeyPass,
  NeuralMatteStreamer,
  packCorridorKeyUniforms,
  type CorridorKeyPassResources,
} from "../effects/CorridorKeyShader";
import { previewService } from "../services/PreviewService";
import { transport, useTimelineStore } from "../store/timelineStore";
import {
  defaultCorridorKeyParams,
  sampleAnimatable,
  staticValue,
  type BlendMode,
  type CorridorKeyParams,
  type TrackItem,
  type TrackItemId,
  type Transform,
} from "../types/timeline";

/** Signature of the store's generic item updater. */
type UpdateItemFn = (itemId: TrackItemId, updater: (item: TrackItem) => TrackItem, coalesceKey?: string) => void;

const hexToRgbTuple = (hex: string): [number, number, number] => {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean.padEnd(6, "0");
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
};

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
      };
      this.layers.set(layerId, layer);
    }
    layer.order = order;
    return layer;
  }

  setLayerBlend(layerId: string, mode: BlendMode): void {
    if (this.destroyed) return;
    const layer = this.ensureLayer(layerId, this.layers.get(layerId)?.order ?? 0);
    layer.blendMode = mode;
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
  blendMode: BlendMode;
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

interface ViewTransform {
  zoom: number;
  x: number;
  y: number;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

export const VideoPlayer = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const compositorRef = useRef<WebGPUCompositor | null>(null);
  const [status, setStatus] = useState<GpuStatus>({ phase: "initializing" });
  const [view, setView] = useState<ViewTransform>({ zoom: 1, x: 0, y: 0 });
  const [showFps, setShowFps] = useState(false);
  const [canvasBox, setCanvasBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const settings = useTimelineStore((state) => state.project.settings);
  const selectedItemIds = useTimelineStore((state) => state.selectedItemIds);
  const tracks = useTimelineStore((state) => state.project.tracks);
  const updateItem = useTimelineStore((state) => state.updateItem);

  // The on-canvas gizmo only targets overlays (text/shape); clips are drawn
  // fullscreen by the compositor and ignore transform.
  const selectedOverlay = useMemo(() => {
    if (selectedItemIds.length !== 1) return undefined;
    for (const track of tracks) {
      const found = track.items.find((item) => item.id === selectedItemIds[0]);
      if (found) return found.type === "text" || found.type === "shape" ? found : undefined;
    }
    return undefined;
  }, [selectedItemIds, tracks]);

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
        compositor.setBackgroundColor(hexToRgbTuple(useTimelineStore.getState().project.settings.backgroundColor));
        compositorRef.current = compositor;
        unregisterSink = previewService.registerSink(compositor);
        setStatus({ phase: "ready", adapterInfo: init.adapterInfo });

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

  // Push the project background color into the compositor clear value.
  useEffect(() => {
    compositorRef.current?.setBackgroundColor(hexToRgbTuple(settings.backgroundColor));
  }, [settings.backgroundColor]);

  // Track the canvas's on-screen rectangle (relative to the container) so the
  // gizmo overlay can map project pixels ↔ screen pixels through the view zoom.
  useLayoutEffect(() => {
    const measure = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const c = canvas.getBoundingClientRect();
      const p = container.getBoundingClientRect();
      setCanvasBox({ left: c.left - p.left, top: c.top - p.top, width: c.width, height: c.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (canvasRef.current) ro.observe(canvasRef.current);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [view, settings.width, settings.height]);

  const fitView = useCallback(() => setView({ zoom: 1, x: 0, y: 0 }), []);

  const onWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    setView((prev) => {
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom * factor));
      return { ...prev, zoom };
    });
  }, []);

  // Drag on empty preview area = pan.
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const onBackgroundPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    panRef.current = { startX: event.clientX, startY: event.clientY, ox: view.x, oy: view.y };
  };
  const onBackgroundPointerMove = (event: React.PointerEvent) => {
    const pan = panRef.current;
    if (!pan) return;
    setView((prev) => ({ ...prev, x: pan.ox + (event.clientX - pan.startX), y: pan.oy + (event.clientY - pan.startY) }));
  };
  const onBackgroundPointerUp = () => {
    panRef.current = null;
  };

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black"
      onWheel={onWheel}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={onBackgroundPointerUp}
    >
      <div
        className="relative"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        <canvas
          ref={canvasRef}
          className="block max-h-full max-w-full object-contain"
          style={{ aspectRatio: `${settings.width} / ${settings.height}` }}
        />
      </div>

      {selectedOverlay && canvasBox && (
        <TransformGizmo
          item={selectedOverlay}
          box={canvasBox}
          settings={settings}
          updateItem={updateItem}
        />
      )}

      {/* Preview controls */}
      <div className="absolute left-2 top-2 z-30 flex items-center gap-1 rounded bg-black/50 px-1 py-0.5">
        <button title="Zoom out" onClick={() => setView((v) => ({ ...v, zoom: Math.max(MIN_ZOOM, v.zoom / 1.2) }))} className="rounded p-1 text-neutral-300 hover:bg-white/10">
          <ZoomOut size={13} />
        </button>
        <span className="w-9 text-center font-mono text-[10px] text-neutral-400">{Math.round(view.zoom * 100)}%</span>
        <button title="Zoom in" onClick={() => setView((v) => ({ ...v, zoom: Math.min(MAX_ZOOM, v.zoom * 1.2) }))} className="rounded p-1 text-neutral-300 hover:bg-white/10">
          <ZoomIn size={13} />
        </button>
        <button title="Fit" onClick={fitView} className="rounded p-1 text-neutral-300 hover:bg-white/10">
          <Maximize2 size={13} />
        </button>
        <button
          title="Toggle FPS overlay"
          onClick={() => setShowFps((s) => !s)}
          className={`rounded p-1 ${showFps ? "text-accent" : "text-neutral-300 hover:bg-white/10"}`}
        >
          <Gauge size={13} />
        </button>
      </div>

      {showFps && <FpsBadge />}

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

// ---------------------------------------------------------------------------
// On-canvas transform gizmo (move / scale / rotate) for overlays, with guides
// ---------------------------------------------------------------------------

type GizmoMode = "move" | "scale" | "rotate";

const TransformGizmo = ({
  item,
  box,
  settings,
  updateItem,
}: {
  item: TrackItem;
  box: { left: number; top: number; width: number; height: number };
  settings: { width: number; height: number };
  updateItem: UpdateItemFn;
}) => {
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const pxPerProject = box.width / settings.width;
  const pos = sampleAnimatable(item.transform.position, 0);
  const scale = sampleAnimatable(item.transform.scale, 0);
  const rotation = sampleAnimatable(item.transform.rotation, 0);

  // Item center in container-relative screen pixels.
  const cx = box.left + box.width / 2 + pos.x * pxPerProject;
  const cy = box.top + box.height / 2 + pos.y * pxPerProject;

  const drag = useRef<{ mode: GizmoMode; startX: number; startY: number; base: Transform } | null>(null);

  const begin = (mode: GizmoMode) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { mode, startX: event.clientX, startY: event.clientY, base: item.transform };
  };

  const onMove = (event: React.PointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const dxScreen = event.clientX - state.startX;
    const dyScreen = event.clientY - state.startY;
    const basePos = sampleAnimatable(state.base.position, 0);
    const baseScale = sampleAnimatable(state.base.scale, 0);
    const baseRot = sampleAnimatable(state.base.rotation, 0);

    if (state.mode === "move") {
      let nx = basePos.x + dxScreen / pxPerProject;
      let ny = basePos.y + dyScreen / pxPerProject;
      const snap = 12 / pxPerProject;
      const showV = Math.abs(nx) < snap;
      const showH = Math.abs(ny) < snap;
      if (showV) nx = 0;
      if (showH) ny = 0;
      setGuides({ v: showV, h: showH });
      updateItem(item.id, (it) => ({ ...it, transform: { ...it.transform, position: staticValue({ x: nx, y: ny }) } }) as TrackItem, "canvas");
    } else if (state.mode === "scale") {
      // Drag away from / toward the item (down-right grows) via delta only, so
      // the math is independent of the coordinate space and the view zoom.
      const factor = Math.max(0.05, 1 + (dxScreen + dyScreen) / 300);
      const next = Math.max(0.05, ((baseScale.x + baseScale.y) / 2) * factor);
      updateItem(item.id, (it) => ({ ...it, transform: { ...it.transform, scale: staticValue({ x: next, y: next }) } }) as TrackItem, "canvas");
    } else {
      const deg = baseRot + dxScreen * 0.5;
      updateItem(item.id, (it) => ({ ...it, transform: { ...it.transform, rotation: staticValue(deg) } }) as TrackItem, "canvas");
    }
  };

  const end = () => {
    drag.current = null;
    setGuides({ v: false, h: false });
  };

  const handleClass = "absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-accent";

  return (
    <div className="pointer-events-none absolute inset-0 z-20" onPointerMove={onMove} onPointerUp={end}>
      {guides.v && <div className="absolute top-0 bottom-0 w-px bg-accent/70" style={{ left: box.left + box.width / 2 }} />}
      {guides.h && <div className="absolute left-0 right-0 h-px bg-accent/70" style={{ top: box.top + box.height / 2 }} />}

      {/* Move handle (center) */}
      <button
        title="Drag to move"
        onPointerDown={begin("move")}
        className="pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-move items-center justify-center rounded-full border border-white/70 bg-black/40"
        style={{ left: cx, top: cy }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-white" />
      </button>
      {/* Scale handle (offset bottom-right) */}
      <button
        title="Drag to scale"
        onPointerDown={begin("scale")}
        className={`pointer-events-auto ${handleClass} cursor-nwse-resize`}
        style={{ left: cx + 46, top: cy + 34 }}
      />
      {/* Rotate handle (above) */}
      <button
        title="Drag to rotate"
        onPointerDown={begin("rotate")}
        className="pointer-events-auto absolute flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border border-white bg-accent-warm"
        style={{ left: cx, top: cy - 44 }}
      >
        <RotateCw size={9} className="text-black" />
      </button>
      <span className="absolute -translate-x-1/2 rounded bg-black/60 px-1 font-mono text-[8px] text-neutral-300" style={{ left: cx, top: cy + 14 }}>
        {Math.round(scale.x * 100)}% · {Math.round(rotation)}°
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// FPS badge — self-measures render cadence via its own rAF loop
// ---------------------------------------------------------------------------

const FpsBadge = () => {
  const [stats, setStats] = useState({ fps: 0, ms: 0 });
  useEffect(() => {
    let handle = 0;
    let frames = 0;
    let last = performance.now();
    let lastFrame = last;
    let msAccum = 0;
    const tick = () => {
      const now = performance.now();
      msAccum += now - lastFrame;
      lastFrame = now;
      frames += 1;
      if (now - last >= 500) {
        setStats({ fps: Math.round((frames * 1000) / (now - last)), ms: Math.round((msAccum / frames) * 10) / 10 });
        frames = 0;
        msAccum = 0;
        last = now;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, []);
  return (
    <span className="absolute right-3 top-2 z-30 rounded bg-black/60 px-2 py-0.5 font-mono text-[10px] text-accent">
      {stats.fps} fps · {stats.ms} ms
    </span>
  );
};
