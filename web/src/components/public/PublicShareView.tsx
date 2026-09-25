import React, { useCallback, useEffect, useState } from 'react';
import {
  Cloud,
  Lock,
  Download,
  Folder as FolderIcon,
  ChevronRight,
  AlertCircle,
  Clock,
} from 'lucide-react';
import {
  ApiError,
  getPublicShare,
  accessPublicShare,
  browsePublicShare,
  getPublicFile,
} from '../../services/api';
import { FileIcon } from '../common/FileIcon';
import { PasswordInput } from '../common/PasswordInput';
import { formatBytes, formatDate } from '../../utils/formatters';
import { FileItem, PublicShareMeta, PublicSharePayload } from '../../types/storage';

/** Turns a failure into something a visitor with no account can act on. */
function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'LINK_EXPIRED') return 'This link has expired.';
    if (err.code === 'LINK_NOT_FOUND') return 'This link does not exist or has been revoked.';
    if (err.code === 'RESOURCE_GONE') return 'The shared item no longer exists.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

interface PublicShareViewProps {
  token: string;
}

interface Crumb {
  id: string;
  name: string;
}

/**
 * The page a share link opens. It runs entirely outside AuthProvider: a
 * visitor has no account, and requiring one would defeat the point of the link.
 *
 * The password is held in memory and resent with every call rather than
 * exchanged for a session. That keeps the server stateless and means closing
 * the tab genuinely ends the access.
 */
