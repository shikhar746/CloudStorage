import { describe, it, expect } from 'vitest'
import request from 'supertest'
import app from '../src/app.js'
import { fakeDb, seedUser, seedFolder, seedFile, useFreshDatabase } from './helpers.js'

/**
 * Checks the test harness itself: the Supabase fake is wired into the app, and
 * the bits of Postgres the suite leans on actually behave. If this file fails,
 * every other failure downstream is suspect.
 */
describe('test harness', () => {
  useFreshDatabase()

  it('routes application queries through the in-memory fake', async () => {
    const user = seedUser()
    seedFolder(user, 'Photos')

    const res = await request(app).get('/api/folders/root').set('Cookie', user.cookie)

    expect(res.status).toBe(200)
    expect(res.body.children.folders.map((f: { name: string }) => f.name)).toEqual(['Photos'])
  })

  it('enforces the partial unique index only on live rows', async () => {
    const user = seedUser()
    seedFolder(user, 'Reports')

    // a second live folder with the same name in the same parent collides
    const clash = await fakeDb
      .from('folders')
      .insert({ name: 'Reports', parent_id: null, owner_id: user.id })
      .select()
      .single()
    expect(clash.error?.code).toBe('23505')

    // the index is `where is_deleted = false`, so a trashed row does not
    fakeDb.rows('folders')[0]!.is_deleted = true
    const afterTrash = await fakeDb
      .from('folders')
      .insert({ name: 'Reports', parent_id: null, owner_id: user.id })
      .select()
      .single()
    expect(afterTrash.error).toBeNull()
  })

  it('cascades folder deletes to nested folders and files', async () => {
    const user = seedUser()
    const parent = seedFolder(user, 'Parent')
    const child = seedFolder(user, 'Child', parent.id)
    seedFile(user, 'deep.txt', child.id)
    seedFile(user, 'shallow.txt', parent.id)

    await fakeDb.from('folders').delete().eq('id', parent.id)

    expect(fakeDb.rows('folders')).toHaveLength(0)
    expect(fakeDb.rows('files')).toHaveLength(0)
  })

  it('projects only the selected columns', async () => {
    const user = seedUser()
    seedFolder(user, 'Trip')

    const { data } = await fakeDb.from('folders').select('id, name').single()

    expect(Object.keys(data as object).sort()).toEqual(['id', 'name'])
  })

  it('resolves embedded joins the share controller relies on', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const folder = seedFolder(owner, 'Shared')
    fakeDb.seed('shares', [
      {
        resource_type: 'folder',
        resource_id: folder.id,
        grantee_user_id: grantee.id,
        created_by: owner.id,
        role: 'viewer',
      },
    ])

    const { data } = await fakeDb
      .from('shares')
      .select('id, role, users!grantee_user_id(id, email, name)')
      .single()

    expect(data.users).toEqual({ id: grantee.id, email: grantee.email, name: grantee.name })
    expect(data.resource_id).toBeUndefined()
  })

  it('reports no rows for single() the way PostgREST does', async () => {
    const { data, error } = await fakeDb.from('folders').select('id').eq('id', 'nope').single()
    expect(data).toBeNull()
    expect(error?.code).toBe('PGRST116')
  })
})
