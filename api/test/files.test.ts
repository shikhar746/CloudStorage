import { describe, it, expect, vi, afterEach } from 'vitest'
import request from 'supertest'
import app from '../src/app.js'
import {
  fakeDb,
  seedUser,
  seedFolder,
  seedFile,
  seedShare,
  trash,
  useFreshDatabase,
} from './helpers.js'

function fileRow(id: string) {
  return fakeDb.rows('files').find((row) => row.id === id)
}

describe('GET /api/files', () => {
  useFreshDatabase()

  it('lists the caller’s root files only', async () => {
    const user = seedUser()
    const other = seedUser()
    const folder = seedFolder(user, 'Folder')
    seedFile(user, 'root.txt')
    seedFile(user, 'nested.txt', folder.id)
    seedFile(other, 'theirs.txt')

    const res = await request(app).get('/api/files').set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual(['root.txt'])
  })

  it('lists files inside a folder the caller may see', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const folder = seedFolder(owner, 'Shared')
    seedFile(owner, 'inside.txt', folder.id)
    seedShare(owner, grantee, 'folder', folder.id, 'viewer')

    const res = await request(app)
      .get(`/api/files?folderId=${folder.id}`)
      .set('Cookie', grantee.cookie)

    expect(res.status).toBe(200)
    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual(['inside.txt'])
  })

  it('404s for a folder the caller may not see', async () => {
    const owner = seedUser()
    const stranger = seedUser()
    const folder = seedFolder(owner, 'Private')

    const res = await request(app)
      .get(`/api/files?folderId=${folder.id}`)
      .set('Cookie', stranger.cookie)

    expect(res.status).toBe(404)
  })

  it('marks starred files', async () => {
    const user = seedUser()
    const file = seedFile(user, 'starred.txt')
    fakeDb.seed('stars', [{ user_id: user.id, resource_type: 'file', resource_id: file.id }])

    const res = await request(app).get('/api/files').set('Cookie', user.cookie)

    expect(res.body.files[0].starred).toBe(true)
  })

  it('ignores a repeated folderId rather than filtering by an array', async () => {
    const user = seedUser()
    seedFile(user, 'root.txt')

    const res = await request(app).get('/api/files?folderId=a&folderId=b').set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual(['root.txt'])
  })
})

describe('GET /api/files/:id', () => {
  useFreshDatabase()

  it('returns the file with a signed URL and never the storage key', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')

    const res = await request(app).get(`/api/files/${file.id}`).set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body.file.name).toBe('doc.txt')
    expect(res.body.file.storage_key).toBeUndefined()
    expect(res.body.signedUrl).toContain('https://storage.test/')
    expect(res.body.role).toBe('owner')
  })

  it('404s for a file the caller cannot see', async () => {
    const owner = seedUser()
    const stranger = seedUser()
    const file = seedFile(owner, 'private.txt')

    const res = await request(app).get(`/api/files/${file.id}`).set('Cookie', stranger.cookie)

    expect(res.status).toBe(404)
  })

  it('404s when the blob is missing, rather than returning a broken URL', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeDb.objects.delete(file.storageKey)

    const res = await request(app).get(`/api/files/${file.id}`).set('Cookie', user.cookie)

    expect(res.status).toBe(404)
    vi.restoreAllMocks()
  })
})

