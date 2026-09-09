import { supabase } from './supabase.js'
import { chunk } from './chunk.js'

/**
 * Marks which of these rows the caller has starred.
 *
 * Stars are per-user, so "starred" cannot be a column on the resource and has
 * to be joined in per request. One query covers both lists — the alternative,
 * asking per row, would turn a folder listing into N+1 round trips.
 */
export async function attachStarred<
  F extends { id: string },
  D extends { id: string },
>(
  userId: string,
  folders: F[],
  files: D[]
): Promise<{ folders: (F & { starred: boolean })[]; files: (D & { starred: boolean })[] }> {
  const ids = [...folders.map((f) => f.id), ...files.map((f) => f.id)]

  let starred = new Set<string>()
  if (ids.length > 0) {
    const { data, error } = await supabase
      .from('stars')
      .select('resource_type, resource_id')
      .eq('user_id', userId)
      .in('resource_id', ids)

    // a failed star lookup must not fail the listing — the worst case is a
    // star that renders hollow until the next refresh
    if (error) console.error('star lookup failed', error)
    else starred = new Set(data.map((s) => `${s.resource_type}:${s.resource_id}`))
  }

  return {
    folders: folders.map((f) => ({ ...f, starred: starred.has(`folder:${f.id}`) })),
    files: files.map((f) => ({ ...f, starred: starred.has(`file:${f.id}`) })),
  }
}

/**
 * Drops every user's stars on resources that are being permanently deleted.
 *
 * `stars.resource_id` is polymorphic and carries no foreign key, so nothing
 * cascades when a file or folder row goes. The read paths already skip stars
 * pointing at rows that are gone, which is why this was never a correctness
 * bug — but left alone the table only ever grows, so the four hard-delete
 * paths call this on their way out.
 *
 * Deliberately NOT scoped to one user: the resource is gone for everyone, so
 * every grantee who starred it loses that star too. Equally deliberately not
 * called on soft delete — a trashed item can be restored, and its stars should
 * come back with it.
 */
export async function deleteStarsFor(
  resourceType: 'file' | 'folder',
  resourceIds: string[]
): Promise<void> {
  if (resourceIds.length === 0) return

  for (const batch of chunk(resourceIds, 100)) {
    const { error } = await supabase
      .from('stars')
      .delete()
      .eq('resource_type', resourceType)
      .in('resource_id', batch)

    // The same call the storage deletes make: a leftover star row is invisible
    // to every read path, so logging beats failing the delete that mattered.
    if (error) console.error('star cleanup failed', error)
  }
}
