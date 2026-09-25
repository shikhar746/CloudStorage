import { describe, it, expect } from 'vitest'
import { getAccessRole } from '../../src/lib/access.js'
import { seedUser, seedFolder, seedFile, seedShare, trash, useFreshDatabase } from '../helpers.js'

describe('getAccessRole', () => {
  useFreshDatabase()

  it('reports owner for your own resources', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Mine')
    const file = seedFile(user, 'mine.txt')

    expect(await getAccessRole(user.id, 'folder', folder.id)).toBe('owner')
    expect(await getAccessRole(user.id, 'file', file.id)).toBe('owner')
  })

  it('reports null for a resource nobody shared with you', async () => {
    const owner = seedUser()
    const stranger = seedUser()
    const folder = seedFolder(owner, 'Private')

    expect(await getAccessRole(stranger.id, 'folder', folder.id)).toBeNull()
  })

  it('reports null for a resource that does not exist', async () => {
    const user = seedUser()
    expect(await getAccessRole(user.id, 'folder', '00000000-0000-4000-8000-000000009999')).toBeNull()
  })

  it('reports null for a trashed resource even to its owner', async () => {
    const user = seedUser()
    const folder = seedFolder(user, 'Gone')
    trash('folders', folder.id)

    expect(await getAccessRole(user.id, 'folder', folder.id)).toBeNull()
  })

  it('reports the role from a direct share', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const folder = seedFolder(owner, 'Shared')
    seedShare(owner, grantee, 'folder', folder.id, 'editor')

    expect(await getAccessRole(grantee.id, 'folder', folder.id)).toBe('editor')
  })

  it('inherits access from a shared ancestor folder', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const top = seedFolder(owner, 'Top')
    const middle = seedFolder(owner, 'Middle', top.id)
    const deep = seedFolder(owner, 'Deep', middle.id)
    const file = seedFile(owner, 'deep.txt', deep.id)
    seedShare(owner, grantee, 'folder', top.id, 'viewer')

    expect(await getAccessRole(grantee.id, 'folder', deep.id)).toBe('viewer')
    expect(await getAccessRole(grantee.id, 'file', file.id)).toBe('viewer')
  })

  it('lets an editor grant anywhere up the chain win over a viewer grant', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const top = seedFolder(owner, 'Top')
    const middle = seedFolder(owner, 'Middle', top.id)
    seedShare(owner, grantee, 'folder', top.id, 'editor')
    seedShare(owner, grantee, 'folder', middle.id, 'viewer')

    // the direct share on `middle` is found first and wins for `middle` itself
    expect(await getAccessRole(grantee.id, 'folder', middle.id)).toBe('viewer')

    const deep = seedFolder(owner, 'Deep', middle.id)
    // for a descendant, both ancestors are candidates and editor beats viewer
    expect(await getAccessRole(grantee.id, 'folder', deep.id)).toBe('editor')
  })

  it('stops inheriting through a trashed ancestor', async () => {
    const owner = seedUser()
    const grantee = seedUser()
    const top = seedFolder(owner, 'Top')
    const middle = seedFolder(owner, 'Middle', top.id)
    const deep = seedFolder(owner, 'Deep', middle.id)
    seedShare(owner, grantee, 'folder', top.id, 'viewer')
    trash('folders', middle.id)

    expect(await getAccessRole(grantee.id, 'folder', deep.id)).toBeNull()
  })

  it('prefers the owner answer over any share row', async () => {
    const owner = seedUser()
    const folder = seedFolder(owner, 'Mine')
    // a self-share would be odd but must not downgrade ownership
    seedShare(owner, owner, 'folder', folder.id, 'viewer')

    expect(await getAccessRole(owner.id, 'folder', folder.id)).toBe('owner')
  })
})
