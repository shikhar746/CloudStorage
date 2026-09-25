import React from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { ActiveNavTab } from '../../types/storage';

interface SidebarNavItemProps {
  tab: ActiveNavTab;
  label: string;
  icon: LucideIcon;
  isActive: boolean;
  onSelect: () => void;
  /** Shown instead of the active chevron when non-zero. */
  count?: number;
}

/**
 * One entry in the sidebar's primary navigation.
 *
 * There are four of these and they were four copies of the same twenty lines,
 * down to the active-state colour repeated verbatim in each. Adding Starred
 * meant adding a fifth copy; this way a new destination is one row of data.
 *
 * The count badge takes the place of the active chevron when there is something
 * to report, which is how Shared and Trash already behaved.
 */
export const SidebarNavItem: React.FC<SidebarNavItemProps> = ({
  tab,
  label,
  icon: Icon,
  isActive,
  onSelect,
  count = 0,
}) => (
  <button
    id={`nav-${tab}`}
    onClick={onSelect}
    aria-current={isActive ? 'page' : undefined}
    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
      isActive
        ? 'bg-indigo-600/10 text-indigo-400 font-semibold'
        : 'text-gray-400 hover:bg-[#1a1a1a] hover:text-white'
    }`}
  >
    <div className="flex items-center gap-3">
      <Icon className={`w-4 h-4 ${isActive ? 'text-indigo-400' : 'text-gray-500'}`} />
      <span>{label}</span>
    </div>
    {count > 0 ? (
      <span className="text-[11px] font-semibold bg-[#1a1a1a] border border-[#2a2a2a] text-gray-400 px-2 py-0.5 rounded-full">
        {count}
      </span>
    ) : (
      isActive && <ChevronRight className="w-3.5 h-3.5 text-indigo-400" />
    )}
  </button>
);
