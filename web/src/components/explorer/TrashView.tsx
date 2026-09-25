import React, { useState } from 'react';
import { Trash2, RotateCcw, Folder as FolderIcon, XCircle, Inbox } from 'lucide-react';
import { useStorage } from '../../context/StorageContext';
import { FileIcon } from '../common/FileIcon';
import { ItemTable, type ItemColumn } from './ItemTable';
import { ViewBanner } from './ViewBanner';
import { formatBytes, formatDate } from '../../utils/formatters';
import { mergeItemRows, itemRowKey, type ItemRow } from '../../utils/itemRows';
import { FileItem, Folder } from '../../types/storage';

type TrashRow = ItemRow<Folder, FileItem>;

export const TrashView: React.FC = () => {
  const {
    trashData,
    restoreFolder,
    restoreFile,
    permanentDeleteFolder,
    permanentDeleteFile,
    emptyTrash,
    trashRetentionDays,
  } = useStorage();

  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const rows = mergeItemRows(trashData.folders, trashData.files);

  const handleEmptyTrash = async () => {
    setProcessingId('all');
    try {
      await emptyTrash();
      setConfirmEmpty(false);
    } finally {
      setProcessingId(null);
    }
  };

  // Folders and files take the same two actions, differing only in which
  // endpoint they call, so the row kind picks the call rather than duplicating
  // the surrounding markup.
  const handleRestore = async (row: TrashRow) => {
    setProcessingId(row.id);
    try {
      await (row.itemType === 'folder' ? restoreFolder(row.id) : restoreFile(row.id));
    } finally {
      setProcessingId(null);
    }
  };

  const handlePermanentDelete = async (row: TrashRow) => {
    if (!confirm('Permanently delete this item? This action cannot be undone.')) return;
    setProcessingId(row.id);
    try {
      await (row.itemType === 'folder'
        ? permanentDeleteFolder(row.id)
        : permanentDeleteFile(row.id));
    } finally {
      setProcessingId(null);
    }
  };

  const columns: ItemColumn<TrashRow>[] = [
    {
      header: 'Item Name',
      render: (row) => (
        <div className="flex items-center gap-3 min-w-0">
          {row.itemType === 'folder' ? (
            <FolderIcon className="w-5 h-5 text-amber-500 fill-amber-500/20 shrink-0" />
          ) : (
            <FileIcon name={row.name} mimeType={row.mime_type} size="sm" className="shrink-0" />
          )}
          <span className="font-semibold text-gray-200 truncate">{row.name}</span>
        </div>
      ),
    },
    {
      header: 'Type',
      cellClassName: 'text-xs text-gray-500',
      render: (row) => (row.itemType === 'folder' ? 'Folder' : row.mime_type || 'File'),
    },
    {
      header: 'Size',
      cellClassName: 'text-xs text-gray-500',
      render: (row) => (row.itemType === 'folder' ? '—' : formatBytes(row.size_bytes)),
    },
    {
      header: 'Deleted',
      cellClassName: 'text-xs text-gray-500 whitespace-nowrap',
      render: (row) => formatDate(row.created_at),
    },
    {
      header: 'Actions',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => handleRestore(row)}
            disabled={processingId === row.id}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#1a1a1a] text-xs font-semibold text-gray-300 hover:bg-indigo-950/40 hover:text-indigo-400 transition-colors disabled:opacity-50"
            title={row.itemType === 'folder' ? 'Restore Folder' : 'Restore File'}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Restore</span>
          </button>
          <button
            onClick={() => handlePermanentDelete(row)}
            disabled={processingId === row.id}
            className="p-1 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-950/30 transition-colors disabled:opacity-50"
            title="Delete Permanently"
          >
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div id="trash-view-container" className="flex-1 overflow-y-auto py-4 space-y-6">
      <ViewBanner
        tone="amber"
        icon={Trash2}
        title="Trash Bin"
        subtitle={
          <>
            Items in trash can be restored back to your storage or permanently deleted.
            {trashRetentionDays !== null && (
              <span className="block text-amber-400/80 mt-0.5">
                Anything left here is deleted automatically after {trashRetentionDays}{' '}
                {trashRetentionDays === 1 ? 'day' : 'days'}.
              </span>
            )}
          </>
        }
        actions={
          rows.length > 0 &&
          (!confirmEmpty ? (
            <button
              id="empty-trash-btn"
              onClick={() => setConfirmEmpty(true)}
              className="px-3.5 py-1.5 rounded-lg border border-red-500/30 text-xs font-semibold text-red-400 hover:bg-red-950/30 transition-colors"
            >
              Empty Trash
            </button>
          ) : (
            <>
              <button
                id="confirm-empty-trash-btn"
                onClick={handleEmptyTrash}
                disabled={processingId === 'all'}
                className="px-3 py-1.5 rounded-lg bg-red-600 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
              >
                {processingId === 'all' ? 'Purging...' : 'Confirm Purge All'}
              </button>
              <button
                onClick={() => setConfirmEmpty(false)}
                className="px-2.5 py-1.5 rounded-lg border border-[#2a2a2a] text-xs text-gray-400 hover:bg-[#1a1a1a] transition-colors"
              >
                Cancel
              </button>
            </>
          ))
        }
      />

      {rows.length === 0 ? (
        <div
          id="trash-empty-state"
          className="flex flex-col items-center justify-center p-12 text-center"
        >
          <div className="w-16 h-16 rounded-2xl bg-[#161616] border border-[#1f1f1f] flex items-center justify-center text-gray-500 mb-3">
            <Inbox className="w-8 h-8" />
          </div>
          <h4 className="text-base font-bold text-white">Trash is empty</h4>
          <p className="text-sm text-gray-400 mt-1">
            Deleted files and folders will appear here until permanently deleted.
          </p>
        </div>
      ) : (
        <ItemTable columns={columns} rows={rows} rowKey={itemRowKey} minWidthPx={680} />
      )}
    </div>
  );
};
