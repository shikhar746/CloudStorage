import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ApiClient,
  ApiError,
  api,
  getPublicShare,
  accessPublicShare,
  FALLBACK_UPLOAD_LIMITS,
} from '../src/services/api'

interface StubResponse {
  status?: number
  body?: unknown
  /** Raw text, for responses that are not JSON at all. */
  text?: string
}

function stubFetch(...responses: StubResponse[]) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let index = 0

  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    const spec = responses[Math.min(index, responses.length - 1)] ?? {}
    index += 1
    const status = spec.status ?? 200
    const text = spec.text ?? JSON.stringify(spec.body ?? {})
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (spec.text !== undefined) throw new SyntaxError('not json')
        return spec.body ?? {}
      },
      text: async () => text,
    } as unknown as Response
  })

  vi.stubGlobal('fetch', impl)
  return { calls, impl }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiError', () => {
  it('carries the machine-readable code and status', () => {
    const error = new ApiError('nope', 'LINK_EXPIRED', 410)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('LINK_EXPIRED')
    expect(error.status).toBe(410)
    expect(error.name).toBe('ApiError')
  })
})

describe('public share helpers', () => {
  it('sends no credentials — the token is the only credential', async () => {
    const { calls } = stubFetch({ body: { resourceType: 'file', requiresPassword: false } })

    await getPublicShare('abc')

    expect(calls[0]!.init.credentials).toBeUndefined()
    expect(calls[0]!.url).toContain('/api/public/abc')
  })

  it('encodes the token into the path', async () => {
    const { calls } = stubFetch({ body: {} })
    await getPublicShare('a/b?c')
    expect(calls[0]!.url).toContain(encodeURIComponent('a/b?c'))
  })

  it('POSTs the password on access', async () => {
    const { calls } = stubFetch({ body: { resourceType: 'file' } })

    await accessPublicShare('abc', 'letmein')

    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ password: 'letmein' })
  })

  it('throws an ApiError carrying the server’s code', async () => {
    stubFetch({
      status: 401,
      body: { error: { code: 'INVALID_PASSWORD', message: 'Incorrect password' } },
    })

    await expect(accessPublicShare('abc', 'wrong')).rejects.toMatchObject({
      code: 'INVALID_PASSWORD',
      status: 401,
      message: 'Incorrect password',
    })
  })

  it('never retries a 401 by refreshing the session', async () => {
    const { calls } = stubFetch({ status: 401, body: { error: { code: 'INVALID_PASSWORD' } } })

    await expect(accessPublicShare('abc', 'wrong')).rejects.toBeInstanceOf(ApiError)

    expect(calls).toHaveLength(1)
    expect(calls.some((call) => call.url.includes('/auth/refresh'))).toBe(false)
  })
})

