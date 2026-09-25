import React from 'react';
import { Users, ExternalLink, Folder as FolderIcon, RotateCw, Inbox } from 'lucide-react';
import { useStorage } from '../../context/StorageContext';
import { FileIcon } from '../common/FileIcon';
import { ItemTable, type ItemColumn } from './ItemTable';
import { ViewBanner } from './ViewBanner';
import { formatBytes, formatDate } from '../../utils/formatters';
import { mergeItemRows, itemRowKey, type ItemRow } from '../../utils/itemRows';
import { SharedFile, SharedFolder } from '../../types/storage';

type SharedRow = ItemRow<SharedFolder, SharedFile>;

export const SharedView: React.FC = () => {
  const {
    sharedWithMe,
    sharedLoading,
    fetchSharedWithMe,
    navigateToFolder,
    setPreviewFile,
    setActiveTab,
  } = useStorage();

  const rows = mergeItemRows(sharedWithMe.folders, sharedWithMe.files);

  const openRow = (row: SharedRow) => {
    if (row.itemType === 'folder') {
      // the explorer resolves the real ancestor chain for a folder reached this way
      setActiveTab('files');
      navigateToFolder(row.id, row.name);
    } else {
      setPreviewFile(row);
    }
  };

  const columns: ItemColumn<SharedRow>[] = [
    {
      header: 'Item',
      render: (row) => (
        <div className="flex items-center gap-3 min-w-0">
          {row.itemType === 'folder' ? (
            <FolderIcon className="w-5 h-5 text-amber-500 fill-amber-500/20 shrink-0" />
          ) : (
            <FileIcon name={row.name} mimeType={row.mime_type} size="sm" className="shrink-0" />
          )}
          <div className="min-w-0">
            <span className="font-semibold text-gray-200 truncate block">{row.name}</span>
            {row.itemType === 'file' && (
              <span className="text-[11px] text-gray-500">{formatBytes(row.size_bytes)}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      header: 'Shared By',
      cellClassName: 'text-xs text-gray-400',
      render: (row) => row.shared_by?.name || row.shared_by?.email || 'Unknown',
    },
    {
      header: 'Your Role',
      cellClassName: 'text-xs',
      render: (row) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full font-medium ${
            row.role === 'editor'
              ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/40'
              : 'bg-indigo-950/40 text-indigo-400 border border-indigo-800/40'
          }`}
        >
          {row.role === 'editor' ? 'Can Edit' : 'Can View'}
        </span>
      ),
    },
    {
      header: 'Shared',
      cellClassName: 'text-xs text-gray-500',
      render: (row) => formatDate(row.shared_at || row.created_at),
    },
    {
      header: 'Access',
      align: 'right',
      render: () => (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-400 hover:text-indigo-300">
          <span>Open</span>
          <ExternalLink className="w-3.5 h-3.5" />
        </span>
      ),
    },
  ];

  return (
    <div id="shared-view-container" className="flex-1 overflow-y-auto py-4 space-y-6">
      <ViewBanner
        tone="indigo"
        icon={Users}
        title="Shared With You"
        subtitle="Files and directories other people granted your account access to."
        actions={
          <button
            id="shared-refresh-btn"
            onClick={fetchSharedWithMe}
            disabled={sharedLoading}
            className="p-1.5 rounded-lg hover:bg-[#1a1a1a] text-gray-400 hover:text-white transition-colors disabled:opacity-50"
            title="Refresh shared items"
          >
            <RotateCw
              className={`w-4 h-4 ${sharedLoading ? 'animate-spin text-indigo-400' : ''}`}
            />
          </button>
        }
      />

      {sharedLoading && rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm font-medium">Loading shared items...</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-2xl bg-[#161616] border border-[#1f1f1f] flex items-center justify-center text-gray-500 mb-4">
            <Inbox className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-white">Nothing shared with you yet</h3>
          <p className="text-sm text-gray-400 max-w-sm mt-1 mb-6">
            When someone grants your account viewer or editor access to a file or folder, it
            shows up here.
          </p>
          <button
            onClick={() => setActiveTab('files')}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-xs font-semibold text-white transition-colors"
          >
            Go to My Files
          </button>
        </div>
      ) : (
        <ItemTable
          columns={columns}
          rows={rows}
          rowKey={itemRowKey}
          onRowClick={openRow}
          minWidthPx={640}
        />
      )}
    </div>
  );
};
