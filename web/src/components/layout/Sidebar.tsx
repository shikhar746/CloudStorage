import React, { useRef, useState } from 'react';
import {
  HardDrive,
  Users,
  Star,
  Trash2,
  Plus,
  FolderPlus,
  UploadCloud,
  Database,
  X,
  Cloud,
} from 'lucide-react';
import { useStorage } from '../../context/StorageContext';
import { SidebarNavItem } from './SidebarNavItem';
import { ActiveNavTab } from '../../types/storage';
import { formatBytes } from '../../utils/formatters';

/** The sidebar's destinations, in order. */
const NAV_ITEMS: Array<{ tab: ActiveNavTab; label: string; icon: typeof HardDrive }> = [
  { tab: 'files', label: 'My Files', icon: HardDrive },
  { tab: 'shared', label: 'Shared with me', icon: Users },
  { tab: 'starred', label: 'Starred', icon: Star },
  { tab: 'trash', label: 'Trash Bin', icon: Trash2 },
];

export const Sidebar: React.FC = () => {
  const {
    activeTab,
    setActiveTab,
    navigateToFolder,
    trashData,
    storageUsage,
    setIsNewFolderOpen,
    uploadFiles,
    isSidebarOpen,
    closeSidebar,
    canEdit,
    uploadLimits,
    sharedWithMe,
  } = useStorage();

  const [isNewMenuOpen, setIsNewMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleNav = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      closeSidebar();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      uploadFiles(e.target.files);
      e.target.value = ''; // Reset input
    }
  };

  const percentUsed =
    storageUsage.totalBytes > 0
      ? Math.min(100, Math.max(1, (storageUsage.usedBytes / storageUsage.totalBytes) * 100))
      : 0;

  const trashCount = trashData.folders.length + trashData.files.length;
  const sharedCount = sharedWithMe.folders.length + sharedWithMe.files.length;

  return (
    <>
      {/* Mobile Drawer Backdrop Overlay */}
      {isSidebarOpen && (
        <div
          id="mobile-sidebar-backdrop"
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-xs lg:hidden transition-opacity duration-300"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      {/* Retractable Sidebar */}
      <aside
        id="app-sidebar"
        aria-label="Navigation Sidebar"
        className={`fixed lg:static inset-y-0 left-0 z-50 lg:z-auto bg-[#111111] border-r border-[#1f1f1f] flex flex-col justify-between shrink-0 transition-all duration-300 ease-in-out ${
          isSidebarOpen
            ? 'w-64 translate-x-0 opacity-100 shadow-2xl lg:shadow-none'
            : '-translate-x-full lg:translate-x-0 lg:w-0 lg:border-r-0 lg:opacity-0 opacity-0 pointer-events-none'
        } overflow-hidden`}
      >
        <div className="w-64 p-4 flex flex-col justify-between h-full shrink-0 overflow-y-auto">
          <div className="space-y-5">
            {/* Mobile drawer header with close button */}
            <div className="flex lg:hidden items-center justify-between pb-3 border-b border-[#1f1f1f]">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center text-white">
                  <Cloud className="w-4 h-4" />
                </div>
                <span className="font-bold text-sm text-white">Navigation</span>
              </div>
              <button
                id="mobile-sidebar-close-btn"
                type="button"
                onClick={closeSidebar}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-[#1a1a1a] transition-colors"
                aria-label="Close navigation sidebar"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* "+ New" Action Button — hidden while viewing a shared folder
                read-only, where both actions would be refused server-side */}
            <div className={`relative ${canEdit ? '' : 'hidden'}`}>
              <button
                id="sidebar-new-btn"
                type="button"
                onClick={() => setIsNewMenuOpen(!isNewMenuOpen)}
                className="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 rounded-xl bg-indigo-600 text-white font-semibold text-sm shadow-md shadow-indigo-600/20 hover:bg-indigo-700 transition-all cursor-pointer"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span>New Item</span>
              </button>

              {isNewMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setIsNewMenuOpen(false)}
                  />
                  <div
                    id="sidebar-new-dropdown"
                    className="absolute left-0 top-full mt-2 w-full rounded-xl bg-[#111111] border border-[#1f1f1f] shadow-2xl py-1.5 z-50 text-sm"
                  >
                    <button
                      id="new-folder-menu-item"
                      onClick={() => {
                        setIsNewMenuOpen(false);
                        setIsNewFolderOpen(true);
                        handleNav();
                      }}
                      className="w-full px-3.5 py-2 text-left flex items-center gap-2.5 text-gray-300 hover:bg-[#1a1a1a] hover:text-white transition-colors"
                    >
                      <FolderPlus className="w-4 h-4 text-amber-500" />
                      <span>New Folder</span>
                    </button>
                    <button
                      id="upload-file-menu-item"
                      onClick={() => {
                        setIsNewMenuOpen(false);
                        fileInputRef.current?.click();
                        handleNav();
                      }}
                      className="w-full px-3.5 py-2 text-left flex items-center gap-2.5 text-gray-300 hover:bg-[#1a1a1a] hover:text-white transition-colors"
                    >
                      <UploadCloud className="w-4 h-4 text-indigo-400" />
                      <span>Upload Files</span>
                    </button>
                  </div>
                </>
              )}

              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInputChange}
              />
            </div>

            {/* Primary Navigation Links */}
            <nav className="space-y-1">
              {NAV_ITEMS.map(({ tab, label, icon }) => (
                <SidebarNavItem
                  key={tab}
                  tab={tab}
                  label={label}
                  icon={icon}
                  isActive={activeTab === tab}
                  count={tab === 'shared' ? sharedCount : tab === 'trash' ? trashCount : 0}
                  onSelect={() => {
                    setActiveTab(tab);
                    // My Files always reopens at the root rather than wherever
                    // the user last wandered to
                    if (tab === 'files') navigateToFolder(null);
                    handleNav();
                  }}
                />
              ))}
            </nav>
          </div>

          {/* Storage Quota Card */}
          <div className="rounded-xl border border-[#1f1f1f] bg-[#141414] p-3.5 space-y-3 mt-4">
            <div className="flex items-center justify-between text-xs text-gray-400 font-medium">
              <span className="flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-gray-500" />
                <span>Storage Used</span>
              </span>
              <span className="font-semibold text-white">
                {formatBytes(storageUsage.usedBytes)}
              </span>
            </div>

            {/* Progress bar */}
            {storageUsage.totalBytes > 0 ? (
              <>
                <div className="h-1.5 w-full rounded-full bg-[#1f1f1f] overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                    style={{ width: `${percentUsed}%` }}
                  />
                </div>

                <p className="text-[11px] text-gray-500">
                  {formatBytes(storageUsage.usedBytes)} used of {formatBytes(storageUsage.totalBytes)} total
                </p>
              </>
            ) : (
              <p className="text-[11px] text-gray-500">
                Up to {formatBytes(uploadLimits.maxFileSizeBytes)} per file direct through the
                API, {formatBytes(uploadLimits.maxDirectUploadBytes)} via resumable upload · No
                total quota limit
              </p>
            )}

            {/* Storage breakdown pills */}
            <div className="pt-2 border-t border-[#1f1f1f] flex flex-wrap gap-1.5 text-[10px]">
              <span className="px-1.5 py-0.5 rounded bg-indigo-950/60 border border-indigo-800/40 text-indigo-300 font-medium">
                Images: {formatBytes(storageUsage.breakdown.images)}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-blue-950/60 border border-blue-800/40 text-blue-300 font-medium">
                Docs: {formatBytes(storageUsage.breakdown.documents)}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-cyan-950/60 border border-cyan-800/40 text-cyan-300 font-medium">
                Code: {formatBytes(storageUsage.breakdown.code)}
              </span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
};