describe('ApiClient.request error handling', () => {
  it('throws an ApiError so callers can branch on the code', async () => {
    // The public helpers already preserve `error.code`; the authenticated
    // client must too, or callers are left guessing at what went wrong.
    stubFetch({
      status: 409,
      body: { error: { code: 'FOLDER_EXISTS', message: 'A folder with that name exists' } },
    })

    const client = new ApiClient()

    await expect(client.createFolder('Reports')).rejects.toMatchObject({
      code: 'FOLDER_EXISTS',
      status: 409,
      message: 'A folder with that name exists',
    })
  })

  it('is an ApiError instance, not a bare Error', async () => {
    stubFetch({ status: 409, body: { error: { code: 'FOLDER_EXISTS', message: 'taken' } } })
    const client = new ApiClient()

    await expect(client.createFolder('Reports')).rejects.toBeInstanceOf(ApiError)
  })

  it('flattens zod issues into a readable message', async () => {
    stubFetch({
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          issues: [{ path: ['name'], message: 'Name is required' }],
        },
      },
    })
    const client = new ApiClient()

    await expect(client.createFolder('')).rejects.toThrow('name: Name is required')
  })

  it('falls back to the status when the body says nothing useful', async () => {
    stubFetch({ status: 500, body: {} })
    const client = new ApiClient()

    await expect(client.createFolder('x')).rejects.toThrow('Request failed with status 500')
  })

  it('survives a non-JSON error body from a proxy', async () => {
    stubFetch({ status: 502, text: '<html>Bad Gateway</html>' })
    const client = new ApiClient()

    await expect(client.createFolder('x')).rejects.toThrow('Request failed with status 502')
  })

  it('returns null for a 204 rather than trying to parse it', async () => {
    stubFetch({ status: 204 })
    const client = new ApiClient()

    await expect(client.deleteFolder('folder-1')).resolves.toBeNull()
  })

  it('sends cookies on every authenticated call', async () => {
    const { calls } = stubFetch({ body: { children: { folders: [], files: [] } } })
    const client = new ApiClient()

    await client.getRoot()

    expect(calls[0]!.init.credentials).toBe('include')
  })

  it('refreshes once on a 401 and retries the original request', async () => {
    const { calls } = stubFetch(
      { status: 401, body: { error: { code: 'INVALID_TOKEN' } } },
      { status: 200, body: {} },
      { status: 200, body: { children: { folders: [], files: [] } } }
    )
    const client = new ApiClient()

    await client.getRoot()

    expect(calls.map((call) => call.url.replace(/^https?:\/\/[^/]+/, ''))).toEqual([
      '/api/folders/root',
      '/api/auth/refresh',
      '/api/folders/root',
    ])
  })

  it('gives up after one retry rather than looping', async () => {
    const { calls } = stubFetch(
      { status: 401, body: { error: { code: 'INVALID_TOKEN' } } },
      { status: 200, body: {} },
      { status: 401, body: { error: { code: 'INVALID_TOKEN', message: 'Session expired' } } }
    )
    const client = new ApiClient()

    await expect(client.getRoot()).rejects.toThrow('Session expired')
    expect(calls).toHaveLength(3)
  })

  it('does not try to refresh a failed login', async () => {
    const { calls } = stubFetch({
      status: 401,
      body: { error: { code: 'INVALID_CREDENTIALS', message: 'Wrong email or password' } },
    })
    const client = new ApiClient()

    await expect(client.login('a@b.c', 'nope')).rejects.toThrow('Wrong email or password')
    expect(calls).toHaveLength(1)
  })
})

describe('ApiClient server info', () => {
  it('reports the server’s limits', async () => {
    stubFetch({
      body: {
        limits: { maxFileSizeBytes: 1000, maxDirectUploadBytes: 2000 },
        trashRetentionDays: 14,
      },
    })
    const client = new ApiClient()

    expect(await client.getLimits()).toEqual({ maxFileSizeBytes: 1000, maxDirectUploadBytes: 2000 })
    expect(await client.getTrashRetentionDays()).toBe(14)
  })

  it('reads /api/health only once for both questions', async () => {
    const { calls } = stubFetch({
      body: { limits: { maxFileSizeBytes: 1, maxDirectUploadBytes: 2 }, trashRetentionDays: 7 },
    })
    const client = new ApiClient()

    await client.getLimits()
    await client.getTrashRetentionDays()

    expect(calls).toHaveLength(1)
  })

  it('falls back to the documented defaults when the server reports none', async () => {
    stubFetch({ body: {} })
    const client = new ApiClient()

    expect(await client.getLimits()).toEqual(FALLBACK_UPLOAD_LIMITS)
    expect(await client.getTrashRetentionDays()).toBeNull()
  })

  it('falls back when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
    )
    const client = new ApiClient()

    expect(await client.getLimits()).toEqual(FALLBACK_UPLOAD_LIMITS)
  })

  it('ignores nonsense limits rather than trusting them', async () => {
    stubFetch({ body: { limits: { maxFileSizeBytes: 'lots', maxDirectUploadBytes: null } } })
    const client = new ApiClient()

    expect(await client.getLimits()).toEqual(FALLBACK_UPLOAD_LIMITS)
  })
})

