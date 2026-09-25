/**
 * One list, folders and files together.
 *
 * Three views show a mixed list and each had arrived at the same shape by hand:
 * tag every row with its kind, concatenate, then branch on the tag while
 * rendering. Naming it once means the branch is a discriminated union the
 * compiler checks, rather than three hand-written copies that happened to agree.
 */
export type ItemRow<F extends { id: string }, D extends { id: string }> =
  | ({ itemType: 'folder' } & F)
  | ({ itemType: 'file' } & D);

export function mergeItemRows<F extends { id: string }, D extends { id: string }>(
  folders: F[],
  files: D[]
): ItemRow<F, D>[] {
  return [
    ...folders.map((folder) => ({ ...folder, itemType: 'folder' as const })),
    ...files.map((file) => ({ ...file, itemType: 'file' as const })),
  ];
}

/** Stable key for a merged row: ids are only unique within their own table. */
export function itemRowKey(row: { itemType: 'folder' | 'file'; id: string }): string {
  return `${row.itemType}-${row.id}`;
}
