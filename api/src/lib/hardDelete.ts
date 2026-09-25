import { supabase } from './supabase.js'
import { env } from '../config/env.js'
import { chunk } from './chunk.js'
import { deleteStarsFor } from './stars.js'

/** Storage keys per `remove` call, and ids per `in(...)` filter. */
const BATCH_SIZE = 100

export interface FileRef {
  id: string
  storage_key: string
}

export interface HardDeleteInput {
  /** Folder rows to drop. Their subtrees go with them via the cascade. */
  folderIds: string[]
  /** File rows to drop in their own right. */
  files: FileRef[]
  /** Scopes the nested-file lookup and the row deletes to one owner. */
  ownerId?: string
}

export interface HardDeleteResult {
  folders: number
  files: number
  blobs: number
}

/**
 * Removes a set of folders and files for good.
 *
 * The order is the whole point, and it is why this is one function rather than
 * the three near-copies it replaces. Dropping a folder row cascades to every
 * file beneath it and takes with it the only record of where those blobs live,
 * so the blobs have to be collected and deleted BEFORE the rows. Reversing the
 * two steps leaks storage silently and irrecoverably, and a leak like that is
 * invisible in every read path — nothing would ever report it.
 *
 * Stars come last, and only once the rows are really gone: `stars.resource_id`
 * is polymorphic and carries no foreign key, so nothing cascades it away, but a
 * star pointing at a row that still exists is not dangling and must survive.
 */
export async function hardDeleteResources(input: HardDeleteInput): Promise<HardDeleteResult> {
  const { folderIds, ownerId } = input

  const storageKeys = new Set(input.files.map((file) => file.storage_key))
  // Ids of every file losing its row, cascaded ones included. Gathered in this
  // same pass because afterwards there is nothing left to work them out from.
  const doomedFileIds = new Set(input.files.map((file) => file.id))
  const explicitFileIds = input.files.map((file) => file.id)

  // Files under an expiring folder lose their row to the cascade whether or not
  // they were trashed in their own right, so their blobs have to go too.
  for (const batch of chunk(folderIds, BATCH_SIZE)) {
    let query = supabase.from('files').select('id, storage_key').in('folder_id', batch)
    if (ownerId !== undefined) query = query.eq('owner_id', ownerId)

    const { data: nested, error } = await query
    if (error) throw new Error(`nested file lookup failed: ${error.message}`)

    for (const file of nested ?? []) {
      storageKeys.add(file.storage_key as string)
      doomedFileIds.add(file.id as string)
    }
  }

  await removeStoredBlobs([...storageKeys])

  if (explicitFileIds.length > 0) {
    for (const batch of chunk(explicitFileIds, BATCH_SIZE)) {
      let query = supabase.from('files').delete().in('id', batch)
      if (ownerId !== undefined) query = query.eq('owner_id', ownerId)

      const { error } = await query
      if (error) throw new Error(`file delete failed: ${error.message}`)
    }
  }

  // Deleting a parent cascades to its children, so some of these ids may
  // already be gone by the time this runs. Delete is idempotent, so that is
  // fine — the count returned is what was scheduled, not what each statement hit.
  if (folderIds.length > 0) {
    for (const batch of chunk(folderIds, BATCH_SIZE)) {
      let query = supabase.from('folders').delete().in('id', batch)
      if (ownerId !== undefined) query = query.eq('owner_id', ownerId)

      const { error } = await query
      if (error) throw new Error(`folder delete failed: ${error.message}`)
    }
  }

  await deleteStarsFor('file', [...doomedFileIds])
  await deleteStarsFor('folder', folderIds)

  return {
    folders: folderIds.length,
    files: explicitFileIds.length,
    blobs: storageKeys.size,
  }
}

/**
 * Deletes objects from the bucket, in batches.
 *
 * A few thousand keys in a single `remove` is asking for a timeout, and every
 * caller here can produce that many from one folder. Failures are logged rather
 * than thrown: a logged orphan is better than a delete that never completes and
 * leaves the row it was meant to remove stranded behind it.
 */
async function removeStoredBlobs(keys: string[]): Promise<void> {
  for (const batch of chunk(keys, BATCH_SIZE)) {
    const { error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).remove(batch)
    if (error) console.error('storage delete failed', error)
  }
}
