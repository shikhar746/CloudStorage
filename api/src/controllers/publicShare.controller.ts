import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase.js'
import { env } from '../config/env.js'
import {
  loadShareLink,
  linkHasExpired,
  type ShareLinkRow,
} from '../middleware/resolvePublicLink.js'

const SIGNED_URL_TTL_SECONDS = 60 * 60

const FOLDER_COLUMNS = 'id, name, parent_id, created_at'
const FILE_COLUMNS = 'id, name, mime_type, size_bytes, folder_id, created_at'

/** The one message a visitor gets for anything they are not entitled to see. */
function notFound(res: Response, code = 'RESOURCE_GONE', message = 'The shared item no longer exists') {
  return res.status(404).json({ error: { code, message } })
}

/** Walks up from a folder to confirm it really sits under the shared one. */
async function isDescendantFolder(folderId: string, ancestorId: string): Promise<boolean> {
  if (folderId === ancestorId) return true

  // annotated rather than inferred: `current` is assigned from the row and the
  // row is fetched using `current`, which TypeScript reads as a circular
  // initializer (TS7022) unless the shape is stated outright
  type FolderRef = { id: string; parent_id: string | null }

  let current: string | null = folderId
  // bounded like getAccessRole, so malformed data cannot loop forever
  for (let depth = 0; current && depth < 50; depth++) {
    const { data } = await supabase
      .from('folders')
      .select('id, parent_id')
      .eq('id', current)
      .eq('is_deleted', false)
      .maybeSingle()

    const folder = data as FolderRef | null
    if (!folder) return false
    if (folder.id === ancestorId) return true
    current = folder.parent_id
  }
  return false
}

function touch(linkId: string) {
  // fire and forget: a failed timestamp update must not fail the download
  void supabase
    .from('share_links')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', linkId)
    .then(({ error }) => {
      if (error) console.error('share link touch failed', error)
    })
}

/** A signed URL for one file, or null when the blob is not there. */
async function signedUrlFor(storageKey: string): Promise<string | null> {
  const { data } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(storageKey, SIGNED_URL_TTL_SECONDS)

  return data?.signedUrl ?? null
}

/**
 * Metadata only, and deliberately thin.
 *
 * The one public endpoint that does NOT sit behind `resolvePublicLink`: it has
 * to answer before a password is known, so it resolves the link itself and
 * stops short of the password check.
 *
 * When a link is password protected this reveals nothing beyond "a password is
 * needed" — not the name, not the size, not the owner. Naming the file before
 * the password is checked would leak the very thing the password protects.
 */
export async function getPublicShareController(req: Request, res: Response) {
  const link = await loadShareLink(req.params.token as string)

  if (!link) {
    return res.status(404).json({
      error: { code: 'LINK_NOT_FOUND', message: 'This link does not exist' },
    })
  }

  if (linkHasExpired(link)) {
    return res.status(410).json({
      error: { code: 'LINK_EXPIRED', message: 'This link has expired' },
    })
  }

  if (link.password_hash) {
    return res.status(200).json({
      resourceType: link.resource_type,
      requiresPassword: true,
      expiresAt: link.expires_at,
    })
  }

  const table = link.resource_type === 'file' ? 'files' : 'folders'
  const { data } = await supabase
    .from(table)
    .select('name')
    .eq('id', link.resource_id)
    .eq('is_deleted', false)
    .maybeSingle()

  if (!data?.name) return notFound(res)

  return res.status(200).json({
    resourceType: link.resource_type,
    requiresPassword: false,
    expiresAt: link.expires_at,
    name: data.name,
  })
}

async function listPublicFolder(res: Response, link: ShareLinkRow, folderId: string) {
  const { data: folder } = await supabase
    .from('folders')
    .select(FOLDER_COLUMNS)
    .eq('id', folderId)
    .eq('is_deleted', false)
    .maybeSingle()

  if (!folder) return notFound(res, 'RESOURCE_GONE', 'The shared folder no longer exists')

  const [{ data: folders }, { data: files }] = await Promise.all([
    supabase.from('folders').select(FOLDER_COLUMNS).eq('parent_id', folderId).eq('is_deleted', false),
    supabase.from('files').select(FILE_COLUMNS).eq('folder_id', folderId).eq('is_deleted', false),
  ])

  touch(link.id)

  const isRoot = folder.id === link.resource_id

  return res.status(200).json({
    resourceType: 'folder',
    // the shared folder is the visitor's root, so parent_id is stripped at that
    // boundary and the UI cannot offer to navigate above it
    folder: { ...folder, parent_id: isRoot ? null : folder.parent_id },
    isRoot,
    children: { folders: folders ?? [], files: files ?? [] },
  })
}

/**
 * Opens the link: a signed URL for a file, or a listing for a folder.
 *
 * The token, expiry and password were all settled by `resolvePublicLink`, so
 * everything from here down is about the resource itself.
 */
export async function accessPublicShareController(req: Request, res: Response) {
  const link = req.shareLink

  if (link.resource_type === 'folder') {
    return listPublicFolder(res, link, link.resource_id)
  }

  const { data: file } = await supabase
    .from('files')
    .select(`${FILE_COLUMNS}, storage_key`)
    .eq('id', link.resource_id)
    .eq('is_deleted', false)
    .maybeSingle()

  if (!file) return notFound(res, 'RESOURCE_GONE', 'The shared file no longer exists')

  const signedUrl = await signedUrlFor(file.storage_key)
  if (!signedUrl) return notFound(res, 'RESOURCE_GONE', 'The shared file no longer exists')

  touch(link.id)
  const { storage_key, ...safeFile } = file
  return res.status(200).json({ resourceType: 'file', file: safeFile, signedUrl })
}

/**
 * Opening a subfolder through a folder link. The requested folder must sit
 * under the shared one — without that check, a token for one folder would read
 * any folder in the database by id.
 */
export async function browsePublicShareController(req: Request, res: Response) {
  const link = req.shareLink

  if (link.resource_type !== 'folder') {
    return res.status(400).json({
      error: { code: 'NOT_A_FOLDER', message: 'This link does not point at a folder' },
    })
  }

  const folderId = req.params.folderId as string
  if (!(await isDescendantFolder(folderId, link.resource_id))) {
    return notFound(res, 'FOLDER_NOT_FOUND', 'Not found')
  }

  return listPublicFolder(res, link, folderId)
}

/** A single file reached through a link, verified to be within its scope. */
export async function publicFileController(req: Request, res: Response) {
  const link = req.shareLink

  const { data: file } = await supabase
    .from('files')
    .select(`${FILE_COLUMNS}, storage_key`)
    .eq('id', req.params.fileId as string)
    .eq('is_deleted', false)
    .maybeSingle()

  if (!file) return notFound(res, 'FILE_NOT_FOUND', 'Not found')

  // the file must BE the shared one, or live somewhere beneath a shared folder
  const allowed =
    link.resource_type === 'file'
      ? file.id === link.resource_id
      : Boolean(file.folder_id) && (await isDescendantFolder(file.folder_id, link.resource_id))

  if (!allowed) return notFound(res, 'FILE_NOT_FOUND', 'Not found')

  const signedUrl = await signedUrlFor(file.storage_key)
  if (!signedUrl) return notFound(res, 'FILE_NOT_FOUND', 'Not found')

  touch(link.id)
  const { storage_key, ...safeFile } = file
  return res.status(200).json({ file: safeFile, signedUrl })
}
