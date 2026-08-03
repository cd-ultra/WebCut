/**
 * WebCut — chapter marker sidecar (#72).
 *
 * The MP4/WebM muxers we use (`mp4-muxer` / `webm-muxer`) don't expose
 * chapter atom/tag writing — WebCodecs can't produce a QuickTime `chpl`
 * atom either. The practical alternative is a WebVTT sidecar named
 * `<video>.chapters.vtt`, which YouTube and most desktop players
 * recognize alongside the video file.
 *
 * Only markers within the export range contribute chapters. The first
 * chapter starts at 00:00.000 regardless of the first marker's frame,
 * so the whole export is covered.
 */

import type { Marker, Project } from "../types/timeline";

const fmt = (seconds: number): string => {
  const s = Math.max(0, seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(hh, 2)}:${pad(mm, 2)}:${ss.toFixed(3).padStart(6, "0")}`;
};

export interface ChapterRange {
  readonly label: string;
  readonly startSec: number;
  readonly endSec: number;
}

/**
 * Turn the project's markers into contiguous chapter ranges over
 * [startFrame, endFrame). Consecutive markers become adjacent ranges;
 * the final range runs to the end of the export.
 */
export const buildChapterRanges = (
  markers: readonly Marker[],
  startFrame: number,
  endFrame: number,
  frameRate: number,
): ChapterRange[] => {
  const inRange = markers
    .filter((m) => m.frame >= startFrame && m.frame < endFrame)
    .sort((a, b) => a.frame - b.frame);
  if (inRange.length === 0) return [];

  const totalSec = (endFrame - startFrame) / frameRate;
  const ranges: ChapterRange[] = [];
  // Synthesize an "Intro" chapter starting at 0 if the first marker isn't at
  // the start of the export.
  if ((inRange[0].frame - startFrame) / frameRate > 0.1) {
    ranges.push({
      label: "Intro",
      startSec: 0,
      endSec: (inRange[0].frame - startFrame) / frameRate,
    });
  }
  for (let i = 0; i < inRange.length; i++) {
    const m = inRange[i];
    const startSec = (m.frame - startFrame) / frameRate;
    const endSec = i + 1 < inRange.length
      ? (inRange[i + 1].frame - startFrame) / frameRate
      : totalSec;
    if (endSec <= startSec) continue;
    ranges.push({ label: m.label || `Chapter ${i + 1}`, startSec, endSec });
  }
  return ranges;
};

/** Format chapter ranges as a WebVTT chapter file. Empty string when no chapters. */
export const chaptersToWebVtt = (ranges: readonly ChapterRange[]): string => {
  if (ranges.length === 0) return "";
  const cues = ranges
    .map((r, i) => `Chapter ${i + 1}\n${fmt(r.startSec)} --> ${fmt(r.endSec)}\n${r.label}\n`)
    .join("\n");
  return `WEBVTT\nKind: chapters\n\n${cues}`;
};

/** Convenience — extract chapters for a project's whole timeline. */
export const projectChaptersToWebVtt = (
  project: Project,
  startFrame: number,
  endFrame: number,
): string => chaptersToWebVtt(buildChapterRanges(project.markers, startFrame, endFrame, project.settings.frameRate));
