import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import type { ActiveNavTab } from '../src/types/storage'

const user = { id: 'user-1', name: 'Tester', email: 'tester@test.local' }

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user, loading: false }),
}))

const apiMock = {
  getRoot: vi.fn(),
  getFolder: vi.fn(),
  getFolderPath: vi.fn(),
  getTrash: vi.fn(),
  getSharedWithMe: vi.fn(),
  getStarred: vi.fn(),
  setStarred: vi.fn(),
  listFiles: vi.fn(),
  createFolder: vi.fn(),
  updateFolder: vi.fn(),
  deleteFolder: vi.fn(),
  restoreFolder: vi.fn(),
  permanentDeleteFolder: vi.fn(),
  updateFile: vi.fn(),
  deleteFile: vi.fn(),
  restoreFile: vi.fn(),
  permanentDeleteFile: vi.fn(),
  emptyTrash: vi.fn(),
  search: vi.fn(),
  getLimits: vi.fn(),
  getTrashRetentionDays: vi.fn(),
  uploadFile: vi.fn(),
  uploadFileDirect: vi.fn(),
  getFile: vi.fn(),
}

vi.mock('../src/services/api', async () => {
  const actual = await vi.importActual<typeof import('../src/services/api')>(
    '../src/services/api'
  )
  return {
    ...actual,
    api: apiMock,
    FALLBACK_UPLOAD_LIMITS: { maxFileSizeBytes: 1000, maxDirectUploadBytes: 2000 },
  }
})

const { StorageProvider, useStorage } = await import('../src/context/StorageContext')

/** Renders storage state and exposes the actions a test wants to fire. */
const Probe: React.FC = () => {
  const storage = useStorage()
  ;(globalThis as Record<string, unknown>).storage = storage
  return (
    <div>
      <span data-testid="tab">{storage.activeTab}</span>
      <span data-testid="folders">{storage.folders.map((f) => f.name).join(',')}</span>
      <span data-testid="files">{storage.files.map((f) => f.name).join(',')}</span>
      <span data-testid="starred-files">
        {storage.starredItems.files.map((f) => `${f.name}:${f.starred}`).join(',')}
      </span>
      <span data-testid="crumbs">{storage.breadcrumbs.map((b) => b.name).join('/')}</span>
      <span data-testid="used">{storage.storageUsage.usedBytes}</span>
      <span data-testid="error">{storage.error ?? ''}</span>
    </div>
  )
}

function currentStorage(): ReturnType<typeof useStorage> {
  return (globalThis as Record<string, unknown>).storage as ReturnType<typeof useStorage>
}

async function renderProvider() {
  render(
    <StorageProvider>
      <Probe />
    </StorageProvider>
  )
  await waitFor(() => expect(apiMock.getRoot).toHaveBeenCalled())
}

/** Switches tab and waits for that tab's loader to settle. */
async function switchTo(tab: ActiveNavTab) {
  await act(async () => {
    currentStorage().setActiveTab(tab)
  })
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset()

  apiMock.getRoot.mockResolvedValue({
    folder: null,
    children: { folders: [], files: [] },
    role: 'owner',
  })
  apiMock.getFolder.mockResolvedValue({
    folder: { id: 'folder-1', name: 'Folder', parent_id: null, created_at: '' },
    children: { folders: [], files: [] },
    role: 'owner',
  })
  apiMock.getFolderPath.mockResolvedValue([])
  apiMock.getTrash.mockResolvedValue({ folders: [], files: [] })
  apiMock.getSharedWithMe.mockResolvedValue({ folders: [], files: [] })
  apiMock.getStarred.mockResolvedValue({ folders: [], files: [] })
  apiMock.setStarred.mockResolvedValue(undefined)
  apiMock.listFiles.mockResolvedValue([])
  apiMock.getLimits.mockResolvedValue({ maxFileSizeBytes: 1000, maxDirectUploadBytes: 2000 })
  apiMock.getTrashRetentionDays.mockResolvedValue(30)
  apiMock.updateFile.mockResolvedValue({ id: 'file-1', name: 'renamed.txt' })
  apiMock.deleteFile.mockResolvedValue(undefined)
  apiMock.updateFolder.mockResolvedValue({ id: 'folder-1', name: 'renamed' })
  apiMock.createFolder.mockResolvedValue({ id: 'folder-2', name: 'New' })
})

