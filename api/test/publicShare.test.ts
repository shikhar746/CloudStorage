import { describe, it, expect } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import app from '../src/app.js'
import { fakeDb, seedUser, seedFolder, seedFile, trash, useFreshDatabase } from './helpers.js'
import type { TestUser } from './helpers.js'

const PASSWORD = 'letmein'

interface SeededLink {
  id: string
  token: string
}

function seedLink(
  creator: TestUser,
  resourceType: 'file' | 'folder',
  resourceId: string,
  overrides: Record<string, unknown> = {}
): SeededLink {
  const token = `token-${Math.random().toString(36).slice(2, 10)}`
  const [row] = fakeDb.seed('share_links', [
    { token, resource_type: resourceType, resource_id: resourceId, created_by: creator.id, ...overrides },
  ])
  return { id: row!.id as string, token: row!.token as string }
}

function withPassword(plain = PASSWORD): Record<string, unknown> {
  return { password_hash: bcrypt.hashSync(plain, 4) }
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

describe('GET /api/public/:token', () => {
  useFreshDatabase()

  it('names an unprotected file link', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'report.pdf')
    const link = seedLink(owner, 'file', file.id)

    const res = await request(app).get(`/api/public/${link.token}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      resourceType: 'file',
      requiresPassword: false,
      name: 'report.pdf',
      expiresAt: null,
    })
  })

  it('withholds the name while a password is required', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'salaries.xlsx')
    const link = seedLink(owner, 'file', file.id, withPassword())

    const res = await request(app).get(`/api/public/${link.token}`)

    expect(res.status).toBe(200)
    expect(res.body.requiresPassword).toBe(true)
    expect(res.body.name).toBeUndefined()
  })

  it('404s for a token that does not exist', async () => {
    const res = await request(app).get('/api/public/not-a-real-token')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('LINK_NOT_FOUND')
  })

  it('410s for an expired link', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'old.txt')
    const link = seedLink(owner, 'file', file.id, { expires_at: daysFromNow(-1) })

    const res = await request(app).get(`/api/public/${link.token}`)

    expect(res.status).toBe(410)
    expect(res.body.error.code).toBe('LINK_EXPIRED')
  })

  it('404s when the shared resource is gone', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'gone.txt')
    const link = seedLink(owner, 'file', file.id)
    trash('files', file.id)

    const res = await request(app).get(`/api/public/${link.token}`)

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('RESOURCE_GONE')
  })
})

describe('POST /api/public/:token/access', () => {
  useFreshDatabase()

  it('returns a signed URL for a file link', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'report.pdf')
    const link = seedLink(owner, 'file', file.id)

    const res = await request(app).post(`/api/public/${link.token}/access`).send({})

    expect(res.status).toBe(200)
    expect(res.body.resourceType).toBe('file')
    expect(res.body.signedUrl).toContain('https://storage.test/')
    expect(res.body.file.storage_key).toBeUndefined()
  })

  it('lists a folder link and presents the shared folder as the root', async () => {
    const owner = seedUser()
    const top = seedFolder(owner, 'Owner root')
    const shared = seedFolder(owner, 'Shared', top.id)
    seedFolder(owner, 'Inner', shared.id)
    seedFile(owner, 'inside.txt', shared.id)
    const link = seedLink(owner, 'folder', shared.id)

    const res = await request(app).post(`/api/public/${link.token}/access`).send({})

    expect(res.status).toBe(200)
    expect(res.body.resourceType).toBe('folder')
    expect(res.body.isRoot).toBe(true)
    // stripped at the share boundary, so the UI cannot navigate above it
    expect(res.body.folder.parent_id).toBeNull()
    expect(res.body.children.folders).toHaveLength(1)
    expect(res.body.children.files).toHaveLength(1)
  })

  it('401s without the password', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'secret.txt')
    const link = seedLink(owner, 'file', file.id, withPassword())

    const res = await request(app).post(`/api/public/${link.token}/access`).send({})

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_PASSWORD')
  })

  it('401s on the wrong password', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'secret.txt')
    const link = seedLink(owner, 'file', file.id, withPassword())

    const res = await request(app)
      .post(`/api/public/${link.token}/access`)
      .send({ password: 'guess' })

    expect(res.status).toBe(401)
  })

  it('opens with the right password', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'secret.txt')
    const link = seedLink(owner, 'file', file.id, withPassword())

    const res = await request(app)
      .post(`/api/public/${link.token}/access`)
      .send({ password: PASSWORD })

    expect(res.status).toBe(200)
    expect(res.body.file.name).toBe('secret.txt')
  })

  it('410s an expired link before asking for a password', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'old.txt')
    const link = seedLink(owner, 'file', file.id, {
      ...withPassword(),
      expires_at: daysFromNow(-1),
    })

    const res = await request(app)
      .post(`/api/public/${link.token}/access`)
      .send({ password: PASSWORD })

    expect(res.status).toBe(410)
  })

  it('records last_used_at on a successful open', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'report.pdf')
    const link = seedLink(owner, 'file', file.id)

    await request(app).post(`/api/public/${link.token}/access`).send({})
    // the touch is fire-and-forget, so let the microtask queue drain
    await new Promise((resolve) => setImmediate(resolve))

    const row = fakeDb.rows('share_links').find((candidate) => candidate.id === link.id)
    expect(row!.last_used_at).toBeTruthy()
  })

  it('ignores a session cookie entirely — the token is the only credential', async () => {
    const owner = seedUser()
    const stranger = seedUser()
    const file = seedFile(owner, 'secret.txt')
    const link = seedLink(owner, 'file', file.id, withPassword())

    const res = await request(app)
      .post(`/api/public/${link.token}/access`)
      .set('Cookie', stranger.cookie)
      .send({})

    expect(res.status).toBe(401)
  })

  it('400s on a malformed body', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'doc.txt')
    const link = seedLink(owner, 'file', file.id)

    const res = await request(app)
      .post(`/api/public/${link.token}/access`)
      .send({ password: 12345 })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('POST /api/public/:token/folder/:folderId', () => {
  useFreshDatabase()

  it('opens a subfolder of the shared folder', async () => {
    const owner = seedUser()
    const shared = seedFolder(owner, 'Shared')
    const inner = seedFolder(owner, 'Inner', shared.id)
    seedFile(owner, 'deep.txt', inner.id)
    const link = seedLink(owner, 'folder', shared.id)

    const res = await request(app).post(`/api/public/${link.token}/folder/${inner.id}`).send({})

    expect(res.status).toBe(200)
    expect(res.body.folder.name).toBe('Inner')
    expect(res.body.isRoot).toBe(false)
    expect(res.body.children.files).toHaveLength(1)
  })

  it('opens a folder nested several levels down', async () => {
    const owner = seedUser()
    const shared = seedFolder(owner, 'Shared')
    const middle = seedFolder(owner, 'Middle', shared.id)
    const deep = seedFolder(owner, 'Deep', middle.id)
    const link = seedLink(owner, 'folder', shared.id)

    const res = await request(app).post(`/api/public/${link.token}/folder/${deep.id}`).send({})

    expect(res.status).toBe(200)
    expect(res.body.folder.name).toBe('Deep')
  })

  it('404s for a folder outside the link’s scope', async () => {
    const owner = seedUser()
    const shared = seedFolder(owner, 'Shared')
    const unrelated = seedFolder(owner, 'Unrelated')
    const link = seedLink(owner, 'folder', shared.id)

    const res = await request(app).post(`/api/public/${link.token}/folder/${unrelated.id}`).send({})

    expect(res.status).toBe(404)
  })

  it('404s for an ancestor of the shared folder', async () => {
    const owner = seedUser()
    const top = seedFolder(owner, 'Top')
    const shared = seedFolder(owner, 'Shared', top.id)
    const link = seedLink(owner, 'folder', shared.id)

    const res = await request(app).post(`/api/public/${link.token}/folder/${top.id}`).send({})

    expect(res.status).toBe(404)
  })

  it('stops the scope walk at a trashed ancestor', async () => {
    const owner = seedUser()
    const shared = seedFolder(owner, 'Shared')
    const middle = seedFolder(owner, 'Middle', shared.id)
    const deep = seedFolder(owner, 'Deep', middle.id)
    const link = seedLink(owner, 'folder', shared.id)
    trash('folders', middle.id)

    const res = await request(app).post(`/api/public/${link.token}/folder/${deep.id}`).send({})

    expect(res.status).toBe(404)
  })

  it('400s when the link points at a file', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'doc.txt')
    const folder = seedFolder(owner, 'Folder')
    const link = seedLink(owner, 'file', file.id)

    const res = await request(app).post(`/api/public/${link.token}/folder/${folder.id}`).send({})

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('NOT_A_FOLDER')
  })

  it('enforces the password on every subfolder call, not just the first', async () => {
    const owner = seedUser()
    const shared = seedFolder(owner, 'Shared')
    const inner = seedFolder(owner, 'Inner', shared.id)
    const link = seedLink(owner, 'folder', shared.id, withPassword())

    const denied = await request(app).post(`/api/public/${link.token}/folder/${inner.id}`).send({})
    expect(denied.status).toBe(401)

    const allowed = await request(app)
      .post(`/api/public/${link.token}/folder/${inner.id}`)
      .send({ password: PASSWORD })
    expect(allowed.status).toBe(200)
  })
})

describe('POST /api/public/:token/file/:fileId', () => {
  useFreshDatabase()

  it('downloads the file a file link points at', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'report.pdf')
    const link = seedLink(owner, 'file', file.id)

    const res = await request(app).post(`/api/public/${link.token}/file/${file.id}`).send({})

    expect(res.status).toBe(200)
    expect(res.body.signedUrl).toContain('https://storage.test/')
    expect(res.body.file.storage_key).toBeUndefined()
  })

  it('downloads a file beneath a shared folder, however deep', async () => {
    const owner = seedUser()
    const shared = seedFolder(owner, 'Shared')
    const deep = seedFolder(owner, 'Deep', shared.id)
    const file = seedFile(owner, 'deep.txt', deep.id)
    const link = seedLink(owner, 'folder', shared.id)

    const res = await request(app).post(`/api/public/${link.token}/file/${file.id}`).send({})

    expect(res.status).toBe(200)
  })

  it('404s for a file outside the link’s scope', async () => {
    const owner = seedUser()
    const shared = seedFolder(owner, 'Shared')
    const elsewhere = seedFile(owner, 'elsewhere.txt')
    const link = seedLink(owner, 'folder', shared.id)

    const res = await request(app).post(`/api/public/${link.token}/file/${elsewhere.id}`).send({})

    expect(res.status).toBe(404)
  })

  it('404s for a different file when the link points at one file', async () => {
    const owner = seedUser()
    const shared = seedFile(owner, 'shared.txt')
    const other = seedFile(owner, 'other.txt')
    const link = seedLink(owner, 'file', shared.id)

    const res = await request(app).post(`/api/public/${link.token}/file/${other.id}`).send({})

    expect(res.status).toBe(404)
  })

  it('404s for a root-level file when the link points at a folder', async () => {
    const owner = seedUser()
    const shared = seedFolder(owner, 'Shared')
    const rootFile = seedFile(owner, 'root.txt', null)
    const link = seedLink(owner, 'folder', shared.id)

    const res = await request(app).post(`/api/public/${link.token}/file/${rootFile.id}`).send({})

    expect(res.status).toBe(404)
  })

  it('enforces the password on the download call', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'secret.txt')
    const link = seedLink(owner, 'file', file.id, withPassword())

    const denied = await request(app).post(`/api/public/${link.token}/file/${file.id}`).send({})
    expect(denied.status).toBe(401)

    const allowed = await request(app)
      .post(`/api/public/${link.token}/file/${file.id}`)
      .send({ password: PASSWORD })
    expect(allowed.status).toBe(200)
  })

  it('404s once the file has been trashed', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'doc.txt')
    const link = seedLink(owner, 'file', file.id)
    trash('files', file.id)

    const res = await request(app).post(`/api/public/${link.token}/file/${file.id}`).send({})

    expect(res.status).toBe(404)
  })
})

describe('public share rate limiting', () => {
  useFreshDatabase()

  it('applies a limiter to every public endpoint, including the metadata read', async () => {
    const owner = seedUser()
    const file = seedFile(owner, 'doc.txt')
    const link = seedLink(owner, 'file', file.id)

    const meta = await request(app).get(`/api/public/${link.token}`)
    const access = await request(app).post(`/api/public/${link.token}/access`).send({})

    // express-rate-limit advertises the window through these headers; their
    // presence is what proves the route is actually behind a limiter
    expect(meta.headers).toHaveProperty('ratelimit-limit')
    expect(access.headers).toHaveProperty('ratelimit-limit')
  })
})
