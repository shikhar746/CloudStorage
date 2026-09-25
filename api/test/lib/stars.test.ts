import { describe, it, expect, vi, afterEach } from 'vitest'
import { attachStarred, deleteStarsFor } from '../../src/lib/stars.js'
import { fakeDb, seedUser, seedFolder, seedFile, useFreshDatabase } from '../helpers.js'

describe('attachStarred', () => {
  useFreshDatabase()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks only the rows this user starred', async () => {
    const user = seedUser()
    const other = seedUser()
    const starredFolder = seedFolder(user, 'Starred')
    const plainFolder = seedFolder(user, 'Plain')
    const starredFile = seedFile(user, 'starred.txt')
    const plainFile = seedFile(user, 'plain.txt')

    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'folder', resource_id: starredFolder.id },
      { user_id: user.id, resource_type: 'file', resource_id: starredFile.id },
      // another user's star on the same folder must not leak across
      { user_id: other.id, resource_type: 'folder', resource_id: plainFolder.id },
    ])

    const result = await attachStarred(
      user.id,
      [{ id: starredFolder.id }, { id: plainFolder.id }],
      [{ id: starredFile.id }, { id: plainFile.id }]
    )

    expect(result.folders).toEqual([
      { id: starredFolder.id, starred: true },
      { id: plainFolder.id, starred: false },
    ])
    expect(result.files).toEqual([
      { id: starredFile.id, starred: true },
      { id: plainFile.id, starred: false },
    ])
  })

  it('does not confuse a file and a folder that share an id', async () => {
    const user = seedUser()
    const sharedId = '00000000-0000-4000-8000-aaaaaaaaaaaa'

    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'folder', resource_id: sharedId },
    ])

    const result = await attachStarred(user.id, [{ id: sharedId }], [{ id: sharedId }])

    expect(result.folders[0]!.starred).toBe(true)
    expect(result.files[0]!.starred).toBe(false)
  })

  it('asks the database nothing when there are no rows to mark', async () => {
    const user = seedUser()
    const spy = vi.spyOn(fakeDb, 'from')

    const result = await attachStarred(user.id, [], [])

    expect(spy).not.toHaveBeenCalled()
    expect(result).toEqual({ folders: [], files: [] })
  })

  it('degrades to unstarred rather than failing the listing', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Photos')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeDb.failNext('stars')

    const result = await attachStarred(user.id, [{ id: folder.id }], [])

    expect(result.folders).toEqual([{ id: folder.id, starred: false }])
  })

  it('preserves extra columns on the rows it is given', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Photos')

    const result = await attachStarred(user.id, [{ id: folder.id, name: 'Photos' }], [])

    expect(result.folders[0]).toEqual({ id: folder.id, name: 'Photos', starred: false })
  })
})

describe('deleteStarsFor', () => {
  useFreshDatabase()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('drops every user’s star on the given resources', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const file = seedFile(owner, 'shared.txt')

    fakeDb.seed('stars', [
      { user_id: owner.id, resource_type: 'file', resource_id: file.id },
      { user_id: grantee.id, resource_type: 'file', resource_id: file.id },
    ])

    await deleteStarsFor('file', [file.id])

    expect(fakeDb.rows('stars')).toHaveLength(0)
  })

  it('leaves stars of the other resource type alone', async () => {
    const user = seedUser()
    const id = '00000000-0000-4000-8000-bbbbbbbbbbbb'
    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'file', resource_id: id },
      { user_id: user.id, resource_type: 'folder', resource_id: id },
    ])

    await deleteStarsFor('file', [id])

    expect(fakeDb.rows('stars')).toHaveLength(1)
    expect(fakeDb.rows('stars')[0]!.resource_type).toBe('folder')
  })

  it('does nothing for an empty list', async () => {
    const spy = vi.spyOn(fakeDb, 'from')
    await deleteStarsFor('file', [])
    expect(spy).not.toHaveBeenCalled()
  })

  it('batches large id lists instead of one huge filter', async () => {
    const user = seedUser()
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)
    fakeDb.seed(
      'stars',
      ids.map((id) => ({ user_id: user.id, resource_type: 'file', resource_id: id }))
    )
    const spy = vi.spyOn(fakeDb, 'from')

    await deleteStarsFor('file', ids)

    // 250 ids at 100 per batch
    expect(spy).toHaveBeenCalledTimes(3)
    expect(fakeDb.rows('stars')).toHaveLength(0)
  })

  it('logs and continues when the cleanup query fails', async () => {
    const user = seedUser()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'file', resource_id: 'some-file' },
    ])
    fakeDb.failNext('stars')

    await expect(deleteStarsFor('file', ['some-file'])).resolves.toBeUndefined()
    expect(errorLog).toHaveBeenCalled()
  })
})