describe('StorageProvider tab loading', () => {
  it('loads the root on mount', async () => {
    await renderProvider()
    expect(screen.getByTestId('tab')).toHaveTextContent('files')
    expect(apiMock.getRoot).toHaveBeenCalled()
  })

  it('loads each tab when it becomes active', async () => {
    await renderProvider()

    await switchTo('trash')
    expect(apiMock.getTrash).toHaveBeenCalled()

    await switchTo('shared')
    expect(apiMock.getSharedWithMe).toHaveBeenCalled()

    await switchTo('starred')
    expect(apiMock.getStarred).toHaveBeenCalled()
  })
})

describe('refreshCurrentFolder', () => {
  it('refreshes the files tab', async () => {
    await renderProvider()
    apiMock.getRoot.mockClear()

    await act(async () => {
      await currentStorage().refreshCurrentFolder()
    })

    expect(apiMock.getRoot).toHaveBeenCalledTimes(1)
  })

  it('refreshes the trash tab', async () => {
    await renderProvider()
    await switchTo('trash')
    apiMock.getTrash.mockClear()

    await act(async () => {
      await currentStorage().refreshCurrentFolder()
    })

    expect(apiMock.getTrash).toHaveBeenCalledTimes(1)
  })

  it('refreshes the shared tab', async () => {
    await renderProvider()
    await switchTo('shared')
    apiMock.getSharedWithMe.mockClear()

    await act(async () => {
      await currentStorage().refreshCurrentFolder()
    })

    expect(apiMock.getSharedWithMe).toHaveBeenCalledTimes(1)
  })

  it('refreshes the starred tab', async () => {
    // The tab dispatcher and this refresh must agree on the set of tabs, or a
    // mutation made from Starred leaves a stale row on screen.
    await renderProvider()
    await switchTo('starred')
    apiMock.getStarred.mockClear()

    await act(async () => {
      await currentStorage().refreshCurrentFolder()
    })

    expect(apiMock.getStarred).toHaveBeenCalledTimes(1)
  })

  it('refreshes Starred after a mutation made from that tab', async () => {
    await renderProvider()
    await switchTo('starred')
    apiMock.getStarred.mockClear()

    await act(async () => {
      await currentStorage().renameFile('file-1', 'renamed.txt')
    })

    expect(apiMock.updateFile).toHaveBeenCalled()
    expect(apiMock.getStarred).toHaveBeenCalledTimes(1)
  })
})

describe('toggleStar', () => {
  it('applies the star locally before the request settles', async () => {
    apiMock.getRoot.mockResolvedValue({
      folder: null,
      children: {
        folders: [],
        files: [
          {
            id: 'file-1',
            name: 'doc.txt',
            mime_type: 'text/plain',
            size_bytes: 10,
            folder_id: null,
            created_at: '',
            starred: false,
          },
        ],
      },
      role: 'owner',
    })
    let resolveCall: () => void = () => {}
    apiMock.setStarred.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCall = resolve
        })
    )
    await renderProvider()

    let pending: Promise<void>
    await act(async () => {
      pending = currentStorage().toggleStar('file', 'file-1', true)
    })

    expect(currentStorage().files[0]!.starred).toBe(true)

    await act(async () => {
      resolveCall()
      await pending
    })
    expect(currentStorage().files[0]!.starred).toBe(true)
  })

  it('rolls the star back and reports the error when the call fails', async () => {
    apiMock.getRoot.mockResolvedValue({
      folder: null,
      children: {
        folders: [],
        files: [
          {
            id: 'file-1',
            name: 'doc.txt',
            mime_type: 'text/plain',
            size_bytes: 10,
            folder_id: null,
            created_at: '',
            starred: false,
          },
        ],
      },
      role: 'owner',
    })
    apiMock.setStarred.mockRejectedValue(new Error('Could not star this item'))
    await renderProvider()

    await act(async () => {
      await currentStorage().toggleStar('file', 'file-1', true)
    })

    expect(currentStorage().files[0]!.starred).toBe(false)
    expect(screen.getByTestId('error')).toHaveTextContent('Could not star this item')
  })

  it('drops the row from Starred when unstarring there', async () => {
    apiMock.getStarred.mockResolvedValue({
      folders: [],
      files: [
        {
          id: 'file-1',
          name: 'doc.txt',
          mime_type: 'text/plain',
          size_bytes: 10,
          folder_id: null,
          created_at: '',
          starred: true,
        },
      ],
    })
    await renderProvider()
    await switchTo('starred')

    await act(async () => {
      await currentStorage().toggleStar('file', 'file-1', false)
    })

    expect(currentStorage().starredItems.files).toHaveLength(0)
  })
})

