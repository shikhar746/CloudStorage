import { supabase } from './supabase.js'
import { env } from '../config/env.js'
import { chunk } from './chunk.js'
import { deleteStarsFor } from './stars.js'

export interface PurgeResult {
  folders: number
  files: number
  blobs: number
}

/**
 * Permanently removes trash older than the retention window.
 *
 * Ordering is the whole trick: blobs are collected and deleted BEFORE the
 * rows, because dropping a folder row cascades to every file beneath it and
 * takes with it the only record of where those blobs live. Reversing these two
 * steps leaks storage silently and irrecoverably.
 */
export async function purgeExpiredTrash(): Promise<PurgeResult> {
  const cutoff = new Date(
    Date.now() - env.TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  const { data: expiredFolders, error: folderError } = await supabase
    .from('folders')
    .select('id')
    .eq('is_deleted', true)
    .lt('deleted_at', cutoff)

  if (folderError) throw new Error(`purge folder lookup failed: ${folderError.message}`)

  const { data: expiredFiles, error: fileError } = await supabase
    .from('files')
    .select('id, storage_key')
    .eq('is_deleted', true)
    .lt('deleted_at', cutoff)

  if (fileError) throw new Error(`purge file lookup failed: ${fileError.message}`)

  const folderIds = expiredFolders.map((f) => f.id)
  const fileIds = expiredFiles.map((f) => f.id)
  const storageKeys = new Set(expiredFiles.map((f) => f.storage_key))
  // Stars carry no foreign key, so nothing cascades them away. Their ids have
  // to be gathered here, in the same pass as the blobs: once the rows are gone
  // there is no longer anything to work out which stars were left dangling.
  const purgedFileIds = new Set(fileIds)

  // Every file under an expiring folder loses its row to the cascade, whether
  // or not it was trashed in its own right, so its blob has to go as well.
  if (folderIds.length > 0) {
    const { data: nested, error: nestedError } = await supabase
      .from('files')
      .select('id, storage_key')
      .in('folder_id', folderIds)

    if (nestedError) throw new Error(`purge nested file lookup failed: ${nestedError.message}`)
    for (const f of nested) {
      storageKeys.add(f.storage_key)
      purgedFileIds.add(f.id)
    }
  }

  for (const batch of chunk([...storageKeys], 100)) {
    const { error: storageError } = await supabase.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .remove(batch)

    // log and continue: a logged orphan is better than a sweep that never
    // finishes and lets the trash grow without bound
    if (storageError) console.error('[purge] storage delete failed', storageError)
  }

  if (fileIds.length > 0) {
    const { error } = await supabase.from('files').delete().in('id', fileIds)
    if (error) throw new Error(`purge file delete failed: ${error.message}`)
  }

  // Deleting a parent cascades to its children, so some of these ids may
  // already be gone by the time this runs. Delete is idempotent, so that is
  // fine — the returned count is what was scheduled, not what each statement hit.
  if (folderIds.length > 0) {
    const { error } = await supabase.from('folders').delete().in('id', folderIds)
    if (error) throw new Error(`purge folder delete failed: ${error.message}`)
  }

  // Last, and only once the rows are really gone: a star pointing at a resource
  // that still exists is not dangling, so an earlier sweep could delete a live one.
  await deleteStarsFor('file', [...purgedFileIds])
  await deleteStarsFor('folder', folderIds)

  return { folders: folderIds.length, files: fileIds.length, blobs: storageKeys.size }
}

/**
 * Starts the in-process sweeper. Returns false when it is switched off, which
 * is the right setting for a deployment driving the purge from an external
 * scheduler through POST /api/maintenance/purge-trash.
 */
export function startTrashPurgeSchedule(): boolean {
  if (env.TRASH_PURGE_INTERVAL_MINUTES <= 0) return false

  const run = async () => {
    try {
      const result = await purgeExpiredTrash()
      if (result.files > 0 || result.folders > 0 || result.blobs > 0) {
        console.log(
          `[purge] removed ${result.files} file(s), ${result.folders} folder(s), ${result.blobs} blob(s)`
        )
      }
    } catch (err) {
      // a failed sweep must never take the process down; the next tick retries
      console.error('[purge] sweep failed', err)
    }
  }

  // Once at boot as well as on the interval. A free instance that sleeps
  // between requests may never stay awake long enough to reach the timer, so
  // waking up is itself the most reliable trigger there.
  void run()

  const timer = setInterval(run, env.TRASH_PURGE_INTERVAL_MINUTES * 60 * 1000)
  timer.unref()
  return true
}
