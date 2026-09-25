import { describe, it, expect } from 'vitest'
import { mergeItemRows, itemRowKey } from '../src/utils/itemRows'

describe('mergeItemRows', () => {
  it('tags each row with its kind, folders first', () => {
    const rows = mergeItemRows(
      [{ id: 'f1', name: 'Folder' }],
      [{ id: 'd1', name: 'file.txt' }]
    )

    expect(rows).toEqual([
      { id: 'f1', name: 'Folder', itemType: 'folder' },
      { id: 'd1', name: 'file.txt', itemType: 'file' },
    ])
  })

  it('narrows on the tag', () => {
    const rows = mergeItemRows([{ id: 'f1', name: 'Folder' }], [{ id: 'd1', size_bytes: 10 }])
    const row = rows[1]!

    // the discriminant is what makes `size_bytes` reachable without a cast
    if (row.itemType === 'file') expect(row.size_bytes).toBe(10)
    else throw new Error('expected the second row to be a file')
  })

  it('handles either side being empty', () => {
    expect(mergeItemRows([], [])).toEqual([])
    expect(mergeItemRows([{ id: 'f1' }], [])).toHaveLength(1)
    expect(mergeItemRows([], [{ id: 'd1' }])).toHaveLength(1)
  })

  it('does not mutate the inputs', () => {
    const folders = [{ id: 'f1' }]
    mergeItemRows(folders, [])
    expect(folders[0]).toEqual({ id: 'f1' })
  })
})

describe('itemRowKey', () => {
  it('keeps a file and a folder sharing an id apart', () => {
    // ids are only unique within their own table, so the kind has to be in the key
    expect(itemRowKey({ itemType: 'folder', id: 'same' })).not.toBe(
      itemRowKey({ itemType: 'file', id: 'same' })
    )
  })
})
