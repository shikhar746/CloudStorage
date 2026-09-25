import { useCallback, useMemo, useState } from 'react';
import { ApiError, api, FALLBACK_UPLOAD_LIMITS } from '../services/api';
import { relativeFolderPath } from '../utils/dropEntries';
import {
  FileItem,
  UploadEntry,
  UploadLimits,
  UploadTask,
  User,
} from '../types/storage';

/** Rounded byte size for user-facing limit messages. */
function formatLimit(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${Number(gb.toFixed(gb >= 10 ? 0 : 1))} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function newTaskId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `up_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export interface UploadDeps {
  /** Where a loose file lands. */
  currentFolderId: string | null;
  setFiles: (files: FileItem[]) => void;
  setError: (message: string | null) => void;
  setLoading: (loading: boolean) => void;
  /** Reloads the active view once the batch is done. */
  refresh: () => Promise<void>;
}

/**
 * The upload queue and the machinery behind it.
 *
 * Pulled out of the storage provider because it is the one part with real
 * sequencing of its own — normalising two different input shapes, materialising
 * a dropped folder tree, picking a transport per file size, tracking progress
 * per task and aggregating partial failures. None of that needs to be read to
 * understand how a folder listing loads, and all of it is easier to follow in
 * one place.
 */
export function useUploads(user: User | null, deps: UploadDeps) {
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [uploadLimits, setUploadLimits] = useState<UploadLimits>(FALLBACK_UPLOAD_LIMITS);

  const clearFinishedUploads = useCallback(() => {
    setUploads((prev) => prev.filter((u) => u.status === 'pending' || u.status === 'uploading'));
  }, []);

  const { currentFolderId, setFiles, setError, setLoading, refresh } = deps;

  const uploadFiles = useCallback(
    async (input: FileList | File[] | UploadEntry[], folders: string[][] = []) => {
      if (!user) throw new Error('Not authenticated');

      // A drop carries folder paths; the file inputs hand over a bare list.
      // Both land here, so normalise before anything else looks at them.
      const list: UploadEntry[] = Array.from(input as ArrayLike<File | UploadEntry>).map((item) =>
        item instanceof File ? { file: item, path: relativeFolderPath(item) } : item
      );
      if (list.length === 0 && folders.length === 0) return;

      // the thresholds come from the server, so raising MAX_FILE_SIZE_BYTES
      // there is enough — the browser does not need a matching constant
      const limits = await api.getLimits();
      setUploadLimits(limits);

      const tasks: UploadTask[] = list.map(({ file, path }) => ({
        id: newTaskId(),
        // a nested file is only identifiable by its path in the progress panel
        name: path.length > 0 ? [...path, file.name].join('/') : file.name,
        size: file.size,
        loaded: 0,
        status: 'pending',
        method: file.size > limits.maxFileSizeBytes ? 'direct' : 'multipart',
      }));

      setUploads((prev) => [...prev, ...tasks]);
      setError(null);
      setLoading(true);

      const patch = (id: string, changes: Partial<UploadTask>) => {
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...changes } : u)));
      };

      const failures: string[] = [];

      // A dropped folder has to exist server-side before anything can go into
      // it. Cached by path, so a hundred files in one folder create it once.
      const folderIds = new Map<string, string | null>([['', currentFolderId]]);

      const findChildFolder = async (parentId: string | null, name: string) => {
        const res = parentId ? await api.getFolder(parentId) : await api.getRoot();
        return res.children.folders.find((f) => f.name === name)?.id ?? null;
      };

      const ensureFolder = async (path: string[]): Promise<string | null> => {
        const key = path.join('/');
        const cached = folderIds.get(key);
        if (cached !== undefined) return cached;

        const parentId = await ensureFolder(path.slice(0, -1));
        const name = path[path.length - 1];
        let id: string;
        try {
          id = (await api.createFolder(name, parentId)).id;
        } catch (err) {
          // Only a name clash is recoverable, and the server says so by code.
          // Anything else — a 500, a dropped connection — has to surface, not
          // turn into a speculative lookup that hides the real failure.
          if (!(err instanceof ApiError && err.code === 'FOLDER_EXISTS')) throw err;

          const existing = await findChildFolder(parentId, name);
          if (!existing) throw err;
          id = existing;
        }
        folderIds.set(key, id);
        return id;
      };

      try {
        // up front, so a dropped folder with nothing in it still survives
        for (const dir of folders) {
          try {
            await ensureFolder(dir);
          } catch (err: any) {
            failures.push(`folder "${dir.join('/')}": ${err?.message || 'could not be created'}`);
          }
        }

        for (let i = 0; i < list.length; i++) {
          const { file, path } = list[i];
          const task = tasks[i];

          if (file.size > limits.maxDirectUploadBytes) {
            const message = `exceeds the ${formatLimit(limits.maxDirectUploadBytes)} maximum`;
            patch(task.id, { status: 'error', error: message });
            failures.push(`"${file.name}" ${message}`);
            continue;
          }

          let targetFolderId: string | null;
          try {
            targetFolderId = await ensureFolder(path);
          } catch (err: any) {
            const message = err?.message || 'its folder could not be created';
            patch(task.id, { status: 'error', error: message });
            failures.push(`"${task.name}": ${message}`);
            continue;
          }

          patch(task.id, { status: 'uploading' });
          const onProgress = (loaded: number) => patch(task.id, { loaded });

          try {
            if (task.method === 'direct') {
              // too big for the API to buffer — straight to storage, then register
              await api.uploadFileDirect(file, targetFolderId, onProgress);
            } else {
              await api.uploadFile(file, targetFolderId, onProgress);
            }
            patch(task.id, { status: 'done', loaded: file.size });
          } catch (err: any) {
            const message = err?.message || 'Upload failed';
            patch(task.id, { status: 'error', error: message });
            failures.push(`"${file.name}": ${message}`);
          }
        }

        // a plain file drop only changes the file list, but anything that
        // created a folder changed the tree and needs the full refresh
        if (folderIds.size > 1) {
          await refresh();
        } else {
          try {
            setFiles(await api.listFiles(currentFolderId));
          } catch {
            await refresh();
          }
        }

        if (failures.length > 0) {
          setError(`Upload issues: ${failures.join('; ')}`);
        }
      } finally {
        setLoading(false);
      }
    },
    [user, currentFolderId, setFiles, setError, setLoading, refresh]
  );

  return useMemo(
    () => ({ uploads, uploadLimits, setUploadLimits, clearFinishedUploads, uploadFiles }),
    [uploads, uploadLimits, clearFinishedUploads, uploadFiles]
  );
}
