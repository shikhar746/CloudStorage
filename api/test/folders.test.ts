import { describe, it, expect } from 'vitest'
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

/** The rows the fake holds for a folder, for assertions about the cascade. */
function folderRow(id: string) {
  return fakeDb.rows('folders').find((row) => row.id === id)
}

function fileRow(id: string) {
  return fakeDb.rows('files').find((row) => row.id === id)
}

describe('GET /api/folders/root', () => {
  useFreshDatabase()

  it('lists only the caller’s own root items', async () => {
    const user = seedUser()
    const other = seedUser()
    seedFolder(user, 'Mine')
    seedFile(user, 'mine.txt')
    seedFolder(other, 'Theirs')
    seedFile(other, 'theirs.txt')

    const res = await request(app).get('/api/folders/root').set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body.folder).toBeNull()
    expect(res.body.role).toBe('owner')
    expect(res.body.children.folders.map((f: { name: string }) => f.name)).toEqual(['Mine'])
    expect(res.body.children.files.map((f: { name: string }) => f.name)).toEqual(['mine.txt'])
  })

  it('hides trashed items', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Gone')
    trash('folders', folder.id)

    const res = await request(app).get('/api/folders/root').set('Cookie', user.cookie)

    expect(res.body.children.folders).toEqual([])
  })

  it('marks starred items', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Starred')
    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'folder', resource_id: folder.id },
    ])

    const res = await request(app).get('/api/folders/root').set('Cookie', user.cookie)

    expect(res.body.children.folders[0].starred).toBe(true)
  })

  it('rejects an unauthenticated caller', async () => {
    const res = await request(app).get('/api/folders/root')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/folders/:id', () => {
  useFreshDatabase()

  it('returns the folder, its children, and the caller’s role', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Trip')
    seedFolder(user, 'Photos', folder.id)
    seedFile(user, 'itinerary.txt', folder.id)

    const res = await request(app).get(`/api/folders/${folder.id}`).set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body.folder.name).toBe('Trip')
    expect(res.body.role).toBe('owner')
    expect(res.body.children.folders).toHaveLength(1)
    expect(res.body.children.files).toHaveLength(1)
  })

  it('reports the inherited role inside a shared folder', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const top = seedFolder(owner, 'Shared')
    const inner = seedFolder(owner, 'Inner', top.id)
    seedShare(owner, grantee, 'folder', top.id, 'editor')

    const res = await request(app).get(`/api/folders/${inner.id}`).set('Cookie', grantee.cookie)

    expect(res.status).toBe(200)
    expect(res.body.role).toBe('editor')
  })

  it('404s for a folder the caller cannot see', async () => {
    const owner = seedUser()
    const stranger = seedUser()
    const folder = seedFolder(owner, 'Private')

    const res = await request(app).get(`/api/folders/${folder.id}`).set('Cookie', stranger.cookie)

    expect(res.status).toBe(404)
  })
})

