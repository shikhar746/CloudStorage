import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { useExplorerData, type ExplorerData } from '../hooks/useExplorerData';
import { useUiChrome, type UiChrome } from '../hooks/useUiChrome';
import { useUploads } from '../hooks/useUploads';
import { api } from '../services/api';

/**
 * The app's single storage surface, assembled from three focused hooks:
 *
 *  - `useExplorerData` — the tree, the lists beside it, and operations on them
 *  - `useUploads`      — the upload queue and its transports
 *  - `useUiChrome`     — which dialog is open, and how the list is displayed
 *
 * They are separate because they change for unrelated reasons and were, between
 * them, a single 770-line provider that had to be read in full to follow any
 * one of them. Consumers still see one `useStorage()`, so the split is an
 * implementation detail rather than a migration.
 */
export type StorageContextType = ExplorerData &
  UiChrome &
  ReturnType<typeof useUploads>;

const StorageContext = createContext<StorageContextType | undefined>(undefined);

export const StorageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();

  const explorer = useExplorerData(user);
  const ui = useUiChrome();
  const uploads = useUploads(user, {
    currentFolderId: explorer.currentFolderId,
    setFiles: explorer.setFiles,
    setError: explorer.setError,
    setLoading: explorer.setLoading,
    refresh: explorer.refreshCurrentFolder,
  });

  // The server owns the upload thresholds, so ask once per session rather than
  // keeping a matching constant in the browser.
  const { setUploadLimits } = uploads;
  useEffect(() => {
    if (!user) return;
    let mounted = true;
    api.getLimits().then((limits) => {
      if (mounted) setUploadLimits(limits);
    });
    return () => {
      mounted = false;
    };
  }, [user, setUploadLimits]);

  // Each hook memoizes its own slice, so this only changes when one of them
  // actually does — rather than allocating a fresh value on every render.
  const value = useMemo<StorageContextType>(
    () => ({ ...explorer, ...ui, ...uploads }),
    [explorer, ui, uploads]
  );

  return <StorageContext.Provider value={value}>{children}</StorageContext.Provider>;
};

export const useStorage = () => {
  const context = useContext(StorageContext);
  if (!context) {
    throw new Error('useStorage must be used within a StorageProvider');
  }
  return context;
};
