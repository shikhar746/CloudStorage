import { supabase } from './supabase.js'

/**
 * Guards a malformed tree. `folders.parent_id` has no cycle constraint, so a
 * corrupt row pointing at its own ancestor would otherwise loop forever.
 */
const MAX_DEPTH = 50

export interface SubtreeFilter {
  /** Restricts the walk to one owner's folders. */
  ownerId?: string
  /** Restricts the walk to live (`false`) or trashed (`true`) folders. */
  isDeleted?: boolean
}

/**
 * Every folder id in the subtree rooted at `rootId`, the root included.
 *
 * Four flows need this and each wants a slightly different slice of the tree:
 * trashing walks live folders, restoring and permanent delete walk trashed
 * ones, and the move check walks live folders regardless of owner because a
 * cycle is a cycle whoever owns the rows. Those differences are the filter
 * argument rather than four hand-maintained copies of the loop, which is how
 * they drifted apart in the first place.
 *
 * Breadth-first by level, so the number of round trips is the depth of the
 * tree rather than the number of folders in it.
 */
export async function collectSubtreeFolderIds(
  rootId: string,
  filter: SubtreeFilter = {}
): Promise<string[]> {
  const all = [rootId]
  let level = [rootId]
  let depth = 0

  while (level.length > 0 && depth < MAX_DEPTH) {
    let query = supabase.from('folders').select('id').in('parent_id', level)
    if (filter.ownerId !== undefined) query = query.eq('owner_id', filter.ownerId)
    if (filter.isDeleted !== undefined) query = query.eq('is_deleted', filter.isDeleted)

    const { data: children, error } = await query
    if (error) throw new Error(`folder subtree lookup failed: ${error.message}`)

    level = (children ?? []).map((child) => child.id as string)
    all.push(...level)
    depth++
  }

  return all
}

/**
 * Whether a restored item's original parent is gone or still in the trash.
 *
 * Restoring into a trashed folder would put the item somewhere its owner
 * cannot reach, so both file and folder restores fall back to the root when
 * this reports true.
 */
export async function parentFolderIsUnavailable(
  userId: string,
  parentId: string | null
): Promise<boolean> {
  if (!parentId) return false

  const { data: parent } = await supabase
    .from('folders')
    .select('id, is_deleted')
    .eq('id', parentId)
    .eq('owner_id', userId)
    .single()

  return !parent || parent.is_deleted === true
}
