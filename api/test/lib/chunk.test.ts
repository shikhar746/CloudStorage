import { describe, it, expect } from 'vitest'
import { chunk } from '../../src/lib/chunk.js'

describe('chunk', () => {
  it('splits into batches of at most the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns nothing for an empty list', () => {
    expect(chunk([], 10)).toEqual([])
  })

  it('returns one batch when the list fits', () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]])
  })

  it('splits exactly on the boundary without a trailing empty batch', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })

  it('preserves order across batches', () => {
    const items = Array.from({ length: 250 }, (_, i) => i)
    expect(chunk(items, 100).flat()).toEqual(items)
  })
})
