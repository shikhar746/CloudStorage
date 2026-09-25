import { describe, it, expect, vi, afterEach } from 'vitest'
import { purgeExpiredTrash, startTrashPurgeSchedule } from '../../src/lib/purge.js'
import { fakeDb, seedUser, seedFolder, seedFile, trash, useFreshDatabase } from '../helpers.js'

const EXPIRED = 40 // days ago, past the 30-day test retention
const FRESH = 2

describe('purgeExpiredTrash', () => {
  useFreshDatabase()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes trash past the retention window', async () => {
    const user = seedUser()
    const file = seedFile(user, 'old.txt')
    trash('files', file.id, EXPIRED)

    const result = await purgeExpiredTrash()

    expect(result).toEqual({ folders: 0, files: 1, blobs: 1 })
    expect(fakeDb.rows('files')).toHaveLength(0)
    expect(fakeDb.objects.has(file.storageKey)).toBe(false)
  })

  it('leaves trash that is still inside the window', async () => {
    const user = seedUser()
    const file = seedFile(user, 'recent.txt')
    trash('files', file.id, FRESH)

    const result = await purgeExpiredTrash()

    expect(result.files).toBe(0)
    expect(fakeDb.rows('files')).toHaveLength(1)
    expect(fakeDb.objects.has(file.storageKey)).toBe(true)
  })

  it('never touches live rows', async () => {
    const user = seedUser()
    const live = seedFile(user, 'live.txt')
    const folder = seedFolder(user, 'Live')

    await purgeExpiredTrash()

    expect(fakeDb.rows('files')).toHaveLength(1)
    expect(fakeDb.rows('folders')).toHaveLength(1)
    expect(fakeDb.objects.has(live.storageKey)).toBe(true)
    expect(folder.id).toBeTruthy()
  })

  it('collects blobs of files under an expiring folder, trashed or not', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Expiring')
    // never individually trashed: it disappears through the folder cascade, so
    // its blob has to be collected before the row goes
    const nested = seedFile(user, 'nested.txt', folder.id)
    trash('folders', folder.id, EXPIRED)

    const result = await purgeExpiredTrash()

    expect(fakeDb.objects.has(nested.storageKey)).toBe(false)
    expect(fakeDb.rows('files')).toHaveLength(0)
    expect(fakeDb.rows('folders')).toHaveLength(0)
    expect(result.blobs).toBe(1)
  })

  it('deletes blobs before the rows that point at them', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Expiring')
    seedFile(user, 'nested.txt', folder.id)
    trash('folders', folder.id, EXPIRED)

    // the row count at the moment storage is first asked to delete: if the rows
    // went first, the storage keys could never have been looked up
    let rowsWhenBlobsRemoved = -1
    const storage = fakeDb.storage
    vi.spyOn(fakeDb, 'storage', 'get').mockImplementation(() => ({
      from(bucket: string) {
        const real = storage.from(bucket)
        return {
          ...real,
          async remove(keys: string[]) {
            if (rowsWhenBlobsRemoved === -1) rowsWhenBlobsRemoved = fakeDb.rows('files').length
            return real.remove(keys)
          },
        }
      },
    }) as unknown as typeof fakeDb.storage)

    await purgeExpiredTrash()

    expect(rowsWhenBlobsRemoved).toBe(1)
  })

  it('drops stars pointing at purged files and folders', async () => {
    const user = seedUser()
    const other = seedUser()
    const folder = seedFolder(user, 'Expiring')
    const nested = seedFile(user, 'nested.txt', folder.id)
    const loose = seedFile(user, 'loose.txt')
    trash('folders', folder.id, EXPIRED)
    trash('files', loose.id, EXPIRED)

    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'folder', resource_id: folder.id },
      { user_id: user.id, resource_type: 'file', resource_id: nested.id },
      { user_id: other.id, resource_type: 'file', resource_id: loose.id },
    ])

    await purgeExpiredTrash()

    expect(fakeDb.rows('stars')).toHaveLength(0)
  })

  it('keeps stars on resources that survived the sweep', async () => {
    const user = seedUser()
    const keep = seedFile(user, 'keep.txt')
    const go = seedFile(user, 'go.txt')
    trash('files', go.id, EXPIRED)

    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'file', resource_id: keep.id },
      { user_id: user.id, resource_type: 'file', resource_id: go.id },
    ])

    await purgeExpiredTrash()

    expect(fakeDb.rows('stars').map((s) => s.resource_id)).toEqual([keep.id])
  })

  it('batches storage deletes instead of sending one huge list', async () => {
    const user = seedUser()
    for (let i = 0; i < 250; i++) {
      const file = seedFile(user, `old-${i}.txt`)
      trash('files', file.id, EXPIRED)
    }

    await purgeExpiredTrash()

    expect(fakeDb.removeBatches).toHaveLength(3)
    expect(fakeDb.removeBatches.every((batch) => batch.length <= 100)).toBe(true)
    expect(fakeDb.objects.size).toBe(0)
  })

  it('still deletes the rows when storage refuses', async () => {
    const user = seedUser()
    const file = seedFile(user, 'old.txt')
    trash('files', file.id, EXPIRED)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeDb.failNext('__storage__')

    const result = await purgeExpiredTrash()

    expect(errorLog).toHaveBeenCalled()
    expect(result.files).toBe(1)
    expect(fakeDb.rows('files')).toHaveLength(0)
  })

  it('throws when the lookup itself fails, so the caller can report it', async () => {
    fakeDb.failNext('folders')
    await expect(purgeExpiredTrash()).rejects.toThrow(/purge folder lookup failed/)
  })

  it('counts what it scheduled for deletion', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Expiring')
    seedFile(user, 'nested.txt', folder.id)
    const loose = seedFile(user, 'loose.txt')
    trash('folders', folder.id, EXPIRED)
    trash('files', loose.id, EXPIRED)

    const result = await purgeExpiredTrash()

    expect(result).toEqual({ folders: 1, files: 1, blobs: 2 })
  })
})

describe('startTrashPurgeSchedule', () => {
  useFreshDatabase()

  it('stays off when the interval is zero', () => {
    // the test environment sets TRASH_PURGE_INTERVAL_MINUTES=0
    expect(startTrashPurgeSchedule()).toBe(false)
  })
})
