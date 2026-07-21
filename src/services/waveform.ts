/**
 * WebCut — audio waveform peaks.
 *
 * Decodes an asset's audio once (Web Audio) into a fixed set of normalized peak
 * amplitudes for drawing on timeline clips. Cached per asset.
 */

import { fileSystemService } from "./FileSystemService";
import type { MediaAsset } from "../types/timeline";

const BUCKETS = 600;
const cache = new Map<string, number[]>();
const inflight = new Map<string, Promise<number[] | null>>();
let audioContext: AudioContext | null = null;

const compute = async (asset: MediaAsset): Promise<number[] | null> => {
  try {
    const file = await fileSystemService.resolveMediaFile(asset.handleKey);
    const bytes = await file.arrayBuffer();
    audioContext = audioContext ?? new AudioContext();
    const audio = await audioContext.decodeAudioData(bytes);
    const data = audio.getChannelData(0);
    const block = Math.max(1, Math.floor(data.length / BUCKETS));
    const peaks: number[] = [];
    for (let i = 0; i < BUCKETS; i++) {
      let max = 0;
      const start = i * block;
      for (let j = 0; j < block && start + j < data.length; j++) {
        const v = Math.abs(data[start + j]);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    cache.set(asset.id, peaks);
    return peaks;
  } catch {
    // Not all containers/codecs decode via Web Audio — no waveform is fine.
    return null;
  }
};

/** Normalized peak amplitudes (0..1) for an asset, or null if undecodable. */
export const getWaveform = async (asset: MediaAsset): Promise<number[] | null> => {
  if (asset.kind === "image") return null;
  const cached = cache.get(asset.id);
  if (cached) return cached;
  let pending = inflight.get(asset.id);
  if (!pending) {
    pending = compute(asset).finally(() => inflight.delete(asset.id));
    inflight.set(asset.id, pending);
  }
  return pending;
};
