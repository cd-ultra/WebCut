/**
 * WebCut — subtitle (SRT/VTT) parsing and serialization.
 *
 * Pure helpers: convert between the frame-based `Subtitle` model and the
 * seconds-based SRT/VTT text formats.
 */

import { createId, type Subtitle, type SubtitleId } from "../types/timeline";

const parseTimecode = (tc: string): number | null => {
  // HH:MM:SS,mmm or HH:MM:SS.mmm (VTT also allows MM:SS.mmm)
  const m = tc.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4].padEnd(3, "0"));
  return h * 3600 + min * 60 + s + ms / 1000;
};

const formatTimecode = (seconds: number): string => {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
};

/** Parse SRT or VTT text into frame-based subtitle cues. */
export const parseCaptions = (text: string, fps: number): Subtitle[] => {
  const cleaned = text.replace(/\r/g, "").replace(/^WEBVTT.*\n/i, "");
  const blocks = cleaned.split(/\n{2,}/);
  const out: Subtitle[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    // Optional numeric index line (SRT).
    const timeLineIdx = /-->/g.test(lines[0]) ? 0 : 1;
    const timeLine = lines[timeLineIdx];
    if (!timeLine || !timeLine.includes("-->")) continue;
    const [rawStart, rawEnd] = timeLine.split("-->");
    const start = parseTimecode(rawStart ?? "");
    const end = parseTimecode((rawEnd ?? "").split(/\s+/)[0] ?? "");
    if (start === null || end === null) continue;
    const body = lines.slice(timeLineIdx + 1).join("\n").trim();
    if (!body) continue;
    out.push({
      id: createId<SubtitleId>(),
      startFrame: Math.round(start * fps),
      endFrame: Math.max(Math.round(start * fps) + 1, Math.round(end * fps)),
      text: body,
    });
  }
  return out.sort((a, b) => a.startFrame - b.startFrame);
};

/** Serialize subtitle cues to SRT text. */
export const toSrt = (subtitles: readonly Subtitle[], fps: number): string =>
  subtitles
    .map((s, i) => {
      const start = formatTimecode(s.startFrame / fps);
      const end = formatTimecode(s.endFrame / fps);
      return `${i + 1}\n${start} --> ${end}\n${s.text}`;
    })
    .join("\n\n") + "\n";
