/**
 * WebCut — export platform presets (#71).
 *
 * A preset is a partial `ExportOptions` — start/end frames are always project-
 * relative and computed at queue time, not baked into the preset.
 */

import type { ExportFormat, ExportOptions } from "./ExportService";

export interface ExportPreset {
  readonly id: string;
  readonly name: string;
  readonly group: "YouTube" | "Social" | "Mastering";
  /** Fields fixed by the preset; caller merges startFrame/endFrame. */
  readonly options: Omit<ExportOptions, "startFrame" | "endFrame">;
}

const mp4 = (name: string, group: ExportPreset["group"], width: number, height: number, fps: number, mbps: number, id?: string): ExportPreset => ({
  id: id ?? `preset:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  name,
  group,
  options: { width, height, frameRate: fps, format: "mp4" as ExportFormat, videoBitrate: mbps * 1_000_000 },
});

const webm = (name: string, group: ExportPreset["group"], width: number, height: number, fps: number, mbps: number, id?: string): ExportPreset => ({
  id: id ?? `preset:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  name,
  group,
  options: { width, height, frameRate: fps, format: "webm" as ExportFormat, videoBitrate: mbps * 1_000_000 },
});

/**
 * Common delivery targets. Bitrates chosen to sit at or just above each
 * platform's recommended SDR upload rate so the source doesn't get double-
 * compressed on their side.
 */
export const EXPORT_PRESETS: readonly ExportPreset[] = [
  mp4("YouTube 1080p", "YouTube", 1920, 1080, 30, 12),
  mp4("YouTube 1080p60", "YouTube", 1920, 1080, 60, 18),
  mp4("YouTube 4K", "YouTube", 3840, 2160, 30, 45),
  mp4("YouTube 4K60", "YouTube", 3840, 2160, 60, 68),
  mp4("Instagram Reel (9:16)", "Social", 1080, 1920, 30, 10),
  mp4("TikTok (9:16)", "Social", 1080, 1920, 30, 10),
  mp4("Instagram Feed (1:1)", "Social", 1080, 1080, 30, 8),
  mp4("Twitter / X (16:9)", "Social", 1920, 1080, 30, 10),
  // "Mastering" — high-bitrate SDR intermediate. Not true ProRes/DNxHD (they
  // aren't WebCodecs-encodable in the browser), but a visually equivalent
  // high-bitrate AVC that survives a re-edit round without noticeable loss.
  mp4("Mastering — 1080p high-bitrate (~ProRes)", "Mastering", 1920, 1080, 30, 80),
  mp4("Mastering — 4K high-bitrate (~ProRes)", "Mastering", 3840, 2160, 30, 200),
  mp4("Mastering — 1080p intermediate (~DNxHD)", "Mastering", 1920, 1080, 30, 45),
  webm("Web (WebM VP9 1080p)", "Social", 1920, 1080, 30, 8),
];