describe('POST /api/folders', () => {
  useFreshDatabase()

  it('creates a folder at the root', async () => {
    const user = seedUser()

    const res = await request(app)
      .post('/api/folders')
      .set('Cookie', user.cookie)
      .send({ name: 'New' })

    expect(res.status).toBe(201)
    expect(res.body.folder.name).toBe('New')
    expect(res.body.folder.parent_id).toBeNull()
  })

  it('409s on a duplicate name in the same parent', async () => {
    const user = seedUser()
    seedFolder(user, 'Reports')

    const res = await request(app)
      .post('/api/folders')
      .set('Cookie', user.cookie)
      .send({ name: 'Reports' })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('FOLDER_EXISTS')
  })

  it('lets an editor create a subfolder in a shared folder', async () => {
    const owner = seedUser()
    const editor = seedUser()
    const shared = seedFolder(owner, 'Shared')
    seedShare(owner, editor, 'folder', shared.id, 'editor')

    const res = await request(app)
      .post('/api/folders')
      .set('Cookie', editor.cookie)
      .send({ name: 'From editor', parentId: shared.id })

    expect(res.status).toBe(201)
  })

  it('404s when a viewer tries to create a subfolder', async () => {
    const owner = seedUser()
    const viewer = seedUser()
    const shared = seedFolder(owner, 'Shared')
    seedShare(owner, viewer, 'folder', shared.id, 'viewer')

    const res = await request(app)
      .post('/api/folders')
      .set('Cookie', viewer.cookie)
      .send({ name: 'Nope', parentId: shared.id })

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('PARENT_NOT_FOUND')
  })

  it('400s on a missing name', async () => {
    const user = seedUser()
    const res = await request(app).post('/api/folders').set('Cookie', user.cookie).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('DELETE /api/folders/:id', () => {
  useFreshDatabase()

  it('soft-deletes the folder and every descendant at any depth', async () => {
    const user = seedUser()
    const top = seedFolder(user, 'Top')
    const middle = seedFolder(user, 'Middle', top.id)
    const deep = seedFolder(user, 'Deep', middle.id)
    const deepFile = seedFile(user, 'deep.txt', deep.id)
    const topFile = seedFile(user, 'top.txt', top.id)

    const res = await request(app).delete(`/api/folders/${top.id}`).set('Cookie', user.cookie)

    expect(res.status).toBe(204)
    for (const id of [top.id, middle.id, deep.id]) {
      expect(folderRow(id)!.is_deleted).toBe(true)
      expect(folderRow(id)!.deleted_at).toBeTruthy()
    }
    expect(fileRow(deepFile.id)!.is_deleted).toBe(true)
    expect(fileRow(topFile.id)!.is_deleted).toBe(true)
  })

  it('stamps one deleted_at across the whole cascade', async () => {
    const user = seedUser()
    const top = seedFolder(user, 'Top')
    const middle = seedFolder(user, 'Middle', top.id)

    await request(app).delete(`/api/folders/${top.id}`).set('Cookie', user.cookie)

    expect(folderRow(middle.id)!.deleted_at).toBe(folderRow(top.id)!.deleted_at)
  })

  it('leaves another owner’s folder of the same name alone', async () => {
    const user = seedUser()
    const other = seedUser()
    const mine = seedFolder(user, 'Shared name')
    const theirs = seedFolder(other, 'Shared name')

    await request(app).delete(`/api/folders/${mine.id}`).set('Cookie', user.cookie)

    expect(folderRow(theirs.id)!.is_deleted).toBe(false)
  })

  it('succeeds even when a trashed sibling already holds the same name', async () => {
    // Soft delete only flips is_deleted, and the unique index covers live rows
    // only, so this can never raise a unique violation.
    const user = seedUser()
    const first = seedFolder(user, 'Reports')
    trash('folders', first.id)
    const second = seedFolder(user, 'Reports')

    const res = await request(app).delete(`/api/folders/${second.id}`).set('Cookie', user.cookie)

    expect(res.status).toBe(204)
  })

  it('404s for a folder the caller does not own', async () => {
    const owner = seedUser()
    const editor = seedUser()
    const folder = seedFolder(owner, 'Shared')
    seedShare(owner, editor, 'folder', folder.id, 'editor')

    const res = await request(app).delete(`/api/folders/${folder.id}`).set('Cookie', editor.cookie)

    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/folders/:id/restore', () => {
  useFreshDatabase()

  it('restores the folder and its cascade-deleted descendants', async () => {
    const user = seedUser()
    const top = seedFolder(user, 'Top')
    const middle = seedFolder(user, 'Middle', top.id)
    const file = seedFile(user, 'nested.txt', middle.id)
    await request(app).delete(`/api/folders/${top.id}`).set('Cookie', user.cookie)

    const res = await request(app)
      .patch(`/api/folders/${top.id}/restore`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(204)
    expect(folderRow(top.id)!.is_deleted).toBe(false)
    expect(folderRow(middle.id)!.is_deleted).toBe(false)
    expect(folderRow(middle.id)!.deleted_at).toBeNull()
    expect(fileRow(file.id)!.is_deleted).toBe(false)
  })

  it('restores to the root when the original parent is still trashed', async () => {
    const user = seedUser()
    const parent = seedFolder(user, 'Parent')
    const child = seedFolder(user, 'Child', parent.id)
    // trash both, then restore only the child
    await request(app).delete(`/api/folders/${parent.id}`).set('Cookie', user.cookie)

    const res = await request(app)
      .patch(`/api/folders/${child.id}/restore`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(204)
    expect(folderRow(child.id)!.parent_id).toBeNull()
    expect(folderRow(parent.id)!.is_deleted).toBe(true)
  })

  it('409s when restoring would collide with a live name', async () => {
    const user = seedUser()
    const first = seedFolder(user, 'Reports')
    trash('folders', first.id)
    seedFolder(user, 'Reports')

    const res = await request(app)
      .patch(`/api/folders/${first.id}/restore`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NAME_CONFLICT')
  })

  it('404s for a folder that is not in the trash', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Live')

    const res = await request(app)
      .patch(`/api/folders/${folder.id}/restore`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(404)
  })
})

describe('GET /api/folders/trash', () => {
  useFreshDatabase()

  it('lists only what was trashed in its own right', async () => {
    const user = seedUser()
    const top = seedFolder(user, 'Top')
    seedFolder(user, 'Middle', top.id)
    seedFile(user, 'nested.txt', top.id)
    const loose = seedFile(user, 'loose.txt')
    await request(app).delete(`/api/folders/${top.id}`).set('Cookie', user.cookie)
    await request(app).delete(`/api/files/${loose.id}`).set('Cookie', user.cookie)

    const res = await request(app).get('/api/folders/trash').set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body.folders.map((f: { name: string }) => f.name)).toEqual(['Top'])
    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual(['loose.txt'])
  })
})

describe('DELETE /api/folders/:id/permanent', () => {
  useFreshDatabase()

  it('removes the subtree, its blobs, and every star on it', async () => {
    const user = seedUser()
    const other = seedUser()
    const top = seedFolder(user, 'Top')
    const middle = seedFolder(user, 'Middle', top.id)
    const file = seedFile(user, 'nested.txt', middle.id)
    await request(app).delete(`/api/folders/${top.id}`).set('Cookie', user.cookie)

    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'folder', resource_id: top.id },
      { user_id: other.id, resource_type: 'file', resource_id: file.id },
    ])

    const res = await request(app)
      .delete(`/api/folders/${top.id}/permanent`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(204)
    expect(fakeDb.rows('folders')).toHaveLength(0)
    expect(fakeDb.rows('files')).toHaveLength(0)
    expect(fakeDb.objects.has(file.storageKey)).toBe(false)
    expect(fakeDb.rows('stars')).toHaveLength(0)
  })

  it('batches storage deletes for a large subtree', async () => {
    const user = seedUser()
    const top = seedFolder(user, 'Top')
    for (let i = 0; i < 150; i++) seedFile(user, `f-${i}.txt`, top.id)
    await request(app).delete(`/api/folders/${top.id}`).set('Cookie', user.cookie)

    await request(app).delete(`/api/folders/${top.id}/permanent`).set('Cookie', user.cookie)

    expect(fakeDb.removeBatches.length).toBeGreaterThan(1)
    expect(fakeDb.removeBatches.every((batch) => batch.length <= 100)).toBe(true)
    expect(fakeDb.objects.size).toBe(0)
  })

  it('404s for a folder that is not in the trash', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Live')

    const res = await request(app)
      .delete(`/api/folders/${folder.id}/permanent`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/folders/trash', () => {
  useFreshDatabase()

  it('clears every trashed row, blob, and star for the caller', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Top')
    const nested = seedFile(user, 'nested.txt', folder.id)
    const loose = seedFile(user, 'loose.txt')
    await request(app).delete(`/api/folders/${folder.id}`).set('Cookie', user.cookie)
    await request(app).delete(`/api/files/${loose.id}`).set('Cookie', user.cookie)
    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'file', resource_id: nested.id },
      { user_id: user.id, resource_type: 'folder', resource_id: folder.id },
    ])

    const res = await request(app).delete('/api/folders/trash').set('Cookie', user.cookie)

    expect(res.status).toBe(204)
    expect(fakeDb.rows('folders')).toHaveLength(0)
    expect(fakeDb.rows('files')).toHaveLength(0)
    expect(fakeDb.objects.size).toBe(0)
    expect(fakeDb.rows('stars')).toHaveLength(0)
  })

  it('leaves live items and other users’ trash untouched', async () => {
    const user = seedUser()
    const other = seedUser()
    const live = seedFile(user, 'live.txt')
    const mineTrashed = seedFile(user, 'mine.txt')
    const theirsTrashed = seedFile(other, 'theirs.txt')
    trash('files', mineTrashed.id)
    trash('files', theirsTrashed.id)

    await request(app).delete('/api/folders/trash').set('Cookie', user.cookie)

    expect(fakeDb.rows('files').map((row) => row.id).sort()).toEqual(
      [live.id, theirsTrashed.id].sort()
    )
    expect(fakeDb.objects.has(theirsTrashed.storageKey)).toBe(true)
  })

  it('batches storage deletes when the trash is large', async () => {
    const user = seedUser()
    for (let i = 0; i < 150; i++) {
      const file = seedFile(user, `t-${i}.txt`)
      trash('files', file.id)
    }

    await request(app).delete('/api/folders/trash').set('Cookie', user.cookie)

    expect(fakeDb.removeBatches.length).toBeGreaterThan(1)
    expect(fakeDb.removeBatches.every((batch) => batch.length <= 100)).toBe(true)
    expect(fakeDb.objects.size).toBe(0)
  })
})

describe('PATCH /api/folders/:id', () => {
  useFreshDatabase()

  it('renames a folder', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Old')

    const res = await request(app)
      .patch(`/api/folders/${folder.id}`)
      .set('Cookie', user.cookie)
      .send({ name: 'New' })

    expect(res.status).toBe(200)
    expect(res.body.folder.name).toBe('New')
  })

  it('409s when the new name is taken in the same parent', async () => {
    const user = seedUser()
    seedFolder(user, 'Taken')
    const folder = seedFolder(user, 'Free')

    const res = await request(app)
      .patch(`/api/folders/${folder.id}`)
      .set('Cookie', user.cookie)
      .send({ name: 'Taken' })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('FOLDER_EXISTS')
  })

  it('moves a folder into another folder', async () => {
    const user = seedUser()
    const source = seedFolder(user, 'Source')
    const target = seedFolder(user, 'Target')

    const res = await request(app)
      .patch(`/api/folders/${source.id}`)
      .set('Cookie', user.cookie)
      .send({ parentId: target.id })

    expect(res.status).toBe(200)
    expect(folderRow(source.id)!.parent_id).toBe(target.id)
  })

  it('refuses to move a folder into itself', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Self')

    const res = await request(app)
      .patch(`/api/folders/${folder.id}`)
      .set('Cookie', user.cookie)
      .send({ parentId: folder.id })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_MOVE')
  })

  it('refuses to move a folder into its own descendant, however deep', async () => {
    const user = seedUser()
    const top = seedFolder(user, 'Top')
    const middle = seedFolder(user, 'Middle', top.id)
    const deep = seedFolder(user, 'Deep', middle.id)

    const res = await request(app)
      .patch(`/api/folders/${top.id}`)
      .set('Cookie', user.cookie)
      .send({ parentId: deep.id })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_MOVE')
  })

  it('lets the owner move a folder back to the root', async () => {
    const user = seedUser()
    const parent = seedFolder(user, 'Parent')
    const child = seedFolder(user, 'Child', parent.id)

    const res = await request(app)
      .patch(`/api/folders/${child.id}`)
      .set('Cookie', user.cookie)
      .send({ parentId: null })

    expect(res.status).toBe(200)
    expect(folderRow(child.id)!.parent_id).toBeNull()
  })

  it('lets an editor rename inside a shared folder', async () => {
    const owner = seedUser()
    const editor = seedUser()
    const shared = seedFolder(owner, 'Shared')
    const inner = seedFolder(owner, 'Inner', shared.id)
    seedShare(owner, editor, 'folder', shared.id, 'editor')

    const res = await request(app)
      .patch(`/api/folders/${inner.id}`)
      .set('Cookie', editor.cookie)
      .send({ name: 'Renamed by editor' })

    expect(res.status).toBe(200)
  })

  it('does not let an editor move a shared folder out to the root', async () => {
    // Moving to the root is still a move, and the destination is the owner's
    // root, not the editor's. Letting it through would pull the folder out of
    // the share it was reached through.
    const owner = seedUser()
    const editor = seedUser()
    const shared = seedFolder(owner, 'Shared')
    const inner = seedFolder(owner, 'Inner', shared.id)
    seedShare(owner, editor, 'folder', shared.id, 'editor')

    const res = await request(app)
      .patch(`/api/folders/${inner.id}`)
      .set('Cookie', editor.cookie)
      .send({ parentId: null })

    expect(res.status).toBe(404)
    expect(folderRow(inner.id)!.parent_id).toBe(shared.id)
  })

  it('404s when a viewer tries to rename', async () => {
    const owner = seedUser()
    const viewer = seedUser()
    const shared = seedFolder(owner, 'Shared')
    seedShare(owner, viewer, 'folder', shared.id, 'viewer')

    const res = await request(app)
      .patch(`/api/folders/${shared.id}`)
      .set('Cookie', viewer.cookie)
      .send({ name: 'Nope' })

    expect(res.status).toBe(404)
  })

  it('400s when no field is supplied', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Folder')

    const res = await request(app)
      .patch(`/api/folders/${folder.id}`)
      .set('Cookie', user.cookie)
      .send({})

    expect(res.status).toBe(400)
  })
})

describe('GET /api/folders/:id/path', () => {
  useFreshDatabase()

  it('returns the ancestor chain ending at the folder', async () => {
    const user = seedUser()
    const top = seedFolder(user, 'Top')
    const middle = seedFolder(user, 'Middle', top.id)
    const deep = seedFolder(user, 'Deep', middle.id)

    const res = await request(app).get(`/api/folders/${deep.id}/path`).set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body.path.map((p: { name: string }) => p.name)).toEqual(['Top', 'Middle', 'Deep'])
  })

  it('stops at the shared folder for someone working inside a share', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const top = seedFolder(owner, 'Owner root')
    const shared = seedFolder(owner, 'Shared', top.id)
    const inner = seedFolder(owner, 'Inner', shared.id)
    seedShare(owner, grantee, 'folder', shared.id, 'viewer')

    const res = await request(app)
      .get(`/api/folders/${inner.id}/path`)
      .set('Cookie', grantee.cookie)

    expect(res.body.path.map((p: { name: string }) => p.name)).toEqual(['Shared', 'Inner'])
  })
})
