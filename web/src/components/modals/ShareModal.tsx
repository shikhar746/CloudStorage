import React, { useState, useEffect } from 'react';
import { X, Share2, Copy, Check, Users, Trash2, Shield, AlertCircle, UserCheck } from 'lucide-react';
import { useStorage } from '../../context/StorageContext';
import { PublicLinkSection } from './PublicLinkSection';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { ShareItem, ShareRole } from '../../types/storage';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ShareModal: React.FC = () => {
  const { shareTarget, setShareTarget } = useStorage();
  const { user } = useAuth();

  const [grantee, setGrantee] = useState('');
  const [role, setRole] = useState<ShareRole>('viewer');
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [loadingShares, setLoadingShares] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copiedMyId, setCopiedMyId] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shareTarget && user) {
      loadShares();
      setError(null);
    }
  }, [shareTarget, user]);

  if (!shareTarget) return null;

  const loadShares = async () => {
    if (!user || !shareTarget) return;
    setLoadingShares(true);
    try {
      const list = await api.listShares(shareTarget.type, shareTarget.item.id);
      setShares(list);
    } catch (err) {
      console.error('Failed to load shares', err);
    } finally {
      setLoadingShares(false);
    }
  };

  const handleCreateShare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const input = grantee.trim();

    if (!input) {
      setError('Enter an email address or user ID');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // the share endpoint takes a UUID, so resolve an email to one first
      let granteeUserId = input;
      if (!UUID_REGEX.test(input)) {
        if (!input.includes('@')) {
          setError('Enter an email address, or the collaborator\'s user ID.');
          return;
        }
        const found = await api.lookupUserByEmail(input.toLowerCase());
        granteeUserId = found.id;
      }

      if (granteeUserId === user.id) {
        setError('You already own this resource.');
        return;
      }

      await api.createShare(shareTarget.type, shareTarget.item.id, granteeUserId, role);
      setGrantee('');
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to share resource');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteShare = async (shareId: string) => {
    if (!user) return;
    try {
      await api.deleteShare(shareId);
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke access');
    }
  };

  const handleCopyMyId = () => {
    if (!user?.id) return;
    navigator.clipboard.writeText(user.id);
    setCopiedMyId(true);
    setTimeout(() => setCopiedMyId(false), 2000);
  };

  return (
    <div
      id="share-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={() => setShareTarget(null)}
    >
      <div
        id="share-modal"
        className="bg-[#111111] w-full max-w-lg rounded-2xl shadow-2xl border border-[#1f1f1f] p-6 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-950/40 border border-indigo-800/30 text-indigo-400 flex items-center justify-center">
              <Share2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Share Access</h3>
              <p className="text-xs text-gray-400 truncate max-w-xs">{shareTarget.item.name}</p>
            </div>
          </div>
          <button
            onClick={() => setShareTarget(null)}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-[#1a1a1a] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-950/30 p-3 text-xs text-red-400 flex items-center gap-2 border border-red-800/40">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <PublicLinkSection resourceType={shareTarget.type} resourceId={shareTarget.item.id} />

        {/* Invite Member Form */}
        <form onSubmit={handleCreateShare} className="mb-6 space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-semibold text-gray-300">
              Grant access by email
            </label>
            <button
              type="button"
              onClick={handleCopyMyId}
              className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
            >
              {copiedMyId ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copiedMyId ? 'Copied my ID!' : 'Copy my User ID'}</span>
            </button>
          </div>
          <div className="flex gap-2">
            <input
              id="share-user-id-input"
              type="text"
              required
              value={grantee}
              onChange={(e) => setGrantee(e.target.value)}
              placeholder="name@company.com"
              className="flex-1 rounded-xl border border-[#262626] bg-[#161616] px-3.5 py-2 text-xs text-gray-100 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <select
              id="share-role-select"
              value={role}
              onChange={(e) => setRole(e.target.value as ShareRole)}
              className="rounded-xl border border-[#262626] px-3 py-2 text-xs text-gray-200 font-medium bg-[#161616] focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <button
              id="submit-share-btn"
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-xl bg-indigo-600 text-xs font-semibold text-white hover:bg-indigo-700 shadow-md shadow-indigo-600/20 transition-colors disabled:opacity-50"
            >
              {submitting ? 'Adding...' : 'Grant'}
            </button>
          </div>
          <p className="text-[11px] text-gray-500">
            The address must already have an account. A raw user ID works too.
          </p>
        </form>

        {/* Existing Collaborators */}
        <div className="border-t border-[#1f1f1f] pt-4 mb-6">
          <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2.5">
            People with access
          </h4>

          <div className="space-y-2 max-h-40 overflow-y-auto">
            {/* Owner */}
            <div className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-[#161616] text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-6 h-6 rounded-full bg-indigo-600 text-white font-semibold text-[10px] flex items-center justify-center">
                  {user?.name?.charAt(0).toUpperCase() || 'Y'}
                </div>
                <div className="truncate">
                  <span className="font-semibold text-gray-200">{user?.name} (You)</span>
                  <span className="text-gray-500 block text-[10px] font-mono">{user?.id}</span>
                </div>
              </div>
              <span className="text-gray-400 font-medium text-[11px]">Owner</span>
            </div>

            {/* Shares */}
            {shares.map((share) => (
              <div
                key={share.id}
                className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-[#161616] text-xs transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-6 h-6 rounded-full bg-[#262626] text-gray-300 font-semibold text-[10px] flex items-center justify-center">
                    {share.grantee_name?.charAt(0).toUpperCase() || 'U'}
                  </div>
                  <div className="truncate">
                    <span className="font-medium text-gray-200">
                      {share.grantee_name || share.grantee_email || 'Collaborator'}
                    </span>
                    <span className="text-gray-500 block text-[10px] font-mono">
                      {share.grantee_email ? `${share.grantee_email} (${share.grantee_user_id})` : share.grantee_user_id}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                      share.role === 'editor'
                        ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/40'
                        : 'bg-indigo-950/40 text-indigo-400 border border-indigo-800/40'
                    }`}
                  >
                    {share.role === 'editor' ? 'Editor' : 'Viewer'}
                  </span>
                  <button
                    onClick={() => handleDeleteShare(share.id)}
                    className="p-1 rounded text-gray-500 hover:text-red-400 transition-colors"
                    title="Revoke access"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-[#1f1f1f]">
          <span className="text-[11px] text-gray-500">
            Permissions are synced directly with the Cloud Storage API
          </span>
          <button
            type="button"
            onClick={() => setShareTarget(null)}
            className="px-4 py-2 rounded-xl bg-[#1c1c1c] hover:bg-[#252525] border border-[#262626] text-xs font-semibold text-gray-200 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
