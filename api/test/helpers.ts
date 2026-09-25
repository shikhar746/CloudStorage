import { beforeEach } from 'vitest'
import { fakeDb } from './fakeSupabase.js'
import { signAccessToken } from '../src/lib/tokens.js'

export { fakeDb }

/** A user row plus the cookie header that authenticates as them. */
export interface TestUser {
  id: string
  email: string
  name: string
  cookie: string
}

let userCount = 0

/**
 * Creates a user and the session cookie for it.
 *
 * The cookie is a real signed access token rather than a stubbed `requireAuth`:
 * the middleware is part of what these tests are checking, and several findings
 * turn on who the server thinks is calling.
 */
export function seedUser(overrides: Partial<{ email: string; name: string }> = {}): TestUser {
  userCount += 1
  const email = overrides.email ?? `user${userCount}@test.local`
  const name = overrides.name ?? `User ${userCount}`
  const [row] = fakeDb.seed('users', [{ email, name, password_hash: 'not-a-real-hash' }])
  const id = row!.id as string
  return { id, email, name, cookie: `accessToken=${signAccessToken(id)}` }
}

/** A folder owned by `user`, optionally nested under `parentId`. */
export function seedFolder(
  user: TestUser,
  name: string,
  parentId: string | null = null,
  overrides: Record<string, unknown> = {}
): { id: string; name: string } {
  const [row] = fakeDb.seed('folders', [
    { name, parent_id: parentId, owner_id: user.id, ...overrides },
  ])
  return { id: row!.id as string, name }
}

/** A file owned by `user`, with a matching object in the bucket. */
export function seedFile(
  user: TestUser,
  name: string,
  folderId: string | null = null,
  overrides: Record<string, unknown> = {}
): { id: string; name: string; storageKey: string } {
  const storageKey = `${user.id}/${name}-${Math.random().toString(36).slice(2, 8)}`
  const [row] = fakeDb.seed('files', [
    {
      name,
      mime_type: 'text/plain',
      size_bytes: 128,
      storage_key: storageKey,
      owner_id: user.id,
      folder_id: folderId,
      ...overrides,
    },
  ])
  fakeDb.seedObject(storageKey)
  return { id: row!.id as string, name, storageKey }
}

/** Marks a resource as trashed `daysAgo` days ago, for retention tests. */
export function trash(table: 'files' | 'folders', id: string, daysAgo = 0): void {
  const row = fakeDb.rows(table).find((candidate) => candidate.id === id)
  if (!row) throw new Error(`cannot trash missing ${table} row ${id}`)
  row.is_deleted = true
  row.deleted_at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
}

/** Grants `grantee` a role on a resource owned by someone else. */
export function seedShare(
  owner: TestUser,
  grantee: TestUser,
  resourceType: 'file' | 'folder',
  resourceId: string,
  role: 'viewer' | 'editor' = 'viewer'
): void {
  fakeDb.seed('shares', [
    {
      resource_type: resourceType,
      resource_id: resourceId,
      grantee_user_id: grantee.id,
      created_by: owner.id,
      role,
    },
  ])
}

/** Resets the fake database before every test in the importing file. */
export function useFreshDatabase(): void {
  beforeEach(() => {
    fakeDb.reset()
    userCount = 0
  })
}
