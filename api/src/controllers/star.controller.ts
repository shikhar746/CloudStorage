import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase.js'
import { getAccessRole } from '../lib/access.js'
import { createStarSchema, starParamsSchema } from '../schemas/star.schema.js'

export async function createStarController(req: Request, res: Response) {
  const { success, error, data } = createStarSchema.safeParse(req.body)
  if (!success) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', issues: error.issues },
    })
  }

  // you may only star what you can already see, or the response would confirm
  // that another user's resource exists
  const role = await getAccessRole(req.userId, data.resourceType, data.resourceId)
  if (!role) {
    return res.status(404).json({
      error: { code: 'RESOURCE_NOT_FOUND', message: 'Not found' },
    })
  }

  // upsert, so starring something already starred is a no-op rather than a
  // primary key violation — the client can fire it without tracking state
  const { error: insertError } = await supabase.from('stars').upsert(
    {
      user_id: req.userId,
      resource_type: data.resourceType,
      resource_id: data.resourceId,
    },
    { onConflict: 'user_id,resource_type,resource_id' }
  )

  if (insertError) {
    console.error('star failed', insertError)
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Could not star this item' },
    })
  }

  return res.status(201).json({ starred: true })
}

export async function deleteStarController(req: Request, res: Response) {
  const { success, error, data } = starParamsSchema.safeParse(req.params)
  if (!success) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', issues: error.issues },
    })
  }

  // deliberately no access check: removing your own star must keep working
  // after the resource is trashed or the share behind it is revoked
  const { error: deleteError } = await supabase
    .from('stars')
    .delete()
    .eq('user_id', req.userId)
    .eq('resource_type', data.resourceType)
    .eq('resource_id', data.resourceId)

  if (deleteError) {
    console.error('unstar failed', deleteError)
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Could not remove the star' },
    })
  }

  return res.status(200).json({ starred: false })
}

export async function listStarredController(req: Request, res: Response) {
  const { data: stars, error: starsError } = await supabase
    .from('stars')
    .select('resource_type, resource_id, created_at')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })

  if (starsError) {
    console.error('list starred failed', starsError)
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load starred items' },
    })
  }

  const folderIds = stars.filter((s) => s.resource_type === 'folder').map((s) => s.resource_id)
  const fileIds = stars.filter((s) => s.resource_type === 'file').map((s) => s.resource_id)
  const starredAt = new Map(stars.map((s) => [s.resource_id, s.created_at]))

  // a star outlives the resource being trashed, so is_deleted is filtered here
  // rather than trusting the star to have been cleaned up
  const [folderResult, fileResult] = await Promise.all([
    folderIds.length > 0
      ? supabase
          .from('folders')
          .select('id, name, parent_id, owner_id, created_at')
          .in('id', folderIds)
          .eq('is_deleted', false)
      : Promise.resolve({ data: [], error: null }),
    fileIds.length > 0
      ? supabase
          .from('files')
          .select('id, name, mime_type, size_bytes, folder_id, owner_id, created_at')
          .in('id', fileIds)
          .eq('is_deleted', false)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (folderResult.error || fileResult.error) {
    console.error('starred lookup failed', folderResult.error, fileResult.error)
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load starred items' },
    })
  }

  // A star also outlives a share being revoked. Own items skip the check;
  // only starred items belonging to someone else pay for a role lookup.
  //
  // Every getAccessRole call is several round trips of its own, and no check
  // reads what an earlier one returned — so they are free to overlap instead
  // of queueing behind each other.
  async function visible<T extends { id: string; owner_id?: string }>(
    rows: T[],
    resourceType: 'file' | 'folder'
  ): Promise<T[]> {
    // One lookup per row, all in flight at once instead of queued behind each
    // other. Own rows short-circuit to a plain `true` and never reach the
    // database at all, which covers most of a typical Starred list.
    const checks = await Promise.all(
      rows.map((row) =>
        row.owner_id === req.userId ? true : getAccessRole(req.userId, resourceType, row.id)
      )
    )

    // `checks` is index-aligned with `rows` — Promise.all preserves input order
    // regardless of which lookup finished first — so filtering by position keeps
    // each row matched to its own result, and keeps the original order for the
    // star-date sort that follows.
    return rows.filter((_, i) => Boolean(checks[i]))
  }

  const byStarredAt = <T extends { id: string }>(a: T, b: T) =>
    String(starredAt.get(b.id) ?? '').localeCompare(String(starredAt.get(a.id) ?? ''))

  const folders = (await visible(folderResult.data ?? [], 'folder'))
    .map((f) => ({ ...f, starred: true }))
    .sort(byStarredAt)
  const files = (await visible(fileResult.data ?? [], 'file'))
    .map((f) => ({ ...f, starred: true }))
    .sort(byStarredAt)

  return res.status(200).json({ folders, files })
}