describe('PATCH /api/files/:id', () => {
  useFreshDatabase()

  it('renames a file', async () => {
    const user = seedUser()
    const file = seedFile(user, 'old.txt')

    const res = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Cookie', user.cookie)
      .send({ name: 'new.txt' })

    expect(res.status).toBe(200)
    expect(res.body.file.name).toBe('new.txt')
  })

  it('moves a file into a folder the caller may edit', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Target')
    const file = seedFile(user, 'doc.txt')

    const res = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Cookie', user.cookie)
      .send({ folderId: folder.id })

    expect(res.status).toBe(200)
    expect(fileRow(file.id)!.folder_id).toBe(folder.id)
  })

  it('404s when moving into a folder the caller may not edit', async () => {
    const user = seedUser()
    const other = seedUser()
    const folder = seedFolder(other, 'Theirs')
    const file = seedFile(user, 'doc.txt')

    const res = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Cookie', user.cookie)
      .send({ folderId: folder.id })

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('FOLDER_NOT_FOUND')
  })

  it('lets the owner move a file back to the root', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Folder')
    const file = seedFile(user, 'doc.txt', folder.id)

    const res = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Cookie', user.cookie)
      .send({ folderId: null })

    expect(res.status).toBe(200)
    expect(fileRow(file.id)!.folder_id).toBeNull()
  })

  it('lets an editor rename a file in a shared folder', async () => {
    const owner = seedUser()
    const editor = seedUser()
    const folder = seedFolder(owner, 'Shared')
    const file = seedFile(owner, 'doc.txt', folder.id)
    seedShare(owner, editor, 'folder', folder.id, 'editor')

    const res = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Cookie', editor.cookie)
      .send({ name: 'renamed.txt' })

    expect(res.status).toBe(200)
  })

  it('does not let an editor move a shared file out to the root', async () => {
    // Same rule as folders: the root in question is the owner's, and the move
    // would take the file out of the share the editor reached it through.
    const owner = seedUser()
    const editor = seedUser()
    const folder = seedFolder(owner, 'Shared')
    const file = seedFile(owner, 'doc.txt', folder.id)
    seedShare(owner, editor, 'folder', folder.id, 'editor')

    const res = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Cookie', editor.cookie)
      .send({ folderId: null })

    expect(res.status).toBe(404)
    expect(fileRow(file.id)!.folder_id).toBe(folder.id)
  })

  it('404s when a viewer tries to rename', async () => {
    const owner = seedUser()
    const viewer = seedUser()
    const folder = seedFolder(owner, 'Shared')
    const file = seedFile(owner, 'doc.txt', folder.id)
    seedShare(owner, viewer, 'folder', folder.id, 'viewer')

    const res = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Cookie', viewer.cookie)
      .send({ name: 'nope.txt' })

    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/files/:id', () => {
  useFreshDatabase()

  it('soft-deletes and stamps deleted_at', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')

    const res = await request(app).delete(`/api/files/${file.id}`).set('Cookie', user.cookie)

    expect(res.status).toBe(204)
    expect(fileRow(file.id)!.is_deleted).toBe(true)
    expect(fileRow(file.id)!.deleted_at).toBeTruthy()
    // the blob survives a soft delete, so a restore can bring the file back
    expect(fakeDb.objects.has(file.storageKey)).toBe(true)
  })

  it('404s for a file the caller does not own, even as editor', async () => {
    const owner = seedUser()
    const editor = seedUser()
    const folder = seedFolder(owner, 'Shared')
    const file = seedFile(owner, 'doc.txt', folder.id)
    seedShare(owner, editor, 'folder', folder.id, 'editor')

    const res = await request(app).delete(`/api/files/${file.id}`).set('Cookie', editor.cookie)

    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/files/:id/restore', () => {
  useFreshDatabase()

  it('restores a trashed file', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')
    trash('files', file.id)

    const res = await request(app)
      .patch(`/api/files/${file.id}/restore`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(fileRow(file.id)!.is_deleted).toBe(false)
    expect(fileRow(file.id)!.deleted_at).toBeNull()
  })

  it('restores to the root when the original folder is still trashed', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Folder')
    const file = seedFile(user, 'doc.txt', folder.id)
    trash('folders', folder.id)
    trash('files', file.id)

    const res = await request(app)
      .patch(`/api/files/${file.id}/restore`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(fileRow(file.id)!.folder_id).toBeNull()
  })

  it('404s for a file that is not in the trash', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')

    const res = await request(app)
      .patch(`/api/files/${file.id}/restore`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/files/:id/permanent', () => {
  useFreshDatabase()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes the row, the blob, and every star on it', async () => {
    const user = seedUser()
    const other = seedUser()
    const file = seedFile(user, 'doc.txt')
    trash('files', file.id)
    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'file', resource_id: file.id },
      { user_id: other.id, resource_type: 'file', resource_id: file.id },
    ])

    const res = await request(app)
      .delete(`/api/files/${file.id}/permanent`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(204)
    expect(fileRow(file.id)).toBeUndefined()
    expect(fakeDb.objects.has(file.storageKey)).toBe(false)
    expect(fakeDb.rows('stars')).toHaveLength(0)
  })

  it('still deletes the row when storage refuses, rather than getting stuck', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')
    trash('files', file.id)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeDb.failNext('__storage__')

    const res = await request(app)
      .delete(`/api/files/${file.id}/permanent`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(204)
    expect(fileRow(file.id)).toBeUndefined()
  })

  it('404s for a file that is not in the trash', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')

    const res = await request(app)
      .delete(`/api/files/${file.id}/permanent`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(404)
  })
})