describe('ApiClient request shapes', () => {
  it('unwraps the folder envelope', async () => {
    stubFetch({ body: { folder: { id: 'f1', name: 'Reports' } } })
    const client = new ApiClient()

    expect(await client.createFolder('Reports')).toEqual({ id: 'f1', name: 'Reports' })
  })

  it('sends parentId as null for a root folder', async () => {
    const { calls } = stubFetch({ body: { folder: {} } })
    const client = new ApiClient()

    await client.createFolder('Reports')

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: 'Reports', parentId: null })
  })

  it('encodes the search query', async () => {
    const { calls } = stubFetch({ body: { folders: [], files: [] } })
    const client = new ApiClient()

    await client.search('a b&c')

    expect(calls[0]!.url).toContain('q=a%20b%26c')
  })

  it('builds the star routes from the resource pair', async () => {
    const { calls } = stubFetch({ status: 201, body: { starred: true } }, { status: 200, body: {} })
    const client = new ApiClient()

    await client.setStarred('file', 'file-1', true)
    await client.setStarred('folder', 'folder-1', false)

    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      resourceType: 'file',
      resourceId: 'file-1',
    })
    expect(calls[1]!.url).toContain('/api/stars/folder/folder-1')
    expect(calls[1]!.init.method).toBe('DELETE')
  })

  it('defaults missing star lists to empty arrays', async () => {
    stubFetch({ body: {} })
    const client = new ApiClient()

    expect(await client.getStarred()).toEqual({ folders: [], files: [] })
  })

  it('flattens the shares join into a flat ShareItem', async () => {
    stubFetch({
      body: {
        shares: [
          {
            id: 's1',
            role: 'editor',
            created_at: '2024-01-01T00:00:00.000Z',
            users: { id: 'u2', email: 'them@test.local', name: 'Them' },
          },
        ],
      },
    })
    const client = new ApiClient()

    const shares = await client.listShares('folder', 'folder-1')

    expect(shares).toEqual([
      {
        id: 's1',
        resource_type: 'folder',
        resource_id: 'folder-1',
        role: 'editor',
        created_at: '2024-01-01T00:00:00.000Z',
        grantee_user_id: 'u2',
        grantee_name: 'Them',
        grantee_email: 'them@test.local',
      },
    ])
  })
})

describe('ApiClient identity contract', () => {
  /**
   * The server reads the caller from the httpOnly session cookie. A `userId`
   * argument on these methods would be dead weight that the signature
   * nonetheless advertises as meaningful, so the arity is asserted directly.
   */
  it('takes no caller id — the cookie already carries it', () => {
    // Each of these used to lead with a `userId` that nothing read, so the
    // arity is one lower than it was. Note that an optional TypeScript
    // parameter still counts toward Function.length; only a default truncates.
    expect(api.getRoot.length).toBe(0)
    expect(api.getTrash.length).toBe(0)
    expect(api.emptyTrash.length).toBe(0)
    expect(api.getSharedWithMe.length).toBe(0)
    // (folderId?) — was (userId, folderId?)
    expect(api.listFiles.length).toBe(1)
  })

  it('takes only the arguments the request actually needs', () => {
    expect(api.getFolder.length).toBe(1)
    expect(api.getFolderPath.length).toBe(1)
    expect(api.deleteFolder.length).toBe(1)
    expect(api.restoreFolder.length).toBe(1)
    expect(api.permanentDeleteFolder.length).toBe(1)
    expect(api.getFile.length).toBe(1)
    expect(api.deleteFile.length).toBe(1)
    expect(api.restoreFile.length).toBe(1)
    expect(api.permanentDeleteFile.length).toBe(1)
    expect(api.deleteShare.length).toBe(1)
    expect(api.search.length).toBe(1)
    // (name, parentId?) — was (userId, name, parentId?)
    expect(api.createFolder.length).toBe(2)
    // (folderId, updates) — was (userId, folderId, updates)
    expect(api.updateFolder.length).toBe(2)
    expect(api.updateFile.length).toBe(2)
    // (resourceType, resourceId, granteeUserId, role) — was five
    expect(api.createShare.length).toBe(4)
    expect(api.listShares.length).toBe(2)
    // (file, folderId?, onProgress?) before the defaulted isRetry
    expect(api.uploadFile.length).toBe(3)
    expect(api.uploadFileDirect.length).toBe(3)
  })
})
