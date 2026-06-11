/**
 * WebCut — pro-tier workspace layout.
 *
 *  ┌──────────────┬───────────────────────────────┬──────────────┐
 *  │  Media Pool  │     WebGPU Program Monitor    │  Inspector   │
 *  ├──────────────┴───────────────────────────────┴──────────────┤
 *  │                     Multi-track Timeline                    │
 *  └──────────────────────────────────────────────────────────────┘
 */

import { useCallback, useMemo, useState } from "react";
import {
  Clapperboard,
  FileAudio,
  FileVideo,
  FolderOpen,
  Image as ImageIcon,
  Import,
  Plus,
  Save,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { VideoPlayer } from "./VideoPlayer";
import { Timeline } from "./Timeline";
import { fileSystemService, isUserAbort } from "../services/FileSystemService";
import { transport, useTimelineStore } from "../store/timelineStore";
import {
  createId,
  defaultCorridorKeyParams,
  identityTransform,
  type CorridorKeyParams,
  type Effect,
  type EffectId,
  type MediaAsset,
  type MediaAssetId,
  type MediaKind,
  type TrackItem,
} from "../types/timeline";

// ---------------------------------------------------------------------------
// Media probing
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|webm|mkv|avi|mts|m2ts)$/i;
const AUDIO_EXTENSIONS = /\.(mp3|wav|aac|flac|ogg|m4a|opus)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

/**
 * Windows frequently reports an empty/octet-stream MIME for .mov and other
 * containers, so the extension is the fallback source of truth.
 */
const classifyMedia = (mimeType: string, fileName: string): MediaKind => {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (VIDEO_EXTENSIONS.test(fileName)) return "video";
  if (AUDIO_EXTENSIONS.test(fileName)) return "audio";
  if (IMAGE_EXTENSIONS.test(fileName)) return "image";
  return "video";
};

/** Probe duration/dimensions via a throwaway media element (metadata only). */
const probeMedia = (file: File, kind: MediaKind): Promise<{ duration: number; width: number; height: number }> =>
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

const MEDIA_ICONS: Record<MediaKind, typeof FileVideo> = {
  video: FileVideo,
  audio: FileAudio,
  image: ImageIcon,
};

// ---------------------------------------------------------------------------
// Media pool (left panel)
// ---------------------------------------------------------------------------

