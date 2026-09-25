import React from 'react';
import { Star, Folder as FolderIcon, RotateCw } from 'lucide-react';
import { useStorage } from '../../context/StorageContext';
import { FileIcon } from '../common/FileIcon';
import { StarButton } from '../common/StarButton';
import { ItemTable, type ItemColumn } from './ItemTable';
import { ViewBanner } from './ViewBanner';
import { formatBytes, formatDate } from '../../utils/formatters';
import { mergeItemRows, itemRowKey, type ItemRow } from '../../utils/itemRows';
import { FileItem, Folder } from '../../types/storage';

type StarredRow = ItemRow<Folder, FileItem>;

export const StarredView: React.FC = () => {
  const {
    starredItems,
    starredLoading,
    fetchStarred,
    navigateToFolder,
    setPreviewFile,
    setActiveTab,
  } = useStorage();

  const rows = mergeItemRows(starredItems.folders, starredItems.files);

  const openRow = (row: StarredRow) => {
    if (row.itemType === 'folder') {
      // the explorer resolves the real ancestor chain for a folder opened here
      setActiveTab('files');
      navigateToFolder(row.id, row.name);
    } else {
      setPreviewFile(row);
    }
  };

  const columns: ItemColumn<StarredRow>[] = [
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
      header: 'Type',
      cellClassName: 'text-xs text-gray-400',
      render: (row) => (row.itemType === 'folder' ? 'Folder' : row.mime_type || 'File'),
    },
    {
      header: 'Added',
      cellClassName: 'text-xs text-gray-500 whitespace-nowrap',
      render: (row) => formatDate(row.created_at),
    },
    {
      header: 'Star',
      align: 'right',
      render: (row) => (
        <span className="inline-flex items-center align-middle">
          <StarButton resourceType={row.itemType} id={row.id} starred alwaysVisible />
        </span>
      ),
    },
  ];

  return (
    <div id="starred-view-container" className="flex-1 overflow-y-auto py-4 space-y-6">
      <ViewBanner
        tone="amber"
        icon={Star}
        iconClassName="fill-amber-400/30"
        title="Starred"
        subtitle="Items you marked for quick access. Stars are private to your account."
        actions={
          <button
            id="starred-refresh-btn"
            onClick={fetchStarred}
            disabled={starredLoading}
            className="p-1.5 rounded-lg hover:bg-[#1a1a1a] text-gray-400 hover:text-white transition-colors disabled:opacity-50"
            title="Refresh starred items"
          >
            <RotateCw className={`w-4 h-4 ${starredLoading ? 'animate-spin text-amber-400' : ''}`} />
          </button>
        }
      />

      {starredLoading && rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm font-medium">Loading starred items...</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-2xl bg-[#161616] border border-[#1f1f1f] flex items-center justify-center text-gray-500 mb-4">
            <Star className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-white">Nothing starred yet</h3>
          <p className="text-sm text-gray-400 max-w-sm mt-1 mb-6">
            Select the star on any file or folder and it appears here, wherever it actually
            lives.
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
          minWidthPx={560}
        />
      )}
    </div>
  );
};
