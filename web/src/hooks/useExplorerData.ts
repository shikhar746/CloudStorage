import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import {
  AccessRole,
  ActiveNavTab,
  BreadcrumbItem,
  FileItem,
  Folder,
  ResourceType,
  SearchResponse,
  SharedWithMeResponse,
  StarredResponse,
  TrashResponse,
  User,
} from '../types/storage';

const ROOT_CRUMB: BreadcrumbItem = { id: null, name: 'My Storage' };

const EMPTY_USAGE = {
  usedBytes: 0,
  totalBytes: 15 * 1024 * 1024 * 1024,
  breakdown: { images: 0, documents: 0, media: 0, archives: 0, code: 0, others: 0 },
};

/** Which bucket a file counts towards in the usage breakdown. */
function categoryFor(mimeType: string): keyof typeof EMPTY_USAGE.breakdown {
  if (mimeType.startsWith('image/')) return 'images';
  if (mimeType.startsWith('text/') || mimeType.includes('pdf') || mimeType.includes('document')) {
    return 'documents';
  }
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return 'media';
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('compressed')) {
    return 'archives';
  }
  if (
    mimeType.includes('javascript') ||
    mimeType.includes('json') ||
    mimeType.includes('typescript')
  ) {
    return 'code';
  }
  return 'others';
}

/**
 * The file tree, the lists beside it, and every operation on them.
 *
 * The tab loaders are a lookup keyed by tab rather than an if/else chain.
 * They were a chain in two places — the effect that reacts to a tab change and
 * the refresh a mutation triggers — and the two had already drifted: Starred
 * was in one and missing from the other, so deleting a file from that tab left
 * the row on screen. One table cannot disagree with itself, and adding a tab is
 * now a single entry rather than two edits to remember.
 */
