/**
 * WebCut — relink media whose local handle no longer resolves.
 *
 * A `.webcut` file records `handleKey`s that only mean something inside the
 * browser profile that created them. Open the same project on another machine
 * (or after site data is cleared) and every asset dead-ends. This module finds
 * those assets and re-points them at real files on this machine, matching by
 * content hash where available.
 *
 * Matching is tiered so it still works for projects saved before hashing
 * existed:
 *
 *   1. contentHash  — exact; survives renames and moves.
 *   2. name + size  — strong; survives moves.
 *   3. name         — a guess, surfaced as such in the UI.
 */

import { fileSystemService } from "./FileSystemService";
import { computeContentHash } from "./mediaHash";
import type { MediaAsset, MediaAssetId, Project } from "../types/timeline";

export type MatchQuality = "hash" | "size" | "name";

export interface MissingMedia {
  readonly asset: MediaAsset;
  readonly reason: "no-handle";
}

export interface RelinkMatch {
  readonly handle: FileSystemFileHandle;
  readonly file: File;
  readonly quality: MatchQuality;
}

/** Directory walk limits, so pointing at a huge tree can't hang the UI. */
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_FILES = 5000;

/**
 * Assets with no media stored under their handle key — the cross-machine case
 * this flow exists for.
 *
 * Uses the non-invasive probe rather than `resolveMediaFile`, so surveying a
 * project never triggers a gesture-less permission request. Assets that merely
 * need permission are NOT reported: that is the ordinary state after a reload
 * on the machine that owns the files, and the first real read re-grants it.
 * Treating those as missing would fill this dialog with false positives.
 *
 * Nested sequences are skipped: their `handleKey` is `sequence:<id>` and the
 * content travels inside `nestedProject`, so there is no file to relink.
 */
export const findMissingMedia = async (project: Project): Promise<MissingMedia[]> => {
  const missing: MissingMedia[] = [];
  for (const asset of project.assets) {
    if (asset.kind === "sequence") continue;
    if ((await fileSystemService.probeMediaAvailability(asset.handleKey)) === "missing") {
      missing.push({ asset, reason: "no-handle" });
    }
  }
  return missing;
};

/** Score one candidate file against one asset, or null when it can't be it. */
const gradeCandidate = async (asset: MediaAsset, file: File): Promise<MatchQuality | null> => {
  const sameName = file.name === asset.name;
  const sameSize = file.size === asset.fileSizeBytes;
  // Hashing is the expensive step, so only pay for it when the size already
  // agrees — a different size can never be the same file.
  if (asset.contentHash && sameSize) {
    if ((await computeContentHash(file)) === asset.contentHash) return "hash";
  }
  if (sameName && sameSize) return "size";
  if (sameName) return "name";
  return null;
};

const QUALITY_RANK: Record<MatchQuality, number> = { hash: 3, size: 2, name: 1 };

/**
 * Walk a directory the user picked and match its files against the missing
 * assets. Best match per asset wins; each file is claimed by at most one asset
 * so two assets can't collapse onto the same source.
 */
export const scanDirectory = async (
  dir: FileSystemDirectoryHandle,
  wanted: readonly MediaAsset[],
  onProgress?: (scanned: number) => void,
): Promise<Map<MediaAssetId, RelinkMatch>> => {
  const best = new Map<MediaAssetId, RelinkMatch>();
  const claimed = new Set<FileSystemFileHandle>();
  let scanned = 0;

  const walk = async (handle: FileSystemDirectoryHandle, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || scanned >= MAX_SCAN_FILES) return;
    for await (const entry of handle.values()) {
      if (scanned >= MAX_SCAN_FILES) return;
      if (entry.kind === "directory") {
        await walk(entry, depth + 1);
        continue;
      }
      scanned += 1;
      onProgress?.(scanned);
      const fileHandle = entry as FileSystemFileHandle;
      let file: File;
      try {
        file = await fileHandle.getFile();
      } catch {
        continue; // unreadable entry — skip it rather than abort the scan
      }
      for (const asset of wanted) {
        if (claimed.has(fileHandle)) break;
        const quality = await gradeCandidate(asset, file);
        if (!quality) continue;
        const current = best.get(asset.id);
        if (current && QUALITY_RANK[current.quality] >= QUALITY_RANK[quality]) continue;
        best.set(asset.id, { handle: fileHandle, file, quality });
        if (quality === "hash") claimed.add(fileHandle); // exact — stop reconsidering it
      }
    }
  };

  await walk(dir, 0);
  return best;
};

/**
 * Point matched assets at their new files.
 *
 * Refreshes size and hash from what was actually found, and drops
 * `proxyHandleKey` — a proxy (#51) is a local derivative whose key means
 * nothing on this machine, so it must be regenerated rather than dangle.
 */
export const relinkProject = async (
  project: Project,
  matches: ReadonlyMap<MediaAssetId, RelinkMatch>,
): Promise<Project> => {
  if (matches.size === 0) return project;
  const patches = new Map<MediaAssetId, Partial<MediaAsset>>();

  for (const [assetId, match] of matches) {
    const handleKey = await fileSystemService.registerMediaHandle(match.handle);
    patches.set(assetId, {
      handleKey,
      fileSizeBytes: match.file.size,
      contentHash: await computeContentHash(match.file),
      proxyHandleKey: undefined,
      proxyWidth: undefined,
      proxyHeight: undefined,
    });
  }

  return {
    ...project,
    assets: project.assets.map((asset) => {
      const patch = patches.get(asset.id);
      return patch ? { ...asset, ...patch } : asset;
    }),
  };
};

/** True when the browser can open a directory picker for a folder-wide relink. */
export const canPickDirectory = (): boolean => typeof window.showDirectoryPicker === "function";

/**
 * Give already-resolvable assets a `contentHash` if they don't have one, so
 * projects created before hashing existed become portable simply by being
 * opened once.
 *
 * `patch` should be the store's `updateAsset`, which deliberately records no
 * undo entry — this is a machine-generated derivative, not a user edit.
 * Returns how many assets were backfilled.
 */
export const backfillContentHashes = async (
  project: Project,
  patch: (assetId: MediaAssetId, update: Partial<MediaAsset>) => void,
): Promise<number> => {
  let filled = 0;
  for (const asset of project.assets) {
    if (asset.contentHash || asset.kind === "sequence") continue;
    // Only touch what's readable without prompting — hashing is a background
    // nicety and must never provoke a permission dialog.
    if ((await fileSystemService.probeMediaAvailability(asset.handleKey)) !== "ok") continue;
    try {
      const file = await fileSystemService.resolveMediaFile(asset.handleKey);
      const contentHash = await computeContentHash(file);
      if (!contentHash) return filled; // no WebCrypto here — the rest will fail too
      patch(asset.id, { contentHash });
      filled += 1;
    } catch {
      continue; // unresolvable: the relink flow handles it
    }
  }
  return filled;
};