describe('navigation', () => {
  it('extends the trail when stepping into a listed child', async () => {
    apiMock.getRoot.mockResolvedValue({
      folder: null,
      children: {
        folders: [{ id: 'folder-1', name: 'Photos', parent_id: null, created_at: '' }],
        files: [],
      },
      role: 'owner',
    })
    await renderProvider()

    await act(async () => {
      await currentStorage().navigateToFolder('folder-1', 'Photos')
    })

    expect(screen.getByTestId('crumbs')).toHaveTextContent('My Storage/Photos')
  })

  it('asks the server for the chain when jumping somewhere unlisted', async () => {
    apiMock.getFolderPath.mockResolvedValue([
      { id: 'top', name: 'Top' },
      { id: 'deep', name: 'Deep' },
    ])
    await renderProvider()

    await act(async () => {
      await currentStorage().navigateToFolder('deep', 'Deep')
    })

    expect(apiMock.getFolderPath).toHaveBeenCalledWith('deep')
    expect(screen.getByTestId('crumbs')).toHaveTextContent('My Storage/Top/Deep')
  })

  it('opens a folder whose ancestors the caller cannot see', async () => {
    apiMock.getFolderPath.mockRejectedValue(new Error('403'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await renderProvider()

    await act(async () => {
      await currentStorage().navigateToFolder('shared-1', 'Shared')
    })

    expect(screen.getByTestId('crumbs')).toHaveTextContent('My Storage/Shared')
  })

  it('walks back up the existing trail', async () => {
    apiMock.getRoot.mockResolvedValue({
      folder: null,
      children: {
        folders: [{ id: 'folder-1', name: 'Photos', parent_id: null, created_at: '' }],
        files: [],
      },
      role: 'owner',
    })
    await renderProvider()
    await act(async () => {
      await currentStorage().navigateToFolder('folder-1', 'Photos')
    })

    await act(async () => {
      await currentStorage().navigateUp()
    })

    expect(screen.getByTestId('crumbs')).toHaveTextContent('My Storage')
  })
})

describe('storage usage', () => {
  it('sums the loaded files into a category breakdown', async () => {
    apiMock.getRoot.mockResolvedValue({
      folder: null,
      children: {
        folders: [],
        files: [
          { id: '1', name: 'a.png', mime_type: 'image/png', size_bytes: 100, folder_id: null, created_at: '' },
          { id: '2', name: 'b.pdf', mime_type: 'application/pdf', size_bytes: 200, folder_id: null, created_at: '' },
          { id: '3', name: 'c.mp4', mime_type: 'video/mp4', size_bytes: 300, folder_id: null, created_at: '' },
          { id: '4', name: 'd.bin', mime_type: 'application/octet-stream', size_bytes: 400, folder_id: null, created_at: '' },
        ],
      },
      role: 'owner',
    })
    await renderProvider()

    const usage = currentStorage().storageUsage
    expect(usage.usedBytes).toBe(1000)
    expect(usage.breakdown).toMatchObject({
      images: 100,
      documents: 200,
      media: 300,
      others: 400,
    })
  })
})

describe('access role', () => {
  it('reports a viewer as unable to edit or share', async () => {
    apiMock.getRoot.mockResolvedValue({
      folder: null,
      children: { folders: [], files: [] },
      role: 'viewer',
    })
    await renderProvider()

    expect(currentStorage().canEdit).toBe(false)
    expect(currentStorage().canShare).toBe(false)
  })

  it('reports an editor as able to edit but not share', async () => {
    apiMock.getRoot.mockResolvedValue({
      folder: null,
      children: { folders: [], files: [] },
      role: 'editor',
    })
    await renderProvider()

    expect(currentStorage().canEdit).toBe(true)
    expect(currentStorage().canShare).toBe(false)
  })

  it('treats a server that reports no role as full access', async () => {
    apiMock.getRoot.mockResolvedValue({
      folder: null,
      children: { folders: [], files: [] },
    })
    await renderProvider()

    expect(currentStorage().canEdit).toBe(true)
  })
})
