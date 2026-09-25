import React, { useState, useEffect } from 'react';
import {
  X,
  Download,
  Share2,
  Copy,
  Check,
  Calendar,
  HardDrive,
  FileText,
  Loader2,
} from 'lucide-react';
import { useStorage } from '../../context/StorageContext';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { FileIcon } from '../common/FileIcon';
import { formatBytes, formatDate } from '../../utils/formatters';

export const FilePreviewModal: React.FC = () => {
  const { previewFile, setPreviewFile, setShareTarget, downloadFile } = useStorage();
  const { user } = useAuth();

  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState<boolean>(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!previewFile) {
      setActiveUrl(null);
      setTextContent(null);
      return;
    }

    // Set initial fallback if already present
    setActiveUrl(previewFile.signedUrl || previewFile.previewUrl || null);
    setTextContent(previewFile.content || null);

    if (!user) return;

    let isMounted = true;
    setLoadingUrl(true);

    // Fetch fresh signed URL from API per-open (expires in 1 hour)
    api.getFile(previewFile.id)
      .then((res: any) => {
        if (!isMounted) return;
        const freshUrl = res.signedUrl || res.file?.signedUrl || res.file?.previewUrl;
        if (freshUrl) {
          setActiveUrl(freshUrl);
          const isText =
            previewFile.mime_type.startsWith('text/') ||
            previewFile.name.endsWith('.md') ||
            previewFile.name.endsWith('.json') ||
            previewFile.name.endsWith('.txt');
          if (isText && !previewFile.content) {
            fetch(freshUrl)
              .then((r) => r.text())
              .then((txt) => {
                if (isMounted) setTextContent(txt);
              })
              .catch(() => {});
          }
        }
      })
      .catch((err) => {
        console.warn('Could not fetch signed url:', err);
      })
      .finally(() => {
        if (isMounted) setLoadingUrl(false);
      });

    return () => {
      isMounted = false;
    };
  }, [previewFile?.id, user]);

  if (!previewFile) return null;

  const downloadUrl = activeUrl || previewFile.previewUrl || previewFile.signedUrl || '#';

  const handleCopyLink = () => {
    if (downloadUrl && downloadUrl !== '#') {
      navigator.clipboard.writeText(downloadUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const isImage =
    previewFile.mime_type.startsWith('image/') ||
    previewFile.name.endsWith('.svg') ||
    previewFile.name.endsWith('.png') ||
    previewFile.name.endsWith('.jpg') ||
    previewFile.name.endsWith('.webp');

  const isText =
    previewFile.mime_type.startsWith('text/') ||
    previewFile.name.endsWith('.md') ||
    previewFile.name.endsWith('.json') ||
    previewFile.name.endsWith('.txt');

  return (
    <div
      id="file-preview-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={() => setPreviewFile(null)}
    >
      <div
        className="bg-[#111111] w-full max-w-4xl h-[85vh] rounded-2xl shadow-2xl border border-[#1f1f1f] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-14 px-6 border-b border-[#1f1f1f] flex items-center justify-between bg-[#141414]">
          <div className="flex items-center gap-3 min-w-0">
            <FileIcon name={previewFile.name} mimeType={previewFile.mime_type} size="sm" />
            <span className="font-semibold text-sm text-gray-200 truncate" title={previewFile.name}>
              {previewFile.name}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => downloadFile(previewFile)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 shadow-md shadow-indigo-600/20 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>
            <button
              onClick={() => {
                const f = previewFile;
                setPreviewFile(null);
                setShareTarget({ type: 'file', item: f });
              }}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-[#1a1a1a] transition-colors"
              title="Share file"
            >
              <Share2 className="w-4 h-4" />
            </button>
            <button
              id="close-preview-btn"
              onClick={() => setPreviewFile(null)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-[#1a1a1a] transition-colors ml-1"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Body & Info Sidebar */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          {/* Main Visual/Text Preview Area */}
          <div className="flex-1 bg-[#0a0a0a] p-6 flex items-center justify-center overflow-auto relative">
            {loadingUrl && (
              <div className="absolute top-3 right-3 flex items-center gap-1.5 text-[11px] text-gray-400 bg-[#161616]/80 px-2 py-1 rounded-md border border-[#222]">
                <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
                <span>Fetching signed URL...</span>
              </div>
            )}

            {isImage && activeUrl ? (
              <img
                src={activeUrl}
                alt={previewFile.name}
                className="max-h-full max-w-full rounded-lg object-contain shadow-xs border border-[#1f1f1f]"
                referrerPolicy="no-referrer"
              />
            ) : isText && textContent ? (
              <div className="w-full h-full bg-[#141414] rounded-xl border border-[#1f1f1f] p-4 font-mono text-xs text-gray-200 overflow-auto whitespace-pre-wrap leading-relaxed shadow-2xs">
                {textContent}
              </div>
            ) : (
              <div className="text-center p-8">
                <FileIcon name={previewFile.name} mimeType={previewFile.mime_type} size="xl" className="mx-auto mb-4" />
                <h4 className="text-base font-bold text-gray-200 mb-1">{previewFile.name}</h4>
                <p className="text-xs text-gray-400 max-w-xs mx-auto mb-6">
                  {loadingUrl ? 'Loading secure signed URL...' : `File format: ${previewFile.mime_type || 'Unknown'}. You can download it directly.`}
                </p>
                <button
                  onClick={() => downloadFile(previewFile)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 shadow-md shadow-indigo-600/20"
                >
                  <Download className="w-4 h-4" />
                  <span>Download file ({formatBytes(previewFile.size_bytes)})</span>
                </button>
              </div>
            )}
          </div>

          {/* Details Sidebar */}
          <div className="w-full md:w-72 bg-[#111111] border-t md:border-t-0 md:border-l border-[#1f1f1f] p-5 space-y-4 overflow-y-auto text-xs shrink-0">
            <div>
              <h4 className="font-bold text-white text-sm mb-1">File Information</h4>
              <p className="text-gray-400 text-[11px]">Storage item metadata</p>
            </div>

            <div className="space-y-3 pt-2">
              <div>
                <span className="text-gray-500 font-medium block">File Name</span>
                <span className="font-semibold text-gray-200 break-all">{previewFile.name}</span>
              </div>

              <div>
                <span className="text-gray-500 font-medium block">File Size</span>
                <span className="font-semibold text-gray-200">{formatBytes(previewFile.size_bytes)}</span>
              </div>

              <div>
                <span className="text-gray-500 font-medium block">MIME Type</span>
                <span className="font-mono text-[11px] text-gray-300 bg-[#161616] border border-[#222222] px-1.5 py-0.5 rounded inline-block mt-0.5">
                  {previewFile.mime_type}
                </span>
              </div>

              <div>
                <span className="text-gray-500 font-medium block">Uploaded At</span>
                <span className="font-semibold text-gray-200">{formatDate(previewFile.created_at)}</span>
              </div>

              <div>
                <span className="text-gray-500 font-medium block">Resource ID</span>
                <span className="font-mono text-[10px] text-gray-500 break-all">{previewFile.id}</span>
              </div>
            </div>

            <div className="pt-3 border-t border-[#1f1f1f] space-y-2">
              <button
                id="copy-preview-link-btn"
                onClick={handleCopyLink}
                disabled={!activeUrl || activeUrl === '#'}
                className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-[#1f1f1f] hover:bg-[#1a1a1a] text-gray-300 font-medium transition-colors disabled:opacity-40"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Link Copied!' : 'Copy Signed Download URL'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
