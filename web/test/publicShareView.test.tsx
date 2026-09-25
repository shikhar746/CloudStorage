import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const shareApi = {
  getPublicShare: vi.fn(),
  accessPublicShare: vi.fn(),
  browsePublicShare: vi.fn(),
  getPublicFile: vi.fn(),
}

vi.mock('../src/services/api', async () => {
  const actual = await vi.importActual<typeof import('../src/services/api')>(
    '../src/services/api'
  )
  return { ...actual, ...shareApi }
})

const { PublicShareView } = await import('../src/components/public/PublicShareView')
const { ApiError } = await import('../src/services/api')

const file = {
  id: 'file-1',
  name: 'report.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  folder_id: null,
  created_at: '2024-01-01T00:00:00.000Z',
}

beforeEach(() => {
  for (const fn of Object.values(shareApi)) fn.mockReset()
  vi.stubGlobal('open', vi.fn())
})

describe('PublicShareView', () => {
  it('opens an unprotected file link straight away', async () => {
    shareApi.getPublicShare.mockResolvedValue({
      resourceType: 'file',
      requiresPassword: false,
      expiresAt: null,
      name: 'report.pdf',
    })
    shareApi.accessPublicShare.mockResolvedValue({
      resourceType: 'file',
      file,
      signedUrl: 'https://storage.test/report.pdf',
    })

    render(<PublicShareView token="abc" />)

    expect(await screen.findByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument()
    expect(shareApi.accessPublicShare).toHaveBeenCalledWith('abc', undefined)
  })

  it('asks for a password without revealing anything about the item', async () => {
    shareApi.getPublicShare.mockResolvedValue({
      resourceType: 'file',
      requiresPassword: true,
      expiresAt: null,
    })

    render(<PublicShareView token="abc" />)

    expect(await screen.findByText(/this link is protected/i)).toBeInTheDocument()
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
    expect(shareApi.accessPublicShare).not.toHaveBeenCalled()
  })

  it('opens the item once the right password is supplied', async () => {
    shareApi.getPublicShare.mockResolvedValue({
      resourceType: 'file',
      requiresPassword: true,
      expiresAt: null,
    })
    shareApi.accessPublicShare.mockResolvedValue({
      resourceType: 'file',
      file,
      signedUrl: 'https://storage.test/report.pdf',
    })

    render(<PublicShareView token="abc" />)
    await screen.findByText(/this link is protected/i)

    await userEvent.type(screen.getByPlaceholderText('Password'), 'letmein')
    await userEvent.click(screen.getByRole('button', { name: /unlock/i }))

    expect(await screen.findByText('report.pdf')).toBeInTheDocument()
    expect(shareApi.accessPublicShare).toHaveBeenCalledWith('abc', 'letmein')
  })

  it('keeps the gate up and explains a wrong password', async () => {
    shareApi.getPublicShare.mockResolvedValue({
      resourceType: 'file',
      requiresPassword: true,
      expiresAt: null,
    })
    shareApi.accessPublicShare.mockRejectedValue(
      new ApiError('Incorrect password', 'INVALID_PASSWORD', 401)
    )

    render(<PublicShareView token="abc" />)
    await screen.findByText(/this link is protected/i)

    await userEvent.type(screen.getByPlaceholderText('Password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: /unlock/i }))

    expect(await screen.findByText('Incorrect password.')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()
  })

  it('reports an expired link as unavailable', async () => {
    shareApi.getPublicShare.mockRejectedValue(
      new ApiError('This link has expired', 'LINK_EXPIRED', 410)
    )

    render(<PublicShareView token="abc" />)

    expect(await screen.findByText('Link unavailable')).toBeInTheDocument()
    expect(screen.getByText('This link has expired.')).toBeInTheDocument()
  })

  it('reports a revoked link as unavailable', async () => {
    shareApi.getPublicShare.mockRejectedValue(
      new ApiError('gone', 'LINK_NOT_FOUND', 404)
    )

    render(<PublicShareView token="abc" />)

    expect(
      await screen.findByText('This link does not exist or has been revoked.')
    ).toBeInTheDocument()
  })

  it('lists a shared folder and walks into a subfolder', async () => {
    shareApi.getPublicShare.mockResolvedValue({
      resourceType: 'folder',
      requiresPassword: false,
      expiresAt: null,
      name: 'Shared',
    })
    shareApi.accessPublicShare.mockResolvedValue({
      resourceType: 'folder',
      folder: { id: 'folder-1', name: 'Shared', parent_id: null, created_at: '' },
      isRoot: true,
      children: {
        folders: [{ id: 'folder-2', name: 'Inner', parent_id: 'folder-1', created_at: '' }],
        files: [file],
      },
    })
    shareApi.browsePublicShare.mockResolvedValue({
      resourceType: 'folder',
      folder: { id: 'folder-2', name: 'Inner', parent_id: 'folder-1', created_at: '' },
      isRoot: false,
      children: { folders: [], files: [] },
    })

    render(<PublicShareView token="abc" />)

    expect(await screen.findByText('Inner')).toBeInTheDocument()
    expect(screen.getByText('report.pdf')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /inner/i }))

    await waitFor(() => expect(shareApi.browsePublicShare).toHaveBeenCalledWith('abc', 'folder-2', undefined))
    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument()
  })

  it('resends the password when walking into a subfolder', async () => {
    shareApi.getPublicShare.mockResolvedValue({
      resourceType: 'folder',
      requiresPassword: true,
      expiresAt: null,
    })
    shareApi.accessPublicShare.mockResolvedValue({
      resourceType: 'folder',
      folder: { id: 'folder-1', name: 'Shared', parent_id: null, created_at: '' },
      isRoot: true,
      children: {
        folders: [{ id: 'folder-2', name: 'Inner', parent_id: 'folder-1', created_at: '' }],
        files: [],
      },
    })
    shareApi.browsePublicShare.mockResolvedValue({
      resourceType: 'folder',
      folder: { id: 'folder-2', name: 'Inner', parent_id: 'folder-1', created_at: '' },
      isRoot: false,
      children: { folders: [], files: [] },
    })

    render(<PublicShareView token="abc" />)
    await screen.findByText(/this link is protected/i)
    await userEvent.type(screen.getByPlaceholderText('Password'), 'letmein')
    await userEvent.click(screen.getByRole('button', { name: /unlock/i }))

    await userEvent.click(await screen.findByRole('button', { name: /inner/i }))

    await waitFor(() =>
      expect(shareApi.browsePublicShare).toHaveBeenCalledWith('abc', 'folder-2', 'letmein')
    )
  })

  it('fetches a fresh signed URL when downloading', async () => {
    shareApi.getPublicShare.mockResolvedValue({
      resourceType: 'file',
      requiresPassword: false,
      expiresAt: null,
      name: 'report.pdf',
    })
    shareApi.accessPublicShare.mockResolvedValue({
      resourceType: 'file',
      file,
      signedUrl: 'https://storage.test/stale',
    })
    shareApi.getPublicFile.mockResolvedValue({ file, signedUrl: 'https://storage.test/fresh' })

    render(<PublicShareView token="abc" />)
    await userEvent.click(await screen.findByRole('button', { name: /download/i }))

    await waitFor(() => expect(shareApi.getPublicFile).toHaveBeenCalledWith('abc', 'file-1', undefined))
    expect(window.open).toHaveBeenCalledWith(
      'https://storage.test/fresh',
      '_blank',
      'noopener,noreferrer'
    )
  })

  it('shows the expiry date when the link has one', async () => {
    shareApi.getPublicShare.mockResolvedValue({
      resourceType: 'file',
      requiresPassword: false,
      expiresAt: '2030-01-01T00:00:00.000Z',
      name: 'report.pdf',
    })
    shareApi.accessPublicShare.mockResolvedValue({
      resourceType: 'file',
      file,
      signedUrl: 'https://storage.test/report.pdf',
    })

    render(<PublicShareView token="abc" />)

    expect(await screen.findByText(/link expires/i)).toBeInTheDocument()
  })
})
