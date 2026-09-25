import { useCallback, useMemo, useState } from 'react';
import {
  FileItem,
  FileCategory,
  Folder,
  SortConfig,
  ViewMode,
} from '../types/storage';

export interface SelectedItem {
  type: 'file' | 'folder';
  data: FileItem | Folder;
}

export interface ShareTarget {
  type: 'file' | 'folder';
  item: FileItem | Folder;
}

export interface RenameTarget {
  type: 'file' | 'folder';
  id: string;
  currentName: string;
}

export interface MoveTarget {
  type: 'file' | 'folder';
  id: string;
  name: string;
}

/**
 * Which dialog is open, what is selected, and how the list is displayed.
 *
 * None of this touches the server or the file tree — it is the shell around
 * them. Keeping it in its own hook is what lets the data side be read without
 * wading through sidebar and modal state, which is most of what the provider
 * used to be made of.
 */
export function useUiChrome() {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [sortConfig, setSortConfig] = useState<SortConfig>({ by: 'name', direction: 'asc' });
  const [selectedCategory, setSelectedCategory] = useState<FileCategory>('all');
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null);

  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);

  // Open by default on desktop (>=1024px), closed on mobile, where it overlays
  // the content rather than sitting beside it.
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    if (typeof window !== 'undefined') return window.innerWidth >= 1024;
    return true;
  });

  const toggleSidebar = useCallback(() => setIsSidebarOpen((open) => !open), []);
  const closeSidebar = useCallback(() => setIsSidebarOpen(false), []);

  return useMemo(
    () => ({
      viewMode,
      setViewMode,
      sortConfig,
      setSortConfig,
      selectedCategory,
      setSelectedCategory,
      selectedItem,
      setSelectedItem,
      previewFile,
      setPreviewFile,
      shareTarget,
      setShareTarget,
      renameTarget,
      setRenameTarget,
      moveTarget,
      setMoveTarget,
      isNewFolderOpen,
      setIsNewFolderOpen,
      isSidebarOpen,
      setIsSidebarOpen,
      toggleSidebar,
      closeSidebar,
    }),
    [
      viewMode,
      sortConfig,
      selectedCategory,
      selectedItem,
      previewFile,
      shareTarget,
      renameTarget,
      moveTarget,
      isNewFolderOpen,
      isSidebarOpen,
      toggleSidebar,
      closeSidebar,
    ]
  );
}

export type UiChrome = ReturnType<typeof useUiChrome>;
