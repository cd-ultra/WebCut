/**
 * WebCut — ONNX Runtime Web matting session.
 *
 * Runs a portrait/foreground matting model (MODNet, RVM, or compatible
 * single-output segmentation network) and streams alpha maps into the
 * CorridorKey shader's neural matte binding.
 *
 * Execution provider order: "webgpu" first (shares the GPU with the
 * compositor), falling back to multithreaded "wasm" when the WebGPU EP is
 * unavailable. The ort module is imported lazily so the ~20 MB runtime never
 * blocks initial app load.
 */

import type * as OrtNamespace from "onnxruntime-web";

type OrtModule = typeof OrtNamespace;

export type MatteCallback = (alpha: Float32Array | Uint8Array, width: number, height: number) => void;

export interface MatteSessionOptions {
  /** Model input resolution; frames are letterboxed/scaled to this. */
  readonly inferenceWidth: number;
  readonly inferenceHeight: number;
  /** Name of the model's image input tensor. */
  readonly inputName: string;
  /** Name of the model's alpha output tensor. */
  readonly outputName: string;
}

const DEFAULT_OPTIONS: MatteSessionOptions = {
  inferenceWidth: 512,
  inferenceHeight: 288,
  inputName: "input",
  outputName: "output",
};

export class OnnxMatteService {
  private ort: OrtModule | null = null;
  private session: OrtNamespace.InferenceSession | null = null;
  private options: MatteSessionOptions = DEFAULT_OPTIONS;
  private activeProvider: "webgpu" | "wasm" | null = null;
  private scratchCanvas: OffscreenCanvas | null = null;
  private busy = false;

  get provider(): "webgpu" | "wasm" | null {
    return this.activeProvider;
  }

  get isReady(): boolean {
    return this.session !== null;
  }

  /** Load the runtime and create a session from a user-provided .onnx file. */
  async loadModel(modelBytes: ArrayBuffer | Uint8Array, options?: Partial<MatteSessionOptions>): Promise<void> {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    if (!this.ort) {
      const ort = await import("onnxruntime-web");
      // Multithreaded WASM kernels require cross-origin isolation, which our
      // Vite COOP/COEP headers provide.
      ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency ?? 1);
      ort.env.wasm.proxy = false;
      this.ort = ort;
    }

    const bytes = modelBytes instanceof Uint8Array ? modelBytes : new Uint8Array(modelBytes);

    // Prefer the WebGPU execution provider; fall back to WASM.
    try {
      this.session = await this.ort.InferenceSession.create(bytes, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      });
      this.activeProvider = "webgpu";
    } catch (webgpuError) {
      console.warn("[WebCut] ONNX WebGPU EP unavailable, falling back to WASM:", webgpuError);
      this.session = await this.ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      this.activeProvider = "wasm";
    }
  }

  /**
   * Run one inference over a video frame. Drops the request if a previous
   * inference is still in flight (matting tolerates temporal subsampling;
   * stalling the decode pipeline does not).
   */
  async inferFrame(frame: VideoFrame | ImageBitmap, onMatte: MatteCallback): Promise<void> {
    if (!this.session || !this.ort || this.busy) return;
    this.busy = true;
    try {
      const { inferenceWidth: w, inferenceHeight: h, inputName, outputName } = this.options;

      if (!this.scratchCanvas || this.scratchCanvas.width !== w || this.scratchCanvas.height !== h) {
        this.scratchCanvas = new OffscreenCanvas(w, h);
      }
      const ctx = this.scratchCanvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
      const { data: rgba } = ctx.getImageData(0, 0, w, h);

      // HWC uint8 -> NCHW float32, normalized to [0,1].
      const chw = new Float32Array(3 * w * h);
      const plane = w * h;
      for (let i = 0; i < plane; i++) {
        chw[i] = rgba[i * 4] / 255;
        chw[i + plane] = rgba[i * 4 + 1] / 255;
        chw[i + plane * 2] = rgba[i * 4 + 2] / 255;
      }

      const input = new this.ort.Tensor("float32", chw, [1, 3, h, w]);
      const results = await this.session.run({ [inputName]: input });
      const output = results[outputName];
      if (!output) {
        throw new Error(`Model produced no "${outputName}" tensor`);
      }
      onMatte(output.data as Float32Array, w, h);
    } finally {
      this.busy = false;
    }
  }

  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = null;
    this.activeProvider = null;
  }
}

export const onnxMatteService = new OnnxMatteService();
