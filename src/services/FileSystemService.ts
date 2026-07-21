/**
 * WebCut — FileSystemService.
 *
 * Local-first persistence built on the File System Access API. Media is never
 * uploaded anywhere: we hold FileSystemFileHandle references, persist them in
 * IndexedDB (handles are structured-cloneable), and stream bytes straight off
 * the user's disk into WebCodecs.
 *
 * `.webcut` project files are plain JSON (schema in src/types/timeline.ts)
 * written via showSaveFilePicker, so projects remain portable and inspectable.
 */

import type { Project } from "../types/timeline";

// ---------------------------------------------------------------------------
// File System Access API ambient declarations
// (lib.dom omits picker APIs behind a flag in some TS versions; declare the
// minimal surface we rely on so the build is environment-independent.)
// ---------------------------------------------------------------------------

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: FilePickerAcceptType[];
  id?: string;
  startIn?: string;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
  types?: FilePickerAcceptType[];
  id?: string;
}

type PermissionMode = { mode?: "read" | "readwrite" };

declare global {
  interface FileSystemHandle {
    queryPermission?(descriptor?: PermissionMode): Promise<PermissionState>;
    requestPermission?(descriptor?: PermissionMode): Promise<PermissionState>;
  }

  interface Window {
    showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }
}

export class FileSystemUnsupportedError extends Error {
  constructor() {
    super(
      "The File System Access API is unavailable. WebCut requires a Chromium-based browser (Chrome/Edge 102+) in a secure context.",
    );
    this.name = "FileSystemUnsupportedError";
  }
}

export const isFileSystemAccessSupported = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.showOpenFilePicker === "function" &&
  typeof window.showSaveFilePicker === "function";

const MEDIA_ACCEPT: FilePickerAcceptType[] = [
  {
    description: "Media files",
    accept: {
      "video/*": [".mp4", ".webm", ".mov", ".mkv", ".avi"],
      "audio/*": [".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a"],
      "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"],
    },
  },
];

const PROJECT_ACCEPT: FilePickerAcceptType[] = [
  {
    description: "WebCut project",
    accept: { "application/json": [".webcut"] },
  },
];

/** User dismissed the picker — callers should treat this as a silent no-op. */
export const isUserAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

// ---------------------------------------------------------------------------
// IndexedDB handle store — survives reloads so projects can re-link media.
// ---------------------------------------------------------------------------

const DB_NAME = "webcut-fs";
const DB_VERSION = 1;
const HANDLE_STORE = "file-handles";

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });

/** Stored media reference: either a re-acquirable disk handle or an inline blob. */
type StoredMediaRef = FileSystemFileHandle | File;

const idbPut = async (key: string, value: StoredMediaRef): Promise<void> => {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, "readwrite");
      tx.objectStore(HANDLE_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    });
  } finally {
    db.close();
  }
};

const idbGet = async (key: string): Promise<StoredMediaRef | undefined> => {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, "readonly");
      const request = tx.objectStore(HANDLE_STORE).get(key);
      request.onsuccess = () => resolve(request.result as StoredMediaRef | undefined);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
  } finally {
    db.close();
  }
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ImportedMediaFile {
  readonly handleKey: string;
  readonly file: File;
  readonly handle: FileSystemFileHandle;
}

export class FileSystemService {
  /** Live handle cache; IndexedDB is the durable layer beneath it. */
  private readonly handleCache = new Map<string, FileSystemFileHandle>();

  /** In-memory cache for inline blobs (pasted/dropped media without a handle). */
  private readonly blobCache = new Map<string, File>();

  /** Handle to the currently open .webcut file, enabling silent re-save. */
  private projectHandle: FileSystemFileHandle | null = null;

  private assertSupported(): void {
    if (!isFileSystemAccessSupported()) {
      throw new FileSystemUnsupportedError();
    }
  }

  // -- Media ingest ---------------------------------------------------------

  /**
   * Open the native picker for one or more media files. Returns the live File
   * objects (for immediate probing/decoding) alongside durable handle keys.
   */
  async importMediaFiles(): Promise<ImportedMediaFile[]> {
    this.assertSupported();
    let handles: FileSystemFileHandle[];
    try {
      handles = await window.showOpenFilePicker!({
        multiple: true,
        excludeAcceptAllOption: false,
        types: MEDIA_ACCEPT,
        id: "webcut-media",
      });
    } catch (error) {
      if (isUserAbort(error)) return [];
      throw error;
    }

    const imported: ImportedMediaFile[] = [];
    for (const handle of handles) {
      const handleKey = `media:${crypto.randomUUID()}`;
      const file = await handle.getFile();
      this.handleCache.set(handleKey, handle);
      await idbPut(handleKey, handle);
      imported.push({ handleKey, file, handle });
    }
    return imported;
  }

