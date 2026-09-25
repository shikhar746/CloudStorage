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

describe('POST /api/stars', () => {
  useFreshDatabase()

  it('stars a resource the caller owns', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')

    const res = await request(app)
      .post('/api/stars')
      .set('Cookie', user.cookie)
      .send({ resourceType: 'file', resourceId: file.id })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ starred: true })
    expect(fakeDb.rows('stars')).toHaveLength(1)
  })

  it('is idempotent — starring twice is not an error', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')
    const body = { resourceType: 'file', resourceId: file.id }

    await request(app).post('/api/stars').set('Cookie', user.cookie).send(body)
    const second = await request(app).post('/api/stars').set('Cookie', user.cookie).send(body)

    expect(second.status).toBe(201)
    expect(fakeDb.rows('stars')).toHaveLength(1)
  })

  it('stars something shared with the caller', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const folder = seedFolder(owner, 'Shared')
    seedShare(owner, grantee, 'folder', folder.id, 'viewer')

    const res = await request(app)
      .post('/api/stars')
      .set('Cookie', grantee.cookie)
      .send({ resourceType: 'folder', resourceId: folder.id })

    expect(res.status).toBe(201)
  })

  it('404s for a resource the caller cannot see', async () => {
    const owner = seedUser()
    const stranger = seedUser()
    const file = seedFile(owner, 'private.txt')

    const res = await request(app)
      .post('/api/stars')
      .set('Cookie', stranger.cookie)
      .send({ resourceType: 'file', resourceId: file.id })

    expect(res.status).toBe(404)
    expect(fakeDb.rows('stars')).toHaveLength(0)
  })

  it('400s on a bad resource type', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')

    const res = await request(app)
      .post('/api/stars')
      .set('Cookie', user.cookie)
      .send({ resourceType: 'banana', resourceId: file.id })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('400s on a resource id that is not a uuid', async () => {
    const user = seedUser()

    const res = await request(app)
      .post('/api/stars')
      .set('Cookie', user.cookie)
      .send({ resourceType: 'file', resourceId: 'not-a-uuid' })

    expect(res.status).toBe(400)
  })

  it('keeps one user’s star separate from another’s', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const folder = seedFolder(owner, 'Shared')
    seedShare(owner, grantee, 'folder', folder.id, 'viewer')
    const body = { resourceType: 'folder', resourceId: folder.id }

    await request(app).post('/api/stars').set('Cookie', owner.cookie).send(body)
    await request(app).post('/api/stars').set('Cookie', grantee.cookie).send(body)

    expect(fakeDb.rows('stars')).toHaveLength(2)
  })
})

describe('DELETE /api/stars/:resourceType/:resourceId', () => {
  useFreshDatabase()

  it('removes the caller’s own star', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')
    fakeDb.seed('stars', [{ user_id: user.id, resource_type: 'file', resource_id: file.id }])

    const res = await request(app)
      .delete(`/api/stars/file/${file.id}`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ starred: false })
    expect(fakeDb.rows('stars')).toHaveLength(0)
  })

  it('still works after the resource is trashed', async () => {
    // deliberately no access check on unstar: a star must be removable even
    // once the thing it points at is gone from view
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')
    fakeDb.seed('stars', [{ user_id: user.id, resource_type: 'file', resource_id: file.id }])
    trash('files', file.id)

    const res = await request(app)
      .delete(`/api/stars/file/${file.id}`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(fakeDb.rows('stars')).toHaveLength(0)
  })

  it('leaves another user’s star on the same resource alone', async () => {
    const owner = seedUser()
    const other = seedUser()
    const file = seedFile(owner, 'doc.txt')
    fakeDb.seed('stars', [
      { user_id: owner.id, resource_type: 'file', resource_id: file.id },
      { user_id: other.id, resource_type: 'file', resource_id: file.id },
    ])

    await request(app).delete(`/api/stars/file/${file.id}`).set('Cookie', owner.cookie)

    expect(fakeDb.rows('stars')).toHaveLength(1)
    expect(fakeDb.rows('stars')[0]!.user_id).toBe(other.id)
  })

  it('is idempotent — unstarring nothing succeeds', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')

    const res = await request(app)
      .delete(`/api/stars/file/${file.id}`)
      .set('Cookie', user.cookie)

    expect(res.status).toBe(200)
  })

  it('400s on a bad resource type in the path', async () => {
    const user = seedUser()

    const res = await request(app)
      .delete('/api/stars/banana/00000000-0000-4000-8000-000000000001')
      .set('Cookie', user.cookie)

    expect(res.status).toBe(400)
  })
})

describe('GET /api/stars', () => {
  useFreshDatabase()

  it('returns starred folders and files, newest star first', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Folder')
    const first = seedFile(user, 'first.txt')
    const second = seedFile(user, 'second.txt')

    // seeded in order, so created_at ascends and the response should reverse it
    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'file', resource_id: first.id },
      { user_id: user.id, resource_type: 'file', resource_id: second.id },
      { user_id: user.id, resource_type: 'folder', resource_id: folder.id },
    ])

    const res = await request(app).get('/api/stars').set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual([
      'second.txt',
      'first.txt',
    ])
    expect(res.body.folders.map((f: { name: string }) => f.name)).toEqual(['Folder'])
  })

  it('marks every returned row as starred', async () => {
    const user = seedUser()
    const file = seedFile(user, 'doc.txt')
    fakeDb.seed('stars', [{ user_id: user.id, resource_type: 'file', resource_id: file.id }])

    const res = await request(app).get('/api/stars').set('Cookie', user.cookie)

    expect(res.body.files[0].starred).toBe(true)
  })

  it('hides resources that have since been trashed', async () => {
    const user = seedUser()
    const kept = seedFile(user, 'kept.txt')
    const gone = seedFile(user, 'gone.txt')
    fakeDb.seed('stars', [
      { user_id: user.id, resource_type: 'file', resource_id: kept.id },
      { user_id: user.id, resource_type: 'file', resource_id: gone.id },
    ])
    trash('files', gone.id)

    const res = await request(app).get('/api/stars').set('Cookie', user.cookie)

    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual(['kept.txt'])
  })

  it('hides a shared resource once the share is revoked', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const folder = seedFolder(owner, 'Shared')
    fakeDb.seed('stars', [
      { user_id: grantee.id, resource_type: 'folder', resource_id: folder.id },
    ])
    // no share row at all: the star outlived the grant
    const res = await request(app).get('/api/stars').set('Cookie', grantee.cookie)

    expect(res.body.folders).toEqual([])
  })

  it('still shows a shared resource while the share stands', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const folder = seedFolder(owner, 'Shared')
    seedShare(owner, grantee, 'folder', folder.id, 'viewer')
    fakeDb.seed('stars', [
      { user_id: grantee.id, resource_type: 'folder', resource_id: folder.id },
    ])

    const res = await request(app).get('/api/stars').set('Cookie', grantee.cookie)

    expect(res.body.folders.map((f: { name: string }) => f.name)).toEqual(['Shared'])
  })

  it('ignores stars belonging to other users', async () => {
    const user = seedUser()
    const other = seedUser()
    const file = seedFile(other, 'theirs.txt')
    fakeDb.seed('stars', [{ user_id: other.id, resource_type: 'file', resource_id: file.id }])

    const res = await request(app).get('/api/stars').set('Cookie', user.cookie)

    expect(res.body).toEqual({ folders: [], files: [] })
  })

  it('returns empty lists when nothing is starred', async () => {
    const user = seedUser()

    const res = await request(app).get('/api/stars').set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ folders: [], files: [] })
  })
})