export function useExplorerData(user: User | null) {
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([ROOT_CRUMB]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveNavTab>('files');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);

  // 'owner' until the API says otherwise: root only ever holds your own items
  const [currentFolderRole, setCurrentFolderRole] = useState<AccessRole>('owner');

  const [trashData, setTrashData] = useState<TrashResponse>({ folders: [], files: [] });
  const [sharedWithMe, setSharedWithMe] = useState<SharedWithMeResponse>({
    folders: [],
    files: [],
  });
  const [sharedLoading, setSharedLoading] = useState(false);
  const [starredItems, setStarredItems] = useState<StarredResponse>({ folders: [], files: [] });
  const [starredLoading, setStarredLoading] = useState(false);
  const [trashRetentionDays, setTrashRetentionDays] = useState<number | null>(null);

  const loadFolderContent = useCallback(
    async (folderId: string | null) => {
      if (!user) return;
      setLoading(true);
      setError(null);
      try {
        const res = folderId === null ? await api.getRoot() : await api.getFolder(folderId);
        setFolders(res.children.folders || []);
        setFiles(res.children.files || []);
        // an older server reports no role — treat that as full access
        setCurrentFolderRole(res.role ?? 'owner');
      } catch (err) {
        console.error('Failed loading folder content:', err);
        setError(err instanceof Error ? err.message : 'Failed to load folder');
      } finally {
        setLoading(false);
      }
    },
    [user]
  );

  const fetchTrash = useCallback(async () => {
    if (!user) return;
    try {
      setTrashData(await api.getTrash());
    } catch (err) {
      console.error('Failed to load trash:', err);
    }
  }, [user]);

  const fetchSharedWithMe = useCallback(async () => {
    if (!user) return;
    setSharedLoading(true);
    try {
      setSharedWithMe(await api.getSharedWithMe());
    } catch (err) {
      console.error('Failed to load shared items:', err);
      setError(err instanceof Error ? err.message : 'Failed to load shared items');
    } finally {
      setSharedLoading(false);
    }
  }, [user]);

  const fetchStarred = useCallback(async () => {
    if (!user) return;
    setStarredLoading(true);
    try {
      setStarredItems(await api.getStarred());
    } catch (err) {
      console.error('Failed to load starred items:', err);
      setError(err instanceof Error ? err.message : 'Failed to load starred items');
    } finally {
      setStarredLoading(false);
    }
  }, [user]);

  /**
   * How each tab loads itself. The single source of truth for that question:
   * the mount effect and every post-mutation refresh both read it.
   */
  const loadTab = useMemo<Record<ActiveNavTab, () => Promise<void>>>(
    () => ({
      files: () => loadFolderContent(currentFolderId),
      trash: fetchTrash,
      shared: fetchSharedWithMe,
      starred: fetchStarred,
      // nothing to fetch; the settings pane is local state
      settings: async () => {},
    }),
    [loadFolderContent, currentFolderId, fetchTrash, fetchSharedWithMe, fetchStarred]
  );

  // Held in a ref as well so that `refreshActiveTab` can stay stable: without
  // it every mutation callback would be rebuilt on each folder change, and so
  // would the upload hook that depends on them.
  const loadTabRef = useRef(loadTab);
  loadTabRef.current = loadTab;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const refreshActiveTab = useCallback(async () => {
    await loadTabRef.current[activeTabRef.current]();
  }, []);

  // The server owns the upload thresholds and the retention window; ask it
  // rather than hard-coding either.
  useEffect(() => {
    if (!user) return;
    let mounted = true;
    api.getTrashRetentionDays().then((days) => {
      if (mounted) setTrashRetentionDays(days);
    });
    return () => {
      mounted = false;
    };
  }, [user]);

  // one pass on sign-in so the sidebar badge is right before the tab is opened
  useEffect(() => {
    if (user) fetchSharedWithMe();
  }, [user, fetchSharedWithMe]);

  // Initial load, and whenever the tab or folder changes
  useEffect(() => {
    if (user) void loadTab[activeTab]();
  }, [user, activeTab, loadTab]);

  // Search, debounced
  useEffect(() => {
    if (!user || !searchQuery.trim()) {
      setSearchResults(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        setSearchResults(await api.search(searchQuery));
      } catch (err) {
        console.error('Search error:', err);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [searchQuery, user]);

  const navigateToFolder = useCallback(
    async (folderId: string | null, folderName?: string) => {
      setCurrentFolderId(folderId);

      if (folderId === null) {
        setBreadcrumbs([ROOT_CRUMB]);
        await loadFolderContent(null);
        return;
      }

      const trail = breadcrumbs;
      const existingIndex = trail.findIndex((b) => b.id === folderId);
      const isChildOfCurrent = folders.some((f) => f.id === folderId);

      if (existingIndex !== -1) {
        // walking back up the trail we already have
        setBreadcrumbs(trail.slice(0, existingIndex + 1));
      } else if (isChildOfCurrent) {
        // stepping into something listed right here
        setBreadcrumbs([...trail, { id: folderId, name: folderName || 'Folder' }]);
      } else {
        // a jump from search or the shared list — the trail we hold says nothing
        // about where this folder sits, so ask the server for the real chain
        setBreadcrumbs([ROOT_CRUMB, { id: folderId, name: folderName || 'Folder' }]);
        try {
          const path = await api.getFolderPath(folderId);
          if (path.length > 0) setBreadcrumbs([ROOT_CRUMB, ...path]);
        } catch (err) {
          // a shared folder whose ancestors you cannot see still opens fine
          console.warn('Could not resolve folder path', err);
        }
      }

      await loadFolderContent(folderId);
    },
    [breadcrumbs, folders, loadFolderContent]
  );

  const navigateUp = useCallback(async () => {
    if (breadcrumbs.length <= 1) return;
    const parent = breadcrumbs[breadcrumbs.length - 2];
    await navigateToFolder(parent.id, parent.name);
  }, [breadcrumbs, navigateToFolder]);

  /**
   * Runs a mutation, then reloads whatever the user is looking at.
   *
   * Every operation below is the same three steps, so they say which call to
   * make and which lists to reload and nothing else. `alsoTrash` exists because
   * anything that moves an item in or out of the trash changes two views at
   * once, and those two reloads are independent of each other.
   */
  const mutate = useCallback(
    async <T>(
      call: () => Promise<T>,
      options: { refresh?: boolean; alsoTrash?: boolean } = {}
    ): Promise<T> => {
      if (!user) throw new Error('Not authenticated');
      const result = await call();

      const { refresh = true, alsoTrash = false } = options;
      await Promise.all([
        refresh ? refreshActiveTab() : Promise.resolve(),
        alsoTrash ? fetchTrash() : Promise.resolve(),
      ]);
      return result;
    },
    [user, refreshActiveTab, fetchTrash]
  );

  const operations = useMemo(
    () => ({
      createFolder: (name: string) =>
        mutate(() => api.createFolder(name, currentFolderId)),
      renameFolder: (folderId: string, newName: string) =>
        mutate(() => api.updateFolder(folderId, { name: newName })),
      moveFolder: (folderId: string, targetParentId: string | null) =>
        mutate(() => api.updateFolder(folderId, { parentId: targetParentId })).then(() => undefined),
      deleteFolder: (folderId: string) =>
        mutate(() => api.deleteFolder(folderId), { alsoTrash: true }),
      restoreFolder: (folderId: string) =>
        mutate(() => api.restoreFolder(folderId), { alsoTrash: true }),
      permanentDeleteFolder: (folderId: string) =>
        mutate(() => api.permanentDeleteFolder(folderId), { refresh: false, alsoTrash: true }),

      renameFile: (fileId: string, newName: string) =>
        mutate(() => api.updateFile(fileId, { name: newName })),
      moveFile: (fileId: string, targetFolderId: string | null) =>
        mutate(() => api.updateFile(fileId, { folderId: targetFolderId })).then(() => undefined),
      deleteFile: (fileId: string) => mutate(() => api.deleteFile(fileId), { alsoTrash: true }),
      restoreFile: (fileId: string) => mutate(() => api.restoreFile(fileId), { alsoTrash: true }),
      permanentDeleteFile: (fileId: string) =>
        mutate(() => api.permanentDeleteFile(fileId), { refresh: false, alsoTrash: true }),

      emptyTrash: () => mutate(() => api.emptyTrash(), { refresh: false, alsoTrash: true }),
    }),
    [mutate, currentFolderId]
  );

  /**
   * Star or unstar. Applied locally first — a star is a one-click affordance
   * and should not wait on a round trip — then rolled back if the call fails.
   */
  const toggleStar = useCallback(
    async (resourceType: ResourceType, id: string, starred: boolean) => {
      if (!user) throw new Error('Not authenticated');

      const applyLocal = (next: boolean) => {
        const mark = <T extends { id: string }>(rows: T[], type: ResourceType) =>
          rows.map((row) => (type === resourceType && row.id === id ? { ...row, starred: next } : row));

        if (resourceType === 'folder') {
          setFolders((prev) => mark(prev, 'folder'));
        } else {
          setFiles((prev) => mark(prev, 'file'));
        }
        setStarredItems((prev) => ({
          folders: mark(prev.folders, 'folder'),
          files: mark(prev.files, 'file'),
        }));
      };

      // unstarring from the Starred view should remove the row, not leave a
      // hollow star sitting in a list it no longer belongs to
      const dropFromStarred = () =>
        setStarredItems((prev) => ({
          folders: prev.folders.filter((f) => !(resourceType === 'folder' && f.id === id)),
          files: prev.files.filter((f) => !(resourceType === 'file' && f.id === id)),
        }));

      applyLocal(starred);
      if (!starred) dropFromStarred();

      try {
        await api.setStarred(resourceType, id, starred);
        if (starred && activeTab === 'starred') await fetchStarred();
      } catch (err) {
        applyLocal(!starred);
        if (!starred) await fetchStarred();
        setError(err instanceof Error ? err.message : 'Could not update the star');
      }
    },
    [user, activeTab, fetchStarred]
  );

  const downloadFile = useCallback(
    async (file: FileItem) => {
      try {
        let url = file.signedUrl || file.previewUrl;
        if (!url && user) {
          const res = await api.getFile(file.id);
          url = res.signedUrl || res.file?.signedUrl || res.file?.previewUrl;
        }
        if (!url) throw new Error('No download URL available for this file');

        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (err: any) {
        console.error('Failed to download file', err);
        setError(err?.message || 'Could not download file');
      }
    },
    [user]
  );

  // The API enforces no total quota, only a per-file ceiling, so usage is
  // summed from the loaded files rather than reported by the server.
  const storageUsage = useMemo(() => {
    if (!user) return EMPTY_USAGE;

    const breakdown = { ...EMPTY_USAGE.breakdown };
    let usedBytes = 0;
    for (const file of files) {
      const bytes = file.size_bytes || 0;
      usedBytes += bytes;
      breakdown[categoryFor(file.mime_type)] += bytes;
    }
    // 0 denotes no artificial total cap
    return { usedBytes, totalBytes: 0, breakdown };
  }, [user, files]);

  // viewers get a read-only explorer: every mutating call would 404 or 403
  const canEdit = currentFolderRole === 'owner' || currentFolderRole === 'editor';
  const canShare = currentFolderRole === 'owner';

  return useMemo(
    () => ({
      currentFolderId,
      breadcrumbs,
      folders,
      files,
      setFiles,
      loading,
      setLoading,
      error,
      setError,
      activeTab,
      setActiveTab,
      searchQuery,
      setSearchQuery,
      searchResults,
      currentFolderRole,
      canEdit,
      canShare,
      trashData,
      fetchTrash,
      sharedWithMe,
      fetchSharedWithMe,
      sharedLoading,
      starredItems,
      starredLoading,
      fetchStarred,
      toggleStar,
      trashRetentionDays,
      storageUsage,
      navigateToFolder,
      navigateUp,
      refreshCurrentFolder: refreshActiveTab,
      downloadFile,
      ...operations,
    }),
    [
      currentFolderId,
      breadcrumbs,
      folders,
      files,
      loading,
      error,
      activeTab,
      searchQuery,
      searchResults,
      currentFolderRole,
      canEdit,
      canShare,
      trashData,
      fetchTrash,
      sharedWithMe,
      fetchSharedWithMe,
      sharedLoading,
      starredItems,
      starredLoading,
      fetchStarred,
      toggleStar,
      trashRetentionDays,
      storageUsage,
      navigateToFolder,
      navigateUp,
      refreshActiveTab,
      downloadFile,
      operations,
    ]
  );
}

export type ExplorerData = ReturnType<typeof useExplorerData>;
