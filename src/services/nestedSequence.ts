/**
 * WebCut — nested sequences (#50) rasterizer.
 *
 * Renders a *nested* Project's overlays + image clips to an ImageBitmap for a
 * given frame. The bitmap is fed into the parent compositor as a normal layer
 * source — no recursive GPU compositing in this MVP.
 *
 * Constraints (called out in the UI):
 *   - Video clips inside a nested sequence are NOT rendered here. Nest-of-
 *     videos support would need a true recursive GPU compositor; this MVP
 *     scopes down to what a 2D canvas can render.
 *   - Nested sequences can be nested arbitrarily deep — but each level pays a
 *     rasterization cost, and cycles are refused at edit-time via
 *     `containsCycle()` below.
 *
 * Reuses the pure draw helpers from PreviewService (drawTextItem /
 * drawShapeItem / drawStickerItem / drawSubtitle) so a nested overlay looks
 * identical to a top-level one.
 */

import { fileSystemService } from "./FileSystemService";
import { drawAudioVizItem, drawShapeItem, drawStickerItem, drawSubtitle, drawTextItem, getWaveformPeaks } from "./PreviewService";
import { isOverlayItem, sampleAnimatable, type MediaAsset, type Project } from "../types/timeline";

const hexToRgb = (hex: string): [number, number, number] => {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.replace(/(.)/g, "$1$1") : c.padEnd(6, "0");
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
};

const nestedImageCache = new Map<string, ImageBitmap>();

/**
 * Rasterize one frame of a nested project. `nestedFrame` is the frame within
 * the nested project's own timebase (parent maps its clip-local frame to this).
 */
export const rasterizeNestedFrame = async (project: Project, nestedFrame: number): Promise<ImageBitmap> => {
  const w = project.settings.width;
  const h = project.settings.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2D context for nested sequence rasterization.");

  // Background.
  const [r, g, b] = hexToRgb(project.settings.backgroundColor);
  ctx.fillStyle = `rgb(${r * 255}, ${g * 255}, ${b * 255})`;
  ctx.fillRect(0, 0, w, h);

  const wholeFrame = Math.floor(nestedFrame);
  const visualTracks = project.tracks
    .filter((track) => track.kind === "video" && !track.hidden)
    .sort((a, b) => a.index - b.index);

  for (const track of visualTracks) {
    for (const item of track.items) {
      if (wholeFrame < item.startFrame || wholeFrame >= item.startFrame + item.durationFrames) continue;

      // Image clips: drawImage the source's cached ImageBitmap.
      if (item.type === "clip") {
        const asset = project.assets.find((a) => a.id === item.assetId);
        if (!asset || asset.kind !== "image") continue;
        const bmp = await getNestedImage(asset);
        if (bmp) ctx.drawImage(bmp, 0, 0, w, h);
        continue;
      }

      if (isOverlayItem(item)) {
        const local = Math.max(0, wholeFrame - item.startFrame);
        const pos = sampleAnimatable(item.transform.position, local);
        const scale = sampleAnimatable(item.transform.scale, local);
        const rotation = sampleAnimatable(item.transform.rotation, local);
        const opacity = sampleAnimatable(item.transform.opacity, local);
        ctx.save();
        ctx.globalAlpha = Math.min(1, Math.max(0, opacity));
        ctx.translate(w / 2 + pos.x, h / 2 + pos.y);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.scale(scale.x, scale.y);
        if (item.type === "text") drawTextItem(ctx as unknown as CanvasRenderingContext2D, item);
        else if (item.type === "shape") drawShapeItem(ctx as unknown as CanvasRenderingContext2D, item, w, h);
        else if (item.type === "sticker") drawStickerItem(ctx as unknown as CanvasRenderingContext2D, item);
        else {
          const asset = project.assets.find((a) => a.id === item.assetId);
          const peaks = asset ? await getWaveformPeaks(asset) : null;
          drawAudioVizItem(ctx as unknown as CanvasRenderingContext2D, item, peaks, local, item.durationFrames);
        }
        ctx.restore();
      }
    }
  }

  // Active subtitle for this frame.
  const sub = project.subtitles.find((s) => wholeFrame >= s.startFrame && wholeFrame < s.endFrame);
  if (sub) drawSubtitle(ctx as unknown as CanvasRenderingContext2D, w, h, sub.text, project.subtitleStyle);

  return createImageBitmap(canvas);
};

const getNestedImage = async (asset: MediaAsset): Promise<ImageBitmap | null> => {
  const cached = nestedImageCache.get(asset.handleKey);
  if (cached) return cached;
  try {
    const file = await fileSystemService.resolveMediaFile(asset.handleKey);
    const bmp = await createImageBitmap(file);
    nestedImageCache.set(asset.handleKey, bmp);
    return bmp;
  } catch {
    return null;
  }
};

/**
 * True when adding `child` as a nested project of `parent` would create a
 * cycle. Called by the store before wiring a sequence to prevent stack-blowing
 * recursion at render time.
 */
export const containsCycle = (parent: Project, child: Project): boolean => {
  if (parent === child) return true;
  const visited = new Set<string>([child.id]);
  const stack: Project[] = [child];
  while (stack.length > 0) {
    const p = stack.pop()!;
    for (const asset of p.assets) {
      if (asset.kind === "sequence" && asset.nestedProject) {
        if (asset.nestedProject.id === parent.id) return true;
        if (visited.has(asset.nestedProject.id)) continue;
        visited.add(asset.nestedProject.id);
        stack.push(asset.nestedProject);
      }
    }
  }
  return false;
};

/** Compute total duration in frames for a nested project (longest clip end). */
export const nestedProjectDuration = (project: Project): number => {
  let max = 0;
  for (const track of project.tracks) {
    for (const item of track.items) {
      max = Math.max(max, item.startFrame + item.durationFrames);
    }
  }
  return Math.max(1, max);
};
