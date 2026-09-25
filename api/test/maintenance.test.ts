import { describe, it, expect } from 'vitest'
import request from 'supertest'
import app from '../src/app.js'
import { fakeDb, seedUser, seedFile, trash, useFreshDatabase } from './helpers.js'

const SECRET = 'purge-secret-for-tests'

describe('POST /api/maintenance/purge-trash', () => {
  useFreshDatabase()

  it('runs the sweep when the shared secret matches', async () => {
    const user = seedUser()
    const file = seedFile(user, 'old.txt')
    trash('files', file.id, 40)

    const res = await request(app)
      .post('/api/maintenance/purge-trash')
      .set('x-purge-secret', SECRET)

    expect(res.status).toBe(200)
    expect(res.body.purged).toEqual({ folders: 0, files: 1, blobs: 1 })
    expect(res.body.retentionDays).toBe(30)
    expect(fakeDb.rows('files')).toHaveLength(0)
  })

  it('401s with no secret', async () => {
    const res = await request(app).post('/api/maintenance/purge-trash')
    expect(res.status).toBe(401)
  })

  it('401s with the wrong secret', async () => {
    const res = await request(app)
      .post('/api/maintenance/purge-trash')
      .set('x-purge-secret', 'wrong')

    expect(res.status).toBe(401)
  })

  it('401s on a secret that merely shares a prefix', async () => {
    const res = await request(app)
      .post('/api/maintenance/purge-trash')
      .set('x-purge-secret', SECRET.slice(0, -1))

    expect(res.status).toBe(401)
  })

  it('401s on a longer secret that starts with the real one', async () => {
    // the length check has to run before timingSafeEqual, which throws on a
    // length mismatch rather than returning false
    const res = await request(app)
      .post('/api/maintenance/purge-trash')
      .set('x-purge-secret', `${SECRET}extra`)

    expect(res.status).toBe(401)
  })

  it('needs no session cookie — a scheduler has none', async () => {
    const res = await request(app)
      .post('/api/maintenance/purge-trash')
      .set('x-purge-secret', SECRET)

    expect(res.status).toBe(200)
  })
})
