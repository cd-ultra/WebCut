/**
 * WebCut — batch export queue (#71).
 *
 * A tiny job manager on top of `exportProject`. Jobs run strictly sequentially
 * — WebGPU device + a single OffscreenCanvas encoder are not safe to run in
 * parallel from the same page. Each job carries its own AbortController so the
 * user can cancel one without stopping the rest.
 *
 * The queue is session-scoped (in-memory only) because export outputs are
 * saved through the File System Access API immediately on completion.
 */

import type { Project } from "../types/timeline";
import { exportProject, projectEndFrame, type ExportOptions, type ExportProgress } from "./ExportService";
import type { ExportPreset } from "./ExportPresets";

export type ExportJobStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface ExportJob {
  readonly id: string;
  readonly presetName: string;
  readonly options: ExportOptions;
  status: ExportJobStatus;
  progress: ExportProgress | null;
  error: string | null;
  /** Populated on `done` — the finalized blob, filename, and (optional) chapter sidecar. */
  result: { blob: Blob; filename: string; chaptersVtt: string } | null;
}

type Listener = (jobs: readonly ExportJob[]) => void;

class ExportQueueImpl {
  private jobs: ExportJob[] = [];
  private listeners = new Set<Listener>();
  private running: { jobId: string; controller: AbortController } | null = null;
  /** Optional callback invoked when a job finishes successfully. */
  private onFinished: ((job: ExportJob) => void) | null = null;

  setOnFinished(cb: ((job: ExportJob) => void) | null): void {
    this.onFinished = cb;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.jobs);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    // Snapshot so subscribers don't hold references into the mutable array.
    const snapshot = this.jobs.map((j) => ({ ...j }));
    for (const l of this.listeners) l(snapshot);
  }

  getJobs(): readonly ExportJob[] {
    return this.jobs;
  }

  enqueueFromPreset(project: Project, preset: ExportPreset): ExportJob {
    const endFrame = projectEndFrame(project);
    const options: ExportOptions = { ...preset.options, startFrame: 0, endFrame };
    return this.enqueue(preset.name, options);
  }

  enqueue(presetName: string, options: ExportOptions): ExportJob {
    const job: ExportJob = {
      id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      presetName,
      options,
      status: "pending",
      progress: null,
      error: null,
      result: null,
    };
    this.jobs.push(job);
    this.emit();
    return job;
  }

  cancel(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return;
    if (job.status === "running" && this.running?.jobId === jobId) {
      this.running.controller.abort();
    } else if (job.status === "pending") {
      job.status = "cancelled";
      this.emit();
    }
  }

  remove(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return;
    if (job.status === "running") return; // let cancel-then-finish clean it up
    this.jobs = this.jobs.filter((j) => j.id !== jobId);
    this.emit();
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.status === "running" || j.status === "pending");
    this.emit();
  }

  /**
   * Drive the queue. Runs any pending jobs, one at a time, until the queue is
   * empty. Safe to call while already running (no-op in that case).
   */
  async runAll(project: Project): Promise<void> {
    if (this.running) return;
    while (true) {
      const next = this.jobs.find((j) => j.status === "pending");
      if (!next) break;
      const controller = new AbortController();
      this.running = { jobId: next.id, controller };
      next.status = "running";
      next.progress = { phase: "preparing", frame: 0, totalFrames: Math.max(1, next.options.endFrame - next.options.startFrame) };
      this.emit();
      try {
        const result = await exportProject(
          project,
          next.options,
          (p) => {
            next.progress = p;
            this.emit();
          },
          controller.signal,
        );
        next.result = result;
        next.status = "done";
        this.onFinished?.(next);
      } catch (err) {
        if ((err as DOMException).name === "AbortError") {
          next.status = "cancelled";
        } else {
          next.status = "error";
          next.error = err instanceof Error ? err.message : String(err);
        }
      } finally {
        this.running = null;
        this.emit();
      }
    }
  }
}

export const exportQueue = new ExportQueueImpl();