export const PublicShareView: React.FC<PublicShareViewProps> = ({ token }) => {
  const [meta, setMeta] = useState<PublicShareMeta | null>(null);
  const [payload, setPayload] = useState<PublicSharePayload | null>(null);
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  // metadata first: it tells us whether to ask for a password before anything else
  useEffect(() => {
    let active = true;
    getPublicShare(token)
      .then((m) => {
        if (!active) return;
        setMeta(m);
        if (!m.requiresPassword) return openLink('');
      })
      .catch((err) => {
        if (active) setFatal(describe(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // openLink is stable enough for a mount-only effect keyed on the token
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const openLink = useCallback(
    async (pw: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await accessPublicShare(token, pw || undefined);
        setPayload(result);
        setSubmitted(pw);
        if (result.resourceType === 'folder') {
          setCrumbs([{ id: result.folder.id, name: result.folder.name }]);
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'INVALID_PASSWORD') {
          setError('Incorrect password.');
        } else if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
          setFatal(describe(err));
        } else {
          setError(describe(err));
        }
      } finally {
        setLoading(false);
      }
    },
    [token]
  );

  const openFolder = async (folderId: string, name: string, depth: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await browsePublicShare(token, folderId, submitted || undefined);
      setPayload(result);
      setCrumbs((prev) => [...prev.slice(0, depth), { id: folderId, name }]);
    } catch (err) {
      setError(describe(err));
    } finally {
      setLoading(false);
    }
  };

  const download = async (file: FileItem) => {
    setError(null);
    try {
      const { signedUrl } = await getPublicFile(token, file.id, submitted || undefined);
      window.open(signedUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(describe(err));
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen w-full bg-[#0a0a0a] text-[#e5e7eb] font-sans flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-3xl">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-600/20">
            <Cloud className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-bold text-white leading-tight">CloudStorage</p>
            <p className="text-[11px] text-gray-500 leading-tight">Shared with you</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );

  if (fatal) {
    return shell(
      <div className="rounded-2xl border border-[#1f1f1f] bg-[#111111] p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-[#161616] border border-[#1f1f1f] flex items-center justify-center text-gray-500 mx-auto mb-4">
          <AlertCircle className="w-7 h-7" />
        </div>
        <h1 className="text-base font-bold text-white">Link unavailable</h1>
        <p className="text-sm text-gray-400 mt-1">{fatal}</p>
      </div>
    );
  }

  // password gate: nothing about the item is known yet, by design
  if (meta?.requiresPassword && !payload) {
    return shell(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void openLink(password);
        }}
        className="rounded-2xl border border-[#1f1f1f] bg-[#111111] p-8 max-w-md mx-auto"
      >
        <div className="w-14 h-14 rounded-2xl bg-amber-950/30 border border-amber-800/40 flex items-center justify-center text-amber-400 mx-auto mb-4">
          <Lock className="w-7 h-7" />
        </div>
        <h1 className="text-base font-bold text-white text-center">This link is protected</h1>
        <p className="text-sm text-gray-400 mt-1 mb-5 text-center">
          Enter the password you were given to open it.
        </p>

        {error && (
          <div className="mb-3 rounded-lg bg-red-950/30 p-2.5 text-xs text-red-400 flex items-center gap-2 border border-red-800/40">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <PasswordInput
          id="public-share-password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-xl border border-[#262626] bg-[#161616] py-2.5 text-sm text-gray-100 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <button
          type="submit"
          disabled={loading || !password}
          className="mt-3 w-full px-4 py-2.5 rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors disabled:opacity-50"
        >
          {loading ? 'Checking...' : 'Unlock'}
        </button>
      </form>
    );
  }

  if (loading && !payload) {
    return shell(
      <div className="flex flex-col items-center justify-center py-20 text-gray-400">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-sm font-medium">Opening shared item...</p>
      </div>
    );
  }

  if (payload?.resourceType === 'file') {
    const file = payload.file;
    return shell(
      <div className="rounded-2xl border border-[#1f1f1f] bg-[#111111] p-8 text-center">
        <div className="flex justify-center mb-4">
          <FileIcon name={file.name} mimeType={file.mime_type} size="lg" />
        </div>
        <h1 className="text-base font-bold text-white break-words">{file.name}</h1>
        <p className="text-xs text-gray-500 mt-1">
          {formatBytes(file.size_bytes)} • {formatDate(file.created_at)}
        </p>
        {meta?.expiresAt && (
          <p className="text-[11px] text-amber-400/80 mt-2 inline-flex items-center gap-1">
            <Clock className="w-3 h-3" />
            Link expires {formatDate(meta.expiresAt)}
          </p>
        )}

        {error && <p className="text-xs text-red-400 mt-3">{error}</p>}

        <button
          onClick={() => download(file)}
          className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 shadow-md shadow-indigo-600/20 transition-colors"
        >
          <Download className="w-4 h-4" />
          Download
        </button>
      </div>
    );
  }

  if (payload?.resourceType === 'folder') {
    // `resourceType` is the union's discriminant, so this branch is already
    // narrowed to PublicFolderPayload — a cast here would only mask a future
    // mismatch between the payload types and what the server actually sends.
    const { folders, files } = payload.children;
    const empty = folders.length === 0 && files.length === 0;

    return shell(
      <div className="space-y-4">
        <div className="rounded-xl border border-[#1f1f1f] bg-[#111111] px-4 py-3 flex items-center gap-2 flex-wrap">
          {crumbs.map((crumb, i) => (
            <React.Fragment key={crumb.id}>
              {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-gray-600" />}
              <button
                onClick={() => i < crumbs.length - 1 && openFolder(crumb.id, crumb.name, i)}
                disabled={i === crumbs.length - 1}
                className={`text-xs font-medium ${
                  i === crumbs.length - 1
                    ? 'text-indigo-400 cursor-default'
                    : 'text-gray-400 hover:text-white cursor-pointer'
                }`}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
          {meta?.expiresAt && (
            <span className="ml-auto text-[11px] text-amber-400/80 inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Expires {formatDate(meta.expiresAt)}
            </span>
          )}
        </div>

        {error && (
          <div className="rounded-lg bg-red-950/30 p-2.5 text-xs text-red-400 flex items-center gap-2 border border-red-800/40">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {empty ? (
          <div className="rounded-2xl border border-[#1f1f1f] bg-[#111111] p-12 text-center text-sm text-gray-400">
            This folder is empty.
          </div>
        ) : (
          <div className="rounded-2xl border border-[#1f1f1f] bg-[#111111] overflow-hidden divide-y divide-[#1f1f1f]">
            {folders.map((folder) => (
              <button
                key={folder.id}
                onClick={() => openFolder(folder.id, folder.name, crumbs.length)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#141414] transition-colors text-left"
              >
                <FolderIcon className="w-5 h-5 text-amber-500 fill-amber-500/20 shrink-0" />
                <span className="text-sm font-semibold text-gray-200 truncate flex-1">
                  {folder.name}
                </span>
                <ChevronRight className="w-4 h-4 text-gray-600 shrink-0" />
              </button>
            ))}
            {files.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-[#141414] transition-colors"
              >
                <FileIcon name={file.name} mimeType={file.mime_type} size="sm" className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-200 truncate">{file.name}</p>
                  <p className="text-[11px] text-gray-500">{formatBytes(file.size_bytes)}</p>
                </div>
                <button
                  onClick={() => download(file)}
                  className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-[#1a1a1a] transition-colors shrink-0"
                  title={`Download ${file.name}`}
                >
                  <Download className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return shell(
    <div className="rounded-2xl border border-[#1f1f1f] bg-[#111111] p-12 text-center text-sm text-gray-400">
      Nothing to show.
    </div>
  );
};
