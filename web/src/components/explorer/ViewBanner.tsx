import React from 'react';
import type { LucideIcon } from 'lucide-react';

export type BannerTone = 'amber' | 'indigo' | 'red';

/** Per-tone classes, kept together so a new tone is one entry. */
const TONES: Record<BannerTone, { border: string; background: string; iconBox: string }> = {
  amber: {
    border: 'border-amber-500/30',
    background: 'bg-amber-950/10',
    iconBox: 'bg-amber-900/30 text-amber-400',
  },
  indigo: {
    border: 'border-indigo-500/30',
    background: 'bg-indigo-950/20',
    iconBox: 'bg-indigo-900/30 text-indigo-400',
  },
  red: {
    border: 'border-red-500/30',
    background: 'bg-red-950/10',
    iconBox: 'bg-red-900/30 text-red-400',
  },
};

interface ViewBannerProps {
  tone: BannerTone;
  icon: LucideIcon;
  title: string;
  subtitle: React.ReactNode;
  /** Buttons for the right-hand side: refresh, empty trash, and so on. */
  actions?: React.ReactNode;
  iconClassName?: string;
}

/**
 * The header card at the top of Shared, Starred and Trash.
 *
 * Identical markup in all three, differing only in colour, icon and wording —
 * so those are the props and the layout lives in one place.
 */
export const ViewBanner: React.FC<ViewBannerProps> = ({
  tone,
  icon: Icon,
  title,
  subtitle,
  actions,
  iconClassName = '',
}) => {
  const colours = TONES[tone];

  return (
    <div
      className={`rounded-xl border ${colours.border} ${colours.background} p-4 flex items-center justify-between gap-3`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`w-9 h-9 rounded-lg ${colours.iconBox} flex items-center justify-center shrink-0`}
        >
          <Icon className={`w-5 h-5 ${iconClassName}`} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-white">{title}</h3>
          <p className="text-xs text-gray-400">{subtitle}</p>
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
};
