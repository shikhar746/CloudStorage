import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HardDrive } from 'lucide-react'
import { ItemTable, type ItemColumn } from '../src/components/explorer/ItemTable'
import { SidebarNavItem } from '../src/components/layout/SidebarNavItem'

interface Row {
  id: string
  name: string
}

const columns: ItemColumn<Row>[] = [
  { header: 'Name', render: (row) => row.name },
  { header: 'Actions', align: 'right', render: (row) => <button>Act {row.name}</button> },
]

describe('ItemTable', () => {
  it('renders a header per column and a row per item', () => {
    render(
      <ItemTable
        columns={columns}
        rows={[
          { id: 'a', name: 'Alpha' },
          { id: 'b', name: 'Beta' },
        ]}
        rowKey={(row) => row.id}
      />
    )

    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(3) // header + two
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('renders nothing but headers for an empty list', () => {
    render(<ItemTable columns={columns} rows={[]} rowKey={(row) => row.id} />)
    expect(screen.getAllByRole('row')).toHaveLength(1)
  })

  it('calls onRowClick with the row that was clicked', async () => {
    const onRowClick = vi.fn()
    render(
      <ItemTable
        columns={columns}
        rows={[
          { id: 'a', name: 'Alpha' },
          { id: 'b', name: 'Beta' },
        ]}
        rowKey={(row) => row.id}
        onRowClick={onRowClick}
      />
    )

    await userEvent.click(screen.getByText('Beta'))

    expect(onRowClick).toHaveBeenCalledWith({ id: 'b', name: 'Beta' })
  })

  it('is not clickable when no handler is given', async () => {
    render(
      <ItemTable columns={columns} rows={[{ id: 'a', name: 'Alpha' }]} rowKey={(row) => row.id} />
    )

    const row = screen.getByText('Alpha').closest('tr')!
    expect(row.className).not.toContain('cursor-pointer')
  })

  it('right-aligns the columns that ask for it', () => {
    render(
      <ItemTable columns={columns} rows={[{ id: 'a', name: 'Alpha' }]} rowKey={(row) => row.id} />
    )

    expect(screen.getByRole('columnheader', { name: 'Actions' }).className).toContain('text-right')
  })

  it('scrolls wide content inside its own container', () => {
    const { container } = render(
      <ItemTable
        columns={columns}
        rows={[{ id: 'a', name: 'Alpha' }]}
        rowKey={(row) => row.id}
        minWidthPx={640}
      />
    )

    expect(container.firstElementChild!.className).toContain('overflow-x-auto')
    expect(container.querySelector('table')!.style.minWidth).toBe('640px')
  })
})

describe('SidebarNavItem', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('marks the active destination for assistive tech', () => {
    render(
      <SidebarNavItem
        tab="files"
        label="My Files"
        icon={HardDrive}
        isActive
        onSelect={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: /my files/i })).toHaveAttribute(
      'aria-current',
      'page'
    )
  })

  it('leaves an inactive destination unmarked', () => {
    render(
      <SidebarNavItem
        tab="trash"
        label="Trash Bin"
        icon={HardDrive}
        isActive={false}
        onSelect={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: /trash bin/i })).not.toHaveAttribute('aria-current')
  })

  it('shows a count badge when there is something to report', () => {
    render(
      <SidebarNavItem
        tab="shared"
        label="Shared with me"
        icon={HardDrive}
        isActive={false}
        onSelect={() => {}}
        count={3}
      />
    )

    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('hides the badge at zero', () => {
    render(
      <SidebarNavItem
        tab="shared"
        label="Shared with me"
        icon={HardDrive}
        isActive={false}
        onSelect={() => {}}
        count={0}
      />
    )

    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('reports the selection', async () => {
    const onSelect = vi.fn()
    render(
      <SidebarNavItem
        tab="starred"
        label="Starred"
        icon={HardDrive}
        isActive={false}
        onSelect={onSelect}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /starred/i }))

    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('gives each destination a stable id', () => {
    render(
      <SidebarNavItem
        tab="trash"
        label="Trash Bin"
        icon={HardDrive}
        isActive={false}
        onSelect={() => {}}
      />
    )

    expect(document.getElementById('nav-trash')).toBeInTheDocument()
  })
})

// The views themselves, wired to a stubbed storage context, so the table
// extraction is checked end to end rather than only through its parts.
const storage = {
  starredItems: { folders: [] as any[], files: [] as any[] },
  starredLoading: false,
  fetchStarred: vi.fn(),
  sharedWithMe: { folders: [] as any[], files: [] as any[] },
  sharedLoading: false,
  fetchSharedWithMe: vi.fn(),
  trashData: { folders: [] as any[], files: [] as any[] },
  trashRetentionDays: 30,
  restoreFolder: vi.fn(),
  restoreFile: vi.fn(),
  permanentDeleteFolder: vi.fn(),
  permanentDeleteFile: vi.fn(),
  emptyTrash: vi.fn(),
  navigateToFolder: vi.fn(),
  setPreviewFile: vi.fn(),
  setActiveTab: vi.fn(),
}

vi.mock('../src/context/StorageContext', () => ({ useStorage: () => storage }))

const { StarredView } = await import('../src/components/explorer/StarredView')
const { SharedView } = await import('../src/components/explorer/SharedView')
const { TrashView } = await import('../src/components/explorer/TrashView')

const aFolder = { id: 'folder-1', name: 'Photos', parent_id: null, created_at: '2024-01-01T00:00:00Z' }
const aFile = {
  id: 'file-1',
  name: 'doc.txt',
  mime_type: 'text/plain',
  size_bytes: 2048,
  folder_id: null,
  created_at: '2024-01-02T00:00:00Z',
}

beforeEach(() => {
  storage.starredItems = { folders: [], files: [] }
  storage.sharedWithMe = { folders: [], files: [] }
  storage.trashData = { folders: [], files: [] }
  storage.starredLoading = false
  storage.sharedLoading = false
  for (const value of Object.values(storage)) {
    if (typeof value === 'function' && 'mockClear' in value) value.mockClear()
  }
})

describe('StarredView', () => {
  it('invites the user to star something when the list is empty', () => {
    render(<StarredView />)
    expect(screen.getByText('Nothing starred yet')).toBeInTheDocument()
  })

  it('lists starred folders and files together', () => {
    storage.starredItems = { folders: [aFolder], files: [aFile] }
    render(<StarredView />)

    expect(screen.getByText('Photos')).toBeInTheDocument()
    expect(screen.getByText('doc.txt')).toBeInTheDocument()
    expect(screen.getByText('Folder')).toBeInTheDocument()
  })

  it('opens a starred folder in the explorer', async () => {
    storage.starredItems = { folders: [aFolder], files: [] }
    render(<StarredView />)

    await userEvent.click(screen.getByText('Photos'))

    expect(storage.setActiveTab).toHaveBeenCalledWith('files')
    expect(storage.navigateToFolder).toHaveBeenCalledWith('folder-1', 'Photos')
  })

  it('previews a starred file', async () => {
    storage.starredItems = { folders: [], files: [aFile] }
    render(<StarredView />)

    await userEvent.click(screen.getByText('doc.txt'))

    expect(storage.setPreviewFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }))
  })

  it('refreshes on demand', async () => {
    render(<StarredView />)
    await userEvent.click(screen.getByTitle('Refresh starred items'))
    expect(storage.fetchStarred).toHaveBeenCalled()
  })
})

describe('SharedView', () => {
  it('explains the empty state', () => {
    render(<SharedView />)
    expect(screen.getByText('Nothing shared with you yet')).toBeInTheDocument()
  })

  it('shows who shared each item and the role granted', () => {
    storage.sharedWithMe = {
      folders: [{ ...aFolder, role: 'editor', shared_by: { name: 'Ada', email: 'ada@test' } }],
      files: [{ ...aFile, role: 'viewer', shared_by: { name: null, email: 'grace@test' } }],
    }
    render(<SharedView />)

    expect(screen.getByText('Ada')).toBeInTheDocument()
    expect(screen.getByText('Can Edit')).toBeInTheDocument()
    // falls back to the address when no name is set
    expect(screen.getByText('grace@test')).toBeInTheDocument()
    expect(screen.getByText('Can View')).toBeInTheDocument()
  })

  it('says Unknown when the sharer cannot be resolved', () => {
    storage.sharedWithMe = { folders: [{ ...aFolder, role: 'viewer' }], files: [] }
    render(<SharedView />)
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })
})

describe('TrashView', () => {
  it('reports an empty trash', () => {
    render(<TrashView />)
    expect(screen.getByText('Trash is empty')).toBeInTheDocument()
    expect(screen.queryByText('Empty Trash')).not.toBeInTheDocument()
  })

  it('states the retention window', () => {
    render(<TrashView />)
    expect(screen.getByText(/deleted automatically after 30 days/i)).toBeInTheDocument()
  })

  it('lists folders and files with a dash for folder size', () => {
    storage.trashData = { folders: [aFolder], files: [aFile] }
    render(<TrashView />)

    expect(screen.getByText('Photos')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('2 KB')).toBeInTheDocument()
  })

  it('restores a folder through the folder endpoint', async () => {
    storage.trashData = { folders: [aFolder], files: [] }
    render(<TrashView />)

    await userEvent.click(screen.getByTitle('Restore Folder'))

    await waitFor(() => expect(storage.restoreFolder).toHaveBeenCalledWith('folder-1'))
    expect(storage.restoreFile).not.toHaveBeenCalled()
  })

  it('restores a file through the file endpoint', async () => {
    storage.trashData = { folders: [], files: [aFile] }
    render(<TrashView />)

    await userEvent.click(screen.getByTitle('Restore File'))

    await waitFor(() => expect(storage.restoreFile).toHaveBeenCalledWith('file-1'))
    expect(storage.restoreFolder).not.toHaveBeenCalled()
  })

  it('confirms before permanently deleting, and respects a cancel', async () => {
    storage.trashData = { folders: [], files: [aFile] }
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<TrashView />)

    await userEvent.click(screen.getByTitle('Delete Permanently'))

    expect(storage.permanentDeleteFile).not.toHaveBeenCalled()
  })

  it('permanently deletes once confirmed', async () => {
    storage.trashData = { folders: [], files: [aFile] }
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<TrashView />)

    await userEvent.click(screen.getByTitle('Delete Permanently'))

    await waitFor(() => expect(storage.permanentDeleteFile).toHaveBeenCalledWith('file-1'))
  })

  it('asks twice before emptying the whole trash', async () => {
    storage.trashData = { folders: [], files: [aFile] }
    render(<TrashView />)

    await userEvent.click(screen.getByText('Empty Trash'))
    expect(storage.emptyTrash).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('Confirm Purge All'))
    await waitFor(() => expect(storage.emptyTrash).toHaveBeenCalled())
  })

  it('lets the user back out of emptying the trash', async () => {
    storage.trashData = { folders: [], files: [aFile] }
    render(<TrashView />)

    await userEvent.click(screen.getByText('Empty Trash'))
    await userEvent.click(screen.getByText('Cancel'))

    expect(screen.getByText('Empty Trash')).toBeInTheDocument()
    expect(storage.emptyTrash).not.toHaveBeenCalled()
  })
})
