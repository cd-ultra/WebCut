/**
 * WebCut — proxy / optimized media workflow (#51).
 *
 * Decoding 4K H.265 on a <video> element is slow enough to stutter scrubbing.
 * A **proxy** is a smaller, cheap-to-decode copy of the source generated once
 * (on import), stored in IndexedDB, and consumed by the PREVIEW pipeline in
 * place of the original. Export ALWAYS reads from the original — quality is
 * not sacrificed.
 *
 * Pipeline: WebCodecs `VideoDecoder` reads source frames → downscaled via
 * `OffscreenCanvas` → `VideoEncoder` writes 540p H.264 → `mp4-muxer` packages
 * the result → `FileSystemService.registerBlobFile` persists to IDB.
 *
 * Jobs run one at a time in the background so imports aren't blocked. Source
 * files below the proxy resolution are skipped (nothing to gain).
 */

import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { fileSystemService } from "./FileSystemService";

export interface ProxyOptions {
  /** Target proxy height in pixels; width is derived from source aspect. */
  readonly targetHeight?: number;
  /** Target bitrate in bits per second. */
  readonly bitrate?: number;
  /** Skip proxy generation for sources whose height is already ≤ this. */
  readonly minSourceHeight?: number;
}

const DEFAULT_OPTIONS: Required<ProxyOptions> = {
  targetHeight: 540,
  bitrate: 2_000_000,
  minSourceHeight: 720,
};

export interface ProxyResult {
  /** The IndexedDB handle key for the generated proxy blob. */
  readonly handleKey: string;
  readonly width: number;
  readonly height: number;
}

export type ProxyJobStatus = "pending" | "running" | "done" | "skipped" | "error";

export interface ProxyJob {
  readonly id: string;
  readonly assetName: string;
  status: ProxyJobStatus;
  progress: number; // 0..1
  error: string | null;
  result: ProxyResult | null;
}

type Listener = (jobs: readonly ProxyJob[]) => void;

/**
 * Session-scoped queue that generates proxies one at a time. UI subscribes for
 * live progress; the timeline store swaps in `proxyHandleKey` on completion.
 */
