import { describe, it, expect } from 'vitest'
import {
  collectDroppedEntries,
  fromFileList,
  relativeFolderPath,
} from '../src/utils/dropEntries'

/** A File carrying the webkitRelativePath a directory picker would set. */
function pickedFile(name: string, relativePath?: string): File {
  const file = new File(['x'], name)
  if (relativePath !== undefined) {
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  }
  return file
}

/** Minimal stand-ins for the File System Entry API, which jsdom lacks. */
function fileEntry(name: string, fails = false) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (onSuccess: (file: File) => void, onError: () => void) =>
      fails ? onError() : onSuccess(new File(['x'], name)),
  }
}

function directoryEntry(name: string, children: unknown[], batchSize = 100) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let cursor = 0
      return {
        readEntries(onSuccess: (entries: unknown[]) => void) {
          const batch = children.slice(cursor, cursor + batchSize)
          cursor += batch.length
          onSuccess(batch)
        },
      }
    },
  }
}

function dataTransfer(entries: unknown[], files: File[] = []): DataTransfer {
  return {
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry })),
    files,
  } as unknown as DataTransfer
}

describe('relativeFolderPath', () => {
  it('drops the filename and keeps the folder chain', () => {
    expect(relativeFolderPath(pickedFile('a.txt', 'docs/notes/a.txt'))).toEqual(['docs', 'notes'])
  })

  it('returns nothing for a loose file', () => {
    expect(relativeFolderPath(pickedFile('a.txt'))).toEqual([])
  })

  it('returns nothing for a file at the picker root', () => {
    expect(relativeFolderPath(pickedFile('a.txt', 'a.txt'))).toEqual([])
  })

  it('ignores empty segments from a doubled separator', () => {
    expect(relativeFolderPath(pickedFile('a.txt', 'docs//notes/a.txt'))).toEqual(['docs', 'notes'])
  })
})

describe('fromFileList', () => {
  it('pairs each file with its folder chain', () => {
    const entries = fromFileList([
      pickedFile('a.txt', 'docs/a.txt'),
      pickedFile('b.txt'),
    ])

    expect(entries.map((e) => e.path)).toEqual([['docs'], []])
    expect(entries.map((e) => e.file.name)).toEqual(['a.txt', 'b.txt'])
  })
})

describe('collectDroppedEntries', () => {
  it('falls back to the flat file list when the entry API gives nothing', async () => {
    const result = await collectDroppedEntries(dataTransfer([], [pickedFile('loose.txt')]))

    expect(result.dirs).toEqual([])
    expect(result.entries.map((e) => e.file.name)).toEqual(['loose.txt'])
  })

  it('reads loose dropped files', async () => {
    const result = await collectDroppedEntries(dataTransfer([fileEntry('a.txt')]))

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.path).toEqual([])
  })

  it('walks a nested folder and records the path of every file', async () => {
    const tree = directoryEntry('docs', [
      fileEntry('top.txt'),
      directoryEntry('notes', [fileEntry('deep.txt')]),
    ])

    const result = await collectDroppedEntries(dataTransfer([tree]))

    expect(result.entries.map((e) => [...e.path, e.file.name].join('/')).sort()).toEqual([
      'docs/notes/deep.txt',
      'docs/top.txt',
    ])
    expect(result.dirs).toEqual([['docs'], ['docs', 'notes']])
  })

  it('records an empty folder so it can still be recreated', async () => {
    const result = await collectDroppedEntries(dataTransfer([directoryEntry('empty', [])]))

    expect(result.entries).toEqual([])
    expect(result.dirs).toEqual([['empty']])
  })

  it('keeps reading past the 100-entry batch limit', async () => {
    // readEntries hands back at most 100 children per call and signals the end
    // with an empty batch; calling it once would silently truncate the folder
    const children = Array.from({ length: 250 }, (_, i) => fileEntry(`f-${i}.txt`))
    const result = await collectDroppedEntries(dataTransfer([directoryEntry('big', children)]))

    expect(result.entries).toHaveLength(250)
  })

  it('loses only the unreadable file, not the whole drop', async () => {
    const tree = directoryEntry('docs', [fileEntry('good.txt'), fileEntry('bad.txt', true)])

    const result = await collectDroppedEntries(dataTransfer([tree]))

    expect(result.entries.map((e) => e.file.name)).toEqual(['good.txt'])
  })

  it('stops descending at the depth guard', async () => {
    // 40 levels deep, guard is 32
    let node = directoryEntry('level-40', [fileEntry('bottom.txt')])
    for (let i = 39; i > 0; i--) node = directoryEntry(`level-${i}`, [node])

    const result = await collectDroppedEntries(dataTransfer([node]))

    expect(result.entries).toHaveLength(0)
    expect(result.dirs.length).toBeLessThanOrEqual(33)
  })

  it('ignores dragged text, which reports no entry', async () => {
    const transfer = {
      items: [{ kind: 'string', webkitGetAsEntry: () => null }],
      files: [],
    } as unknown as DataTransfer

    const result = await collectDroppedEntries(transfer)

    expect(result).toEqual({ entries: [], dirs: [] })
  })

  it('survives a DataTransfer with no items at all', async () => {
    const result = await collectDroppedEntries({} as DataTransfer)
    expect(result).toEqual({ entries: [], dirs: [] })
  })
})
