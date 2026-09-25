import { supabase } from './supabase.js'
import { env } from '../config/env.js'
import { hardDeleteResources, type FileRef, type HardDeleteResult } from './hardDelete.js'

export type PurgeResult = HardDeleteResult

/**
 * Permanently removes trash older than the retention window.
 *
 * This only decides *what* has expired. The removal itself — blobs before rows,
 * stars after both — lives in `hardDeleteResources`, shared with the two
 * user-driven delete paths, because getting that order wrong leaks storage in
 * a way no read path would ever surface.
 */
export async function purgeExpiredTrash(): Promise<PurgeResult> {
  const cutoff = new Date(
    Date.now() - env.TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  const [{ data: expiredFolders, error: folderError }, { data: expiredFiles, error: fileError }] =
    await Promise.all([
      supabase
        .from('folders')
        .select('id')
        .eq('is_deleted', true)
        .lt('deleted_at', cutoff),
      supabase
        .from('files')
        .select('id, storage_key')
        .eq('is_deleted', true)
        .lt('deleted_at', cutoff),
    ])

  if (folderError) throw new Error(`purge folder lookup failed: ${folderError.message}`)
  if (fileError) throw new Error(`purge file lookup failed: ${fileError.message}`)

  // deliberately not scoped to an owner: the sweeper runs for everyone
  return hardDeleteResources({
    folderIds: (expiredFolders ?? []).map((folder) => folder.id as string),
    files: (expiredFiles ?? []) as FileRef[],
  })
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