class ProxyServiceImpl {
  private jobs: ProxyJob[] = [];
  private listeners = new Set<Listener>();
  private running = false;
  private cancelled = new Set<string>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.jobs);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.jobs.map((j) => ({ ...j }));
    for (const l of this.listeners) l(snapshot);
  }

  getJobs(): readonly ProxyJob[] {
    return this.jobs;
  }

  cancel(jobId: string): void {
    this.cancelled.add(jobId);
    const job = this.jobs.find((j) => j.id === jobId);
    if (job && job.status === "pending") {
      job.status = "skipped";
      this.emit();
    }
  }

  /**
   * Enqueue a proxy job for one source file. Returns a promise that resolves
   * to the result (or null on skip / error).
   */
  async enqueue(
    file: File,
    assetName: string,
    options: ProxyOptions = {},
    onResult?: (result: ProxyResult | null) => void,
  ): Promise<ProxyResult | null> {
    const job: ProxyJob = {
      id: `pj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      assetName,
      status: "pending",
      progress: 0,
      error: null,
      result: null,
    };
    this.jobs.push(job);
    this.emit();

    void this.drain();

    // Wait for THIS job to finish before returning to the caller.
    return new Promise((resolve) => {
      const check = () => {
        if (job.status === "done") { onResult?.(job.result); resolve(job.result); return; }
        if (job.status === "error" || job.status === "skipped") { onResult?.(null); resolve(null); return; }
        setTimeout(check, 200);
      };
      // Attach the file to the job via a closure below.
      (job as unknown as { __file?: File; __options?: ProxyOptions }).__file = file;
      (job as unknown as { __file?: File; __options?: ProxyOptions }).__options = options;
      check();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const next = this.jobs.find((j) => j.status === "pending");
        if (!next) break;
        if (this.cancelled.has(next.id)) {
          next.status = "skipped";
          this.emit();
          continue;
        }
        next.status = "running";
        this.emit();
        const withFile = next as unknown as { __file?: File; __options?: ProxyOptions };
        const file = withFile.__file;
        const options = withFile.__options ?? {};
        if (!file) {
          next.status = "error";
          next.error = "internal: no source file bound to job";
          this.emit();
          continue;
        }
        try {
          const result = await this.runOne(next, file, options);
          if (result) {
            next.result = result;
            next.status = "done";
          } else {
            next.status = "skipped";
          }
        } catch (err) {
          next.status = "error";
          next.error = err instanceof Error ? err.message : String(err);
        } finally {
          this.emit();
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async runOne(job: ProxyJob, file: File, opts: ProxyOptions): Promise<ProxyResult | null> {
    const { targetHeight, bitrate, minSourceHeight } = { ...DEFAULT_OPTIONS, ...opts };

    // WebCodecs availability guard.
    if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") {
      throw new Error("WebCodecs is unavailable in this browser — proxy generation requires Chromium 94+.");
    }

    // Fast path: peek at the source dimensions via a hidden <video>. Skip if
    // it's already at/under the proxy resolution.
    const dims = await probeDimensions(file);
    if (!dims) return null;
    if (dims.height <= minSourceHeight) return null;

    const scale = targetHeight / dims.height;
    const proxyW = Math.max(2, Math.round((dims.width * scale) / 2) * 2);
    const proxyH = Math.max(2, Math.round(targetHeight / 2) * 2);

    // Set up the muxer + encoder for the output MP4.
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: "avc", width: proxyW, height: proxyH, frameRate: dims.frameRate ?? 30 },
      fastStart: "in-memory",
      firstTimestampBehavior: "offset",
    });
    let encoderErr: unknown = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta ?? undefined),
      error: (e) => { encoderErr = e; },
    });
    encoder.configure({
      codec: "avc1.4d0028",
      width: proxyW,
      height: proxyH,
      bitrate,
      framerate: dims.frameRate ?? 30,
      avc: { format: "avc" as const },
    });

    // Decode source, downscale on an OffscreenCanvas, re-encode.
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error(`Cannot load ${job.assetName} for proxy generation.`)), { once: true });
    });
    const durSec = video.duration || 0;
    const fps = dims.frameRate ?? 30;
    const totalFrames = Math.max(1, Math.floor(durSec * fps));

    const canvas = new OffscreenCanvas(proxyW, proxyH);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2D context for proxy downscale.");

    try {
      for (let f = 0; f < totalFrames; f++) {
        if (encoderErr) throw encoderErr;
        // Seek + wait: not the fastest, but the most deterministic across browsers.
        const t = f / fps;
        if (Math.abs(video.currentTime - t) > 1e-3) {
          video.currentTime = t;
          await new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
        }
        ctx.clearRect(0, 0, proxyW, proxyH);
        ctx.drawImage(video, 0, 0, proxyW, proxyH);
        const timestamp = Math.round((f * 1_000_000) / fps);
        const vf = new VideoFrame(canvas, { timestamp, duration: Math.round(1_000_000 / fps) });
        encoder.encode(vf, { keyFrame: f % Math.round(fps * 2) === 0 });
        vf.close();

        while (encoder.encodeQueueSize > 8) {
          await new Promise((r) => setTimeout(r, 4));
        }

        job.progress = (f + 1) / totalFrames;
        if (f % 15 === 0) this.emit();

        if (this.cancelled.has(job.id)) {
          throw new DOMException("Cancelled", "AbortError");
        }
      }
      await encoder.flush();
      if (encoderErr) throw encoderErr;
      muxer.finalize();
    } finally {
      try { encoder.close(); } catch { /* already closed */ }
      URL.revokeObjectURL(url);
    }

    const blob = new Blob([target.buffer], { type: "video/mp4" });
    // Register into IDB as a blob so the browser can re-open it after reload.
    const proxyFile = new File([blob], `${job.assetName}.proxy.mp4`, { type: "video/mp4" });
    const handleKey = await fileSystemService.registerBlobFile(proxyFile);

    return { handleKey, width: proxyW, height: proxyH };
  }
}

const probeDimensions = (file: File): Promise<{ width: number; height: number; frameRate?: number } | null> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("loadedmetadata", () => {
      const dims = { width: video.videoWidth, height: video.videoHeight };
      URL.revokeObjectURL(url);
      resolve(dims);
    }, { once: true });
    video.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      resolve(null);
    }, { once: true });
  });

export const proxyService = new ProxyServiceImpl();

// Global toggle: preview uses proxies when enabled + available. Persists to
// localStorage so it survives reloads.
const PROXY_TOGGLE_KEY = "webcut.useProxies";

let useProxies = ((): boolean => {
  if (typeof localStorage === "undefined") return true;
  const raw = localStorage.getItem(PROXY_TOGGLE_KEY);
  return raw === null ? true : raw === "1";
})();

const toggleListeners = new Set<(useProxies: boolean) => void>();

export const getUseProxies = (): boolean => useProxies;

export const setUseProxies = (value: boolean): void => {
  useProxies = value;
  try { localStorage.setItem(PROXY_TOGGLE_KEY, value ? "1" : "0"); } catch { /* ignore */ }
  for (const l of toggleListeners) l(value);
};

export const subscribeUseProxies = (listener: (useProxies: boolean) => void): () => void => {
  toggleListeners.add(listener);
  return () => toggleListeners.delete(listener);
};
