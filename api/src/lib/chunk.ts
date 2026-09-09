/**
 * Splits a list into batches.
 *
 * Both bulk paths need it for the same reason: a few thousand storage keys in
 * one `remove`, or a few thousand ids in one `in(...)` filter, is asking for a
 * timeout — and in the `in(...)` case, a URL longer than the server will accept.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