const MediaPool = () => {
  const assets = useTimelineStore((state) => state.project.assets);
  const tracks = useTimelineStore((state) => state.project.tracks);
  const frameRate = useTimelineStore((state) => state.project.settings.frameRate);
  const addAsset = useTimelineStore((state) => state.addAsset);
  const addClipToTrack = useTimelineStore((state) => state.addClipToTrack);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleImport = useCallback(async () => {
    setImporting(true);
    setError(null);
    try {
      const imported = await fileSystemService.importMediaFiles();
      for (const { handleKey, file } of imported) {
        const kind = classifyMedia(file.type || "", file.name);
        const probed = await probeMedia(file, kind);
        addAsset({
          id: createId<MediaAssetId>(),
          kind,
          name: file.name,
          handleKey,
          durationFrames: Math.max(1, Math.round(probed.duration * frameRate)),
          width: probed.width || undefined,
          height: probed.height || undefined,
          frameRate: undefined,
          mimeType: file.type || "application/octet-stream",
          fileSizeBytes: file.size,
        });
      }
    } catch (importError) {
      if (!isUserAbort(importError)) {
        setError(importError instanceof Error ? importError.message : String(importError));
      }
    } finally {
      setImporting(false);
    }
  }, [addAsset, frameRate]);

  const armedTrackId = useTimelineStore((state) => state.armedTrackId);

  const handleAddToTimeline = useCallback(
    (asset: MediaAsset) => {
      const preferredKind = asset.kind === "audio" ? "audio" : "video";
      const armed = tracks.find((t) => t.id === armedTrackId && t.kind === preferredKind && !t.locked);
      const track = armed ?? tracks.find((t) => t.kind === preferredKind && !t.locked) ?? tracks[0];
      if (!track) return;
      // Armed track: insert at the playhead (stacking workflow for keying).
      // Untargeted: append after the last clip on the track.
      const playheadEnd = armed
        ? Math.round(transport.getFrame())
        : track.items.reduce((max, item) => Math.max(max, item.startFrame + item.durationFrames), 0);
      const clip: Omit<Extract<TrackItem, { type: "clip" }>, "id"> = {
        type: "clip",
        name: asset.name,
        assetId: asset.id,
        startFrame: playheadEnd,
        durationFrames: asset.durationFrames,
        sourceInFrame: 0,
        speed: 1,
        audioGainDb: 0,
        audioMuted: false,
        transform: identityTransform(),
        effects: [],
        locked: false,
      };
      addClipToTrack(track.id, clip);
    },
    [tracks, addClipToTrack, armedTrackId],
  );

  return (
    <div className="flex h-full flex-col">
      <PanelTitle icon={<FolderOpen size={13} />} title="Media Pool" />
      <div className="p-2">
        <button
          onClick={handleImport}
          disabled={importing}
          className="flex w-full items-center justify-center gap-2 rounded border border-edge bg-panel-raised px-3 py-1.5 text-xs text-neutral-200 hover:border-accent/60 disabled:opacity-50"
        >
          <Import size={13} />
          {importing ? "Importing…" : "Import Media"}
        </button>
        {error && <p className="mt-2 text-[10px] leading-snug text-red-400">{error}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {assets.length === 0 && (
          <p className="px-1 pt-4 text-center text-[11px] leading-relaxed text-neutral-600">
            No media yet. Files stream straight from your disk — nothing is uploaded.
          </p>
        )}
        {assets.map((asset) => {
          const Icon = MEDIA_ICONS[asset.kind];
          return (
            <div
              key={asset.id}
              className="group mb-1 flex items-center gap-2 rounded border border-transparent bg-panel-raised/60 px-2 py-1.5 hover:border-edge"
            >
              <Icon size={14} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-neutral-200">{asset.name}</p>
                <p className="font-mono text-[9px] text-neutral-500">
                  {(asset.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
                  {asset.width ? ` · ${asset.width}×${asset.height}` : ""}
                </p>
              </div>
              <button
                title="Add to timeline"
                onClick={() => handleAddToTimeline(asset)}
                className="rounded p-1 text-neutral-500 opacity-0 hover:bg-panel hover:text-accent group-hover:opacity-100"
              >
                <Plus size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Inspector (right panel)
// ---------------------------------------------------------------------------

const SliderRow = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) => (
  <label className="mb-2 block">
    <span className="mb-1 flex justify-between text-[10px] text-neutral-400">
      {label}
      <span className="font-mono text-neutral-500">{value.toFixed(2)}</span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="h-1 w-full cursor-pointer appearance-none rounded bg-panel-raised accent-(--color-accent)"
    />
  </label>
);

const Inspector = () => {
  const selectedItemIds = useTimelineStore((state) => state.selectedItemIds);
  const tracks = useTimelineStore((state) => state.project.tracks);
  const updateItemEffects = useTimelineStore((state) => state.updateItemEffects);

  const selectedItem = useMemo(() => {
    if (selectedItemIds.length !== 1) return undefined;
    for (const track of tracks) {
      const found = track.items.find((item) => item.id === selectedItemIds[0]);
      if (found) return found;
    }
    return undefined;
  }, [selectedItemIds, tracks]);

  const corridorKey = selectedItem?.effects.find(
    (effect): effect is Extract<Effect, { type: "corridor-key" }> => effect.type === "corridor-key",
  );

  const applyKeyParams = useCallback(
    (params: Partial<CorridorKeyParams>) => {
      if (!selectedItem) return;
      const existing = selectedItem.effects.find((e) => e.type === "corridor-key");
      const nextEffects: Effect[] = existing
        ? selectedItem.effects.map((effect) =>
            effect.type === "corridor-key" ? { ...effect, params: { ...effect.params, ...params } } : effect,
          )
        : [
            ...selectedItem.effects,
            {
              id: createId<EffectId>(),
              type: "corridor-key" as const,
              enabled: true,
              params: { ...defaultCorridorKeyParams(), ...params },
            },
          ];
      updateItemEffects(selectedItem.id, nextEffects);
    },
    [selectedItem, updateItemEffects],
  );

  return (
    <div className="flex h-full flex-col">
      <PanelTitle icon={<SlidersHorizontal size={13} />} title="Inspector" />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!selectedItem && (
          <p className="pt-4 text-center text-[11px] leading-relaxed text-neutral-600">
            Select a clip on the timeline to edit its properties.
          </p>
        )}

        {selectedItem && (
          <>
            <p className="mb-1 truncate text-xs font-medium text-neutral-200">{selectedItem.name}</p>
            <p className="mb-4 font-mono text-[10px] text-neutral-500">
              {selectedItem.durationFrames}f @ frame {selectedItem.startFrame}
            </p>

            <div className="mb-3 flex items-center gap-2">
              <Sparkles size={13} className="text-accent-warm" />
              <span className="text-[11px] font-semibold tracking-wide text-neutral-300">CORRIDORKEY MATTE</span>
            </div>

            {!corridorKey && (
              <button
                onClick={() => applyKeyParams({})}
                className="w-full rounded border border-edge bg-panel-raised px-3 py-1.5 text-xs text-neutral-200 hover:border-accent/60"
              >
                Enable CorridorKey
              </button>
            )}

            {corridorKey && (
              <div className="rounded border border-edge bg-panel/60 p-2.5">
                <label className="mb-3 flex items-center justify-between text-[10px] text-neutral-400">
                  Key color
                  <input
                    type="color"
                    value={rgbToHex(corridorKey.params.keyColor)}
                    onChange={(event) => applyKeyParams({ keyColor: hexToRgb(event.target.value) })}
                    className="h-6 w-10 cursor-pointer rounded border border-edge bg-transparent"
                  />
                </label>
                <SliderRow
                  label="Similarity"
                  value={corridorKey.params.similarity}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(similarity) => applyKeyParams({ similarity })}
                />
                <SliderRow
                  label="Smoothness"
                  value={corridorKey.params.smoothness}
                  min={0.001}
                  max={0.5}
                  step={0.001}
                  onChange={(smoothness) => applyKeyParams({ smoothness })}
                />
                <SliderRow
                  label="Edge erosion"
                  value={corridorKey.params.edgeErosion}
                  min={0}
                  max={0.5}
                  step={0.005}
                  onChange={(edgeErosion) => applyKeyParams({ edgeErosion })}
                />
                <SliderRow
                  label="Feather (px)"
                  value={corridorKey.params.featherRadiusPx}
                  min={0}
                  max={10}
                  step={0.1}
                  onChange={(featherRadiusPx) => applyKeyParams({ featherRadiusPx })}
                />
                <SliderRow
                  label="Spill suppression"
                  value={corridorKey.params.spillSuppression}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(spillSuppression) => applyKeyParams({ spillSuppression })}
                />
                <SliderRow
                  label="Neural matte mix"
                  value={corridorKey.params.neuralMatteMix}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(neuralMatteMix) => applyKeyParams({ neuralMatteMix })}
                />
                <label className="flex items-center gap-2 pt-1 text-[10px] text-neutral-400">
                  <input
                    type="checkbox"
                    checked={corridorKey.params.useNeuralMatte}
                    onChange={(event) => applyKeyParams({ useNeuralMatte: event.target.checked })}
                    className="accent-(--color-accent)"
                  />
                  Drive matte with ONNX neural session
                </label>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const rgbToHex = (rgb: readonly [number, number, number]): string =>
  `#${rgb.map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

const PanelTitle = ({ icon, title }: { icon: React.ReactNode; title: string }) => (
  <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-[11px] font-semibold tracking-wide text-neutral-400">
    {icon}
    {title.toUpperCase()}
  </div>
);

// ---------------------------------------------------------------------------
// Main layout
// ---------------------------------------------------------------------------

export const MainLayout = () => {
  const projectName = useTimelineStore((state) => state.project.name);
  const setProject = useTimelineStore((state) => state.setProject);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const withStatus = useCallback(async (label: string, action: () => Promise<void>) => {
    try {
      await action();
      setStatusMessage(label);
      window.setTimeout(() => setStatusMessage(null), 2500);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
      window.setTimeout(() => setStatusMessage(null), 5000);
    }
  }, []);

  const handleSave = useCallback(
    () =>
      withStatus("Project saved", async () => {
        await fileSystemService.saveProject(useTimelineStore.getState().project);
      }),
    [withStatus],
  );

  const handleOpen = useCallback(
    () =>
      withStatus("Project loaded", async () => {
        const project = await fileSystemService.openProject();
        if (project) setProject(project);
      }),
    [withStatus, setProject],
  );

  return (
    <div className="flex h-full flex-col bg-panel-deep text-sm">
      {/* App bar */}
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-edge bg-panel px-3">
        <Clapperboard size={16} className="text-accent" />
        <span className="text-[13px] font-semibold tracking-wide text-neutral-100">WebCut</span>
        <span className="truncate text-xs text-neutral-500">{projectName}.webcut</span>

        <div className="flex-1" />

        {statusMessage && <span className="text-[11px] text-accent">{statusMessage}</span>}

        <button
          onClick={handleOpen}
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-[11px] text-neutral-300 hover:border-accent/60"
        >
          <FolderOpen size={12} /> Open
        </button>
        <button
          onClick={handleSave}
          className="flex items-center gap-1.5 rounded bg-accent/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent"
        >
          <Save size={12} /> Save
        </button>
      </header>

      {/* Workspace */}
      <div className="flex min-h-0 flex-[3] border-b border-edge">
        <aside className="w-60 shrink-0 border-r border-edge bg-panel-deep">
          <MediaPool />
        </aside>
        <main className="min-w-0 flex-1">
          <VideoPlayer />
        </main>
        <aside className="w-72 shrink-0 border-l border-edge bg-panel-deep">
          <Inspector />
        </aside>
      </div>

      {/* Timeline */}
      <div className="min-h-0 flex-[2]">
        <Timeline />
      </div>
    </div>
  );
};
