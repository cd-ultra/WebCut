/**
 * WebCut — local project library.
 *
 * Persists whole projects (as structured-cloneable JSON) in IndexedDB so the
 * user can manage several without re-picking a `.webcut` file each time. This
 * is separate from FileSystemService, which links external media handles.
 */

import type { Project, ProjectId } from "../types/timeline";

const DB_NAME = "webcut-projects";
const DB_VERSION = 1;
const STORE = "projects";

export interface ProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  readonly updatedAt: string;
  readonly project: Project;
}

export interface ProjectSummary {
  readonly id: ProjectId;
  readonly name: string;
  readonly updatedAt: string;
}

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });

const tx = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
  } finally {
    db.close();
  }
};

class ProjectStore {
  async list(): Promise<ProjectSummary[]> {
    const records = await tx<ProjectRecord[]>("readonly", (store) => store.getAll() as IDBRequest<ProjectRecord[]>);
    return records
      .map((r) => ({ id: r.id, name: r.name, updatedAt: r.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(project: Project): Promise<void> {
    const record: ProjectRecord = {
      id: project.id,
      name: project.name,
      updatedAt: new Date().toISOString(),
      project,
    };
    await tx("readwrite", (store) => store.put(record));
  }

  async load(id: ProjectId): Promise<Project | null> {
    const record = await tx<ProjectRecord | undefined>("readonly", (store) => store.get(id) as IDBRequest<ProjectRecord | undefined>);
    return record?.project ?? null;
  }

  async rename(id: ProjectId, name: string): Promise<void> {
    const record = await tx<ProjectRecord | undefined>("readonly", (store) => store.get(id) as IDBRequest<ProjectRecord | undefined>);
    if (!record) return;
    await tx("readwrite", (store) => store.put({ ...record, name, project: { ...record.project, name } }));
  }

  async remove(id: ProjectId): Promise<void> {
    await tx("readwrite", (store) => store.delete(id));
  }
}

export const projectStore = new ProjectStore();