  /**
   * Register an inline File (e.g. pasted from the clipboard) that has no disk
   * handle. The blob is persisted to IndexedDB so it survives reloads/save.
   */
  async registerBlobFile(file: File): Promise<string> {
    const handleKey = `blob:${crypto.randomUUID()}`;
    this.blobCache.set(handleKey, file);
    await idbPut(handleKey, file);
    return handleKey;
  }

  /** Re-acquire a File for a persisted handle key (e.g. after project load). */
  async resolveMediaFile(handleKey: string): Promise<File> {
    const cachedBlob = this.blobCache.get(handleKey);
    if (cachedBlob) return cachedBlob;

    let handle = this.handleCache.get(handleKey);
    if (!handle) {
      const stored = await idbGet(handleKey);
      if (stored instanceof File) {
        this.blobCache.set(handleKey, stored);
        return stored;
      }
      handle = stored;
      if (!handle) {
        throw new Error(`Media handle not found for key "${handleKey}". The file link may have been cleared.`);
      }
      this.handleCache.set(handleKey, handle);
    }

    const permission = await handle.queryPermission?.({ mode: "read" });
    if (permission !== "granted") {
      const requested = await handle.requestPermission?.({ mode: "read" });
      if (requested !== "granted") {
        throw new Error(`Read permission denied for "${handle.name}".`);
      }
    }
    return handle.getFile();
  }

  /**
   * Stream a media file's bytes in chunks without buffering the whole file in
   * memory — feed this into a demuxer or transfer chunks to a decode worker.
   */
  async *streamMediaChunks(handleKey: string, chunkSize = 4 * 1024 * 1024): AsyncGenerator<Uint8Array, void> {
    const file = await this.resolveMediaFile(handleKey);
    const reader = file.stream().getReader();
    let pending = new Uint8Array(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (pending.length === 0 && value.length >= chunkSize) {
          yield value;
          continue;
        }
        const merged = new Uint8Array(pending.length + value.length);
        merged.set(pending, 0);
        merged.set(value, pending.length);
        pending = merged;
        while (pending.length >= chunkSize) {
          yield pending.slice(0, chunkSize);
          pending = pending.slice(chunkSize);
        }
      }
      if (pending.length > 0) yield pending;
    } finally {
      reader.releaseLock();
    }
  }

  // -- Project persistence ---------------------------------------------------

  /** "Save As": always prompts for a destination, then remembers it. */
  async saveProjectAs(project: Project): Promise<void> {
    this.assertSupported();
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker!({
        suggestedName: `${project.name.replace(/[\\/:*?"<>|]/g, "_")}.webcut`,
        types: PROJECT_ACCEPT,
        id: "webcut-project",
      });
    } catch (error) {
      if (isUserAbort(error)) return;
      throw error;
    }
    this.projectHandle = handle;
    await this.writeProjectToHandle(project, handle);
  }

  /** "Save": silent write to the current file, falling back to Save As. */
  async saveProject(project: Project): Promise<void> {
    if (!this.projectHandle) {
      return this.saveProjectAs(project);
    }
    await this.writeProjectToHandle(project, this.projectHandle);
  }

  /** Open a .webcut file from disk; validates the schema before returning. */
  async openProject(): Promise<Project | null> {
    this.assertSupported();
    let handle: FileSystemFileHandle;
    try {
      const [picked] = await window.showOpenFilePicker!({
        multiple: false,
        types: PROJECT_ACCEPT,
        id: "webcut-project",
      });
      handle = picked;
    } catch (error) {
      if (isUserAbort(error)) return null;
      throw error;
    }

    const file = await handle.getFile();
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    if (!isProjectShape(parsed)) {
      throw new Error(`"${file.name}" is not a valid WebCut project file.`);
    }
    this.projectHandle = handle;
    // Backfill fields added after a project was first saved.
    return { ...parsed, markers: parsed.markers ?? [] };
  }

  private async writeProjectToHandle(project: Project, handle: FileSystemFileHandle): Promise<void> {
    const serialized = JSON.stringify({ ...project, modifiedAt: new Date().toISOString() }, null, 2);
    const writable = await handle.createWritable();
    try {
      await writable.write(serialized);
    } finally {
      await writable.close();
    }
  }
}

const isProjectShape = (value: unknown): value is Project => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.settings === "object" &&
    Array.isArray(candidate.tracks) &&
    Array.isArray(candidate.assets)
  );
};

/** App-wide singleton: handle caches must be shared across the UI. */
export const fileSystemService = new FileSystemService();