describe('POST /api/files/upload-url and /complete', () => {
  useFreshDatabase()

  it('hands out a signed URL scoped to the caller and records it as pending', async () => {
    const user = seedUser()

    const res = await request(app)
      .post('/api/files/upload-url')
      .set('Cookie', user.cookie)
      .send({ sizeBytes: 2048 })

    expect(res.status).toBe(201)
    expect(res.body.storageKey.startsWith(`${user.id}/`)).toBe(true)
    expect(fakeDb.rows('pending_uploads')).toHaveLength(1)
  })

  it('413s for a file over the direct-upload ceiling', async () => {
    const user = seedUser()

    const res = await request(app)
      .post('/api/files/upload-url')
      .set('Cookie', user.cookie)
      .send({ sizeBytes: 6 * 1024 * 1024 * 1024 })

    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('FILE_TOO_LARGE')
  })

  it('records the row on complete and clears the pending entry', async () => {
    const user = seedUser()
    const ticket = await request(app)
      .post('/api/files/upload-url')
      .set('Cookie', user.cookie)
      .send({ sizeBytes: 2048 })
    // the browser PUTs straight to storage; emulate the object landing
    fakeDb.seedObject(ticket.body.storageKey, 2048, 'text/plain')

    const res = await request(app)
      .post('/api/files/complete')
      .set('Cookie', user.cookie)
      .send({ storageKey: ticket.body.storageKey, name: 'big.txt' })

    expect(res.status).toBe(201)
    expect(res.body.file.name).toBe('big.txt')
    // size and mime come from storage, not the client
    expect(res.body.file.size_bytes).toBe(2048)
    expect(res.body.file.mime_type).toBe('text/plain')
    expect(fakeDb.rows('pending_uploads')).toHaveLength(0)
  })

  it('403s for a storage key outside the caller’s own prefix', async () => {
    const user = seedUser()
    const other = seedUser()

    const res = await request(app)
      .post('/api/files/complete')
      .set('Cookie', user.cookie)
      .send({ storageKey: `${other.id}/stolen`, name: 'nope.txt' })

    expect(res.status).toBe(403)
  })

  it('404s for a key that was never issued', async () => {
    const user = seedUser()

    const res = await request(app)
      .post('/api/files/complete')
      .set('Cookie', user.cookie)
      .send({ storageKey: `${user.id}/never-issued`, name: 'nope.txt' })

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('UPLOAD_NOT_FOUND')
  })

  it('404s when nothing actually landed at the key', async () => {
    const user = seedUser()
    const ticket = await request(app)
      .post('/api/files/upload-url')
      .set('Cookie', user.cookie)
      .send({ sizeBytes: 2048 })

    const res = await request(app)
      .post('/api/files/complete')
      .set('Cookie', user.cookie)
      .send({ storageKey: ticket.body.storageKey, name: 'ghost.txt' })

    expect(res.status).toBe(404)
  })
})

describe('POST /api/files/upload', () => {
  useFreshDatabase()

  it('stores the blob and the row for a multipart upload', async () => {
    const user = seedUser()

    const res = await request(app)
      .post('/api/files/upload')
      .set('Cookie', user.cookie)
      .attach('file', Buffer.from('hello world'), 'hello.txt')

    expect(res.status).toBe(201)
    expect(res.body.file.name).toBe('hello.txt')
    expect(fakeDb.rows('files')).toHaveLength(1)
    expect(fakeDb.objects.size).toBe(1)
  })

  it('400s when no file is attached', async () => {
    const user = seedUser()

    const res = await request(app).post('/api/files/upload').set('Cookie', user.cookie)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('NO_FILE')
  })

  it('treats an empty folderId field as the root', async () => {
    const user = seedUser()

    const res = await request(app)
      .post('/api/files/upload')
      .set('Cookie', user.cookie)
      .field('folderId', '')
      .attach('file', Buffer.from('hello'), 'hello.txt')

    expect(res.status).toBe(201)
    expect(res.body.file.folder_id).toBeNull()
  })

  it('404s when uploading into a folder the caller may not edit', async () => {
    const user = seedUser()
    const other = seedUser()
    const folder = seedFolder(other, 'Theirs')

    const res = await request(app)
      .post('/api/files/upload')
      .set('Cookie', user.cookie)
      .field('folderId', folder.id)
      .attach('file', Buffer.from('hello'), 'hello.txt')

    expect(res.status).toBe(404)
  })

  it('removes the orphaned blob when the row insert fails', async () => {
    const user = seedUser()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeDb.failNext('files')

    const res = await request(app)
      .post('/api/files/upload')
      .set('Cookie', user.cookie)
      .attach('file', Buffer.from('hello'), 'hello.txt')

    expect(res.status).toBe(500)
    expect(fakeDb.objects.size).toBe(0)
  })
})
