import React from 'react';

export interface ItemColumn<R> {
  header: string;
  /** Right-aligned columns are the action/affordance ones. */
  align?: 'left' | 'right';
  /** Extra classes for this column's cells, e.g. whitespace handling. */
  cellClassName?: string;
  render: (row: R) => React.ReactNode;
}

interface ItemTableProps<R> {
  columns: ItemColumn<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  /** Makes rows clickable. Omit for a list whose actions are all in cells. */
  onRowClick?: (row: R) => void;
  /** Below this the table scrolls horizontally rather than squashing. */
  minWidthPx?: number;
}

/**
 * The list table the explorer views share.
 *
 * Shared, Starred and Trash each had their own copy of this markup, down to the
 * same header classes and the same row hover colour written out three times —
 * so a change to the list's appearance meant three edits, and Starred was
 * already subtly adrift from the other two. Columns are data here, which is the
 * only part that actually differs between the three.
 *
 * Wide content scrolls inside its own container so the page body never does.
 */
export function ItemTable<R>({
  columns,
  rows,
  rowKey,
  onRowClick,
  minWidthPx,
}: ItemTableProps<R>) {
  return (
    <div className="bg-[#111111] rounded-xl border border-[#1f1f1f] overflow-hidden shadow-2xs overflow-x-auto">
      <table
        className="w-full text-left border-collapse"
        style={minWidthPx ? { minWidth: `${minWidthPx}px` } : undefined}
      >
        <thead>
          <tr className="border-b border-[#1f1f1f] bg-[#161616] text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            {columns.map((column) => (
              <th
                key={column.header}
                className={`py-2.5 px-4 ${column.align === 'right' ? 'text-right' : ''}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-[#1f1f1f] hover:bg-[#141414] text-sm transition-colors ${
                onRowClick ? 'cursor-pointer' : ''
              }`}
            >
              {columns.map((column) => (
                <td
                  key={column.header}
                  className={`py-3 px-4 ${column.align === 'right' ? 'text-right' : ''} ${
                    column.cellClassName ?? ''
                  }`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
