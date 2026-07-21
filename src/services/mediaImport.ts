/**
 * WebCut — media ingest helpers.
 *
 * Shared by the file picker, clipboard paste, and drag-and-drop paths so every
 * entry point classifies, probes, and registers media the same way. Nothing
 * here touches the store — callers add the returned descriptors themselves.
 */

import { fileSystemService } from "./FileSystemService";
import { createId, type MediaAsset, type MediaAssetId, type MediaKind } from "../types/timeline";

const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|webm|mkv|avi|mts|m2ts)$/i;
const AUDIO_EXTENSIONS = /\.(mp3|wav|aac|flac|ogg|m4a|opus)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

/**
 * Windows frequently reports an empty/octet-stream MIME for .mov and other
 * containers, so the extension is the fallback source of truth.
 */
export const classifyMedia = (mimeType: string, fileName: string): MediaKind => {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (VIDEO_EXTENSIONS.test(fileName)) return "video";
  if (AUDIO_EXTENSIONS.test(fileName)) return "audio";
  if (IMAGE_EXTENSIONS.test(fileName)) return "image";
  return "video";
};

/** True if a File looks like importable media (by MIME or extension). */
export const isMediaFile = (file: File): boolean =>
  /^(video|audio|image)\//.test(file.type) ||
  VIDEO_EXTENSIONS.test(file.name) ||
  AUDIO_EXTENSIONS.test(file.name) ||
  IMAGE_EXTENSIONS.test(file.name);

/** Probe duration/dimensions via a throwaway media element (metadata only). */
export const probeMedia = (
  file: File,
  kind: MediaKind,
): Promise<{ duration: number; width: number; height: number }> =>
  new Promise((resolve) => {
    if (kind === "image") {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ duration: 5, width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ duration: 5, width: 0, height: 0 });
      };
      img.src = url;
      return;
    }
    const element = document.createElement(kind === "video" ? "video" : "audio");
    const url = URL.createObjectURL(file);
    element.preload = "metadata";
    element.onloadedmetadata = () => {
      const width = element instanceof HTMLVideoElement ? element.videoWidth : 0;
      const height = element instanceof HTMLVideoElement ? element.videoHeight : 0;
      URL.revokeObjectURL(url);
      resolve({ duration: element.duration || 5, width, height });
    };
    element.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ duration: 5, width: 0, height: 0 });
    };
    element.src = url;
  });

/**
 * Register handle-less File objects (dropped/pasted) as blobs and build
 * MediaAsset descriptors. Returns the descriptors; the caller adds them.
 */
export const ingestFiles = async (files: readonly File[], frameRate: number): Promise<MediaAsset[]> => {
  const assets: MediaAsset[] = [];
  for (const file of files) {
    if (!isMediaFile(file)) continue;
    const kind = classifyMedia(file.type || "", file.name);
    const handleKey = await fileSystemService.registerBlobFile(file);
    const probed = await probeMedia(file, kind);
    assets.push({
      id: createId<MediaAssetId>(),
      kind,
      name: file.name || `Pasted ${kind}`,
      handleKey,
      durationFrames: Math.max(1, Math.round(probed.duration * frameRate)),
      width: probed.width || undefined,
      height: probed.height || undefined,
      frameRate: undefined,
      mimeType: file.type || "application/octet-stream",
      fileSizeBytes: file.size,
    });
  }
  return assets;
};

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

const thumbnailCache = new Map<string, string>();
const THUMB_MAX = 160;

const drawToDataUrl = (source: HTMLImageElement | HTMLVideoElement, w: number, h: number): string | null => {
  if (w === 0 || h === 0) return null;
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
};

const imageThumbnail = (url: string): Promise<string | null> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(drawToDataUrl(img, img.naturalWidth, img.naturalHeight));
    img.onerror = () => resolve(null);
    img.src = url;
  });

const videoThumbnail = (url: string): Promise<string | null> =>
  new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = url;
    const cleanup = () => resolve(drawToDataUrl(video, video.videoWidth, video.videoHeight));
    video.onloadeddata = () => {
      // Seek slightly in so the poster isn't a black leader frame.
      video.currentTime = Math.min(1, (video.duration || 2) / 2);
    };
    video.onseeked = cleanup;
    video.onerror = () => resolve(null);
    // Fallback if seeking never fires.
    window.setTimeout(() => resolve(null), 4000);
  });

/** Generate (and cache) a small poster data URL for an asset. Audio → null. */
export const getThumbnail = async (asset: MediaAsset): Promise<string | null> => {
  if (asset.kind === "audio") return null;
  const cached = thumbnailCache.get(asset.id);
  if (cached) return cached;
  try {
    const file = await fileSystemService.resolveMediaFile(asset.handleKey);
    const url = URL.createObjectURL(file);
    const dataUrl = asset.kind === "image" ? await imageThumbnail(url) : await videoThumbnail(url);
    URL.revokeObjectURL(url);
    if (dataUrl) thumbnailCache.set(asset.id, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
};

/** MIME type used on drag-and-drop transfers carrying an existing asset id. */
export const ASSET_DND_MIME = "application/x-webcut-asset";
