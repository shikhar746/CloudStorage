import { describe, it, expect } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import app from '../src/app.js'
import { fakeDb, seedUser, seedFolder, seedFile, seedShare, useFreshDatabase } from './helpers.js'

describe('POST /api/share-links', () => {
  useFreshDatabase()

  it('creates a link for a resource the caller owns', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'report.pdf')

    const res = await request(app)
      .post('/api/share-links')
      .set('Cookie', owner.cookie)
      .send({ resourceType: 'file', resourceId: file.id })

    expect(res.status).toBe(201)
    expect(res.body.link.token).toBeTruthy()
    expect(res.body.link.has_password).toBe(false)
    expect(res.body.link.expires_at).toBeNull()
  })

  it('never returns the password hash', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'secret.txt')

    const res = await request(app)
      .post('/api/share-links')
      .set('Cookie', owner.cookie)
      .send({ resourceType: 'file', resourceId: file.id, password: 'letmein' })

    expect(res.status).toBe(201)
    expect(res.body.link.has_password).toBe(true)
    expect(res.body.link.password_hash).toBeUndefined()
    // but it is stored, and stored hashed
    const row = fakeDb.rows('share_links')[0]!
    expect(row.password_hash).not.toBe('letmein')
    expect(bcrypt.compareSync('letmein', row.password_hash as string)).toBe(true)
  })

  it('turns expiresInDays into a timestamp', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'doc.txt')

    const res = await request(app)
      .post('/api/share-links')
      .set('Cookie', owner.cookie)
      .send({ resourceType: 'file', resourceId: file.id, expiresInDays: 7 })

    const expires = new Date(res.body.link.expires_at).getTime()
    const expected = Date.now() + 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(expires - expected)).toBeLessThan
      (60 * 1000)
  })

  it('issues a distinct token per link', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'doc.txt')

    const first = await request(app)
      .post('/api/share-links')
      .set('Cookie', owner.cookie)
      .send({ resourceType: 'file', resourceId: file.id })
    const second = await request(app)
      .post('/api/share-links')
      .set('Cookie', owner.cookie)
      .send({ resourceType: 'file', resourceId: file.id })

    expect(first.body.link.token).not.toBe(second.body.link.token)
  })

  it('404s for an editor — publishing is the owner’s call alone', async () => {
    const owner = seedUser()
    const editor = seedUser()
    const folder = seedFolder(owner, 'Shared')
    seedShare(owner, editor, 'folder', folder.id, 'editor')

    const res = await request(app)
      .post('/api/share-links')
      .set('Cookie', editor.cookie)
      .send({ resourceType: 'folder', resourceId: folder.id })

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND')
  })

  it('404s for a stranger', async () => {
    const owner = seedUser()
    const stranger = seedUser()
    const file = seedFile(owner, 'private.txt')

    const res = await request(app)
      .post('/api/share-links')
      .set('Cookie', stranger.cookie)
      .send({ resourceType: 'file', resourceId: file.id })

    expect(res.status).toBe(404)
  })

  it('400s on a password below the minimum length', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'doc.txt')

    const res = await request(app)
      .post('/api/share-links')
      .set('Cookie', owner.cookie)
      .send({ resourceType: 'file', resourceId: file.id, password: 'ab' })

    expect(res.status).toBe(400)
  })

  it('401s without a session', async () => {
    const res = await request(app)
      .post('/api/share-links')
      .send({ resourceType: 'file', resourceId: '00000000-0000-4000-8000-000000000001' })

    expect(res.status).toBe(401)
  })
})

describe('GET /api/share-links/:resourceType/:resourceId', () => {
  useFreshDatabase()

  it('lists the owner’s links newest first, without hashes', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'doc.txt')
    fakeDb.seed('share_links', [
      { token: 'older', resource_type: 'file', resource_id: file.id, created_by: owner.id },
      {
        token: 'newer',
        resource_type: 'file',
        resource_id: file.id,
        created_by: owner.id,
        password_hash: 'hashed',
      },
    ])

    const res = await request(app)
      .get(`/api/share-links/file/${file.id}`)
      .set('Cookie', owner.cookie)

    expect(res.status).toBe(200)
    expect(res.body.links.map((l: { token: string }) => l.token)).toEqual(['newer', 'older'])
    expect(res.body.links[0].has_password).toBe(true)
    expect(res.body.links[0].password_hash).toBeUndefined()
  })

  it('400s on an unknown resource type', async () => {
    const owner = seedUser()

    const res = await request(app)
      .get('/api/share-links/bogus/00000000-0000-4000-8000-000000000001')
      .set('Cookie', owner.cookie)

    expect(res.status).toBe(400)
  })

  it('404s for someone who is not the owner', async () => {
    const owner = seedUser()
    const stranger = seedUser()
    const file = seedFile(owner, 'doc.txt')

    const res = await request(app)
      .get(`/api/share-links/file/${file.id}`)
      .set('Cookie', stranger.cookie)

    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/share-links/:id', () => {
  useFreshDatabase()

  it('revokes a link the caller created', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'doc.txt')
    const [link] = fakeDb.seed('share_links', [
      { token: 'revoke-me', resource_type: 'file', resource_id: file.id, created_by: owner.id },
    ])

    const res = await request(app)
      .delete(`/api/share-links/${link!.id}`)
      .set('Cookie', owner.cookie)

    expect(res.status).toBe(200)
    expect(fakeDb.rows('share_links')).toHaveLength(0)
  })

  it('404s for a link created by someone else and leaves it in place', async () => {
    const owner = seedUser()
    const stranger = seedUser()
    const file = seedFile(owner, 'doc.txt')
    const [link] = fakeDb.seed('share_links', [
      { token: 'not-yours', resource_type: 'file', resource_id: file.id, created_by: owner.id },
    ])

    const res = await request(app)
      .delete(`/api/share-links/${link!.id}`)
      .set('Cookie', stranger.cookie)

    expect(res.status).toBe(404)
    expect(fakeDb.rows('share_links')).toHaveLength(1)
  })

  it('404s for a link that does not exist', async () => {
    const owner = seedUser()

    const res = await request(app)
      .delete('/api/share-links/00000000-0000-4000-8000-000000009999')
      .set('Cookie', owner.cookie)

    expect(res.status).toBe(404)
  })
})
