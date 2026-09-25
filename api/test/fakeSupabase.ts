/**
 * An in-memory stand-in for the Supabase client.
 *
 * Deliberately a tiny database rather than a pile of mock assertions: the
 * behaviour these tests exist to protect is relational. The purge has to delete
 * blobs before rows because the folder cascade destroys the only record of
 * where those blobs live; the restore paths turn on a partial unique index that
 * only covers live rows. A mock that records calls cannot tell you whether any
 * of that still works, so this models the parts of Postgres the code relies on:
 *
 *  - `on delete cascade` from folders to child folders and files
 *  - the partial unique index on folders(owner_id, parent_id, name)
 *  - unique columns (files.storage_key, users.email, share_links.token)
 *  - composite primary keys, for `stars` upserts
 *
 * It covers only the query-builder surface this codebase actually uses.
 */

type Row = Record<string, any>

interface PgError {
  code: string
  message: string
}

const UNIQUE_VIOLATION = '23505'
const NO_ROWS = 'PGRST116'

/** Unique constraints, as the migrations declare them. */
interface UniqueSpec {
  columns: string[]
  /** Partial index predicate; rows failing it are not covered. */
  where?: (row: Row) => boolean
}

const UNIQUE: Record<string, UniqueSpec[]> = {
  // create unique index folders_unique_name_per_parent
  //   on folders(owner_id, parent_id, name) where is_deleted = false
  folders: [
    {
      columns: ['owner_id', 'parent_id', 'name'],
      where: (row) => row.is_deleted === false,
    },
  ],
  files: [{ columns: ['storage_key'] }],
  users: [{ columns: ['email'] }],
  stars: [{ columns: ['user_id', 'resource_type', 'resource_id'] }],
  share_links: [{ columns: ['token'] }],
  pending_uploads: [{ columns: ['storage_key'] }],
}

let clock = 0
/** Monotonic timestamps, so `order('created_at')` is deterministic. */
function now(): string {
  clock += 1000
  return new Date(Date.UTC(2024, 0, 1) + clock).toISOString()
}

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`
}

/** Column defaults applied on insert, mirroring the schema. */
const DEFAULTS: Record<string, () => Row> = {
  folders: () => ({ is_deleted: false, deleted_at: null, parent_id: null, created_at: now() }),
  files: () => ({ is_deleted: false, deleted_at: null, folder_id: null, created_at: now() }),
  stars: () => ({ created_at: now() }),
  share_links: () => ({
    password_hash: null,
    expires_at: null,
    last_used_at: null,
    created_at: now(),
  }),
  pending_uploads: () => ({ created_at: now() }),
  users: () => ({ created_at: now() }),
  shares: () => ({ created_at: now() }),
}

/** Parses the top-level columns of a select string, skipping nested joins. */
function topLevelColumns(select: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of select) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out.filter((c) => !c.includes('('))
}

/** `users!grantee_user_id(id, email, name)` -> one embedded-resource spec. */
interface JoinSpec {
  table: string
  foreignKey: string
  columns: string[]
}

function parseJoins(select: string): JoinSpec[] {
  const joins: JoinSpec[] = []
  const pattern = /(\w+)!(\w+)\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(select)) !== null) {
    joins.push({
      table: match[1]!,
      foreignKey: match[2]!,
      columns: match[3]!.split(',').map((c) => c.trim()),
    })
  }
  return joins
}

function project(row: Row, columns: string[]): Row {
  if (columns.length === 0 || columns.includes('*')) return { ...row }
  const out: Row = {}
  for (const column of columns) {
    if (column in row) out[column] = row[column]
  }
  return out
}

export class FakeSupabase {
  tables = new Map<string, Row[]>()
  /** storage key -> object metadata */
  objects = new Map<string, { size: number; contentType: string }>()
  /** Queries the next call on a table should fail, for resilience tests. */
  private pendingFailures = new Map<string, PgError>()
  /** Every storage `remove` batch, so tests can assert chunking. */
  removeBatches: string[][] = []

  reset(): void {
    this.tables.clear()
    this.objects.clear()
    this.pendingFailures.clear()
    this.removeBatches = []
    clock = 0
    idCounter = 0
  }

  rows(table: string): Row[] {
    let rows = this.tables.get(table)
    if (!rows) {
      rows = []
      this.tables.set(table, rows)
    }
    return rows
  }

  /** Inserts rows directly, bypassing the builder. Returns them with ids. */
  seed(table: string, rows: Row[]): Row[] {
    const made = rows.map((row) => ({
      id: row.id ?? newId(),
      ...(DEFAULTS[table]?.() ?? {}),
      ...row,
    }))
    this.rows(table).push(...made)
    return made
  }

  /** Puts an object in the bucket without going through an upload. */
  seedObject(key: string, size = 1024, contentType = 'application/octet-stream'): void {
    this.objects.set(key, { size, contentType })
  }

  /** Makes the next query against `table` return an error. */
  failNext(table: string, error: Partial<PgError> = {}): void {
    this.pendingFailures.set(table, {
      code: error.code ?? 'XX000',
      message: error.message ?? `injected failure on ${table}`,
    })
  }

  takeFailure(table: string): PgError | null {
    const failure = this.pendingFailures.get(table)
    if (!failure) return null
    this.pendingFailures.delete(table)
    return failure
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table)
  }

  get storage() {
    const self = this
    return {
      from(_bucket: string) {
        return {
          async upload(key: string, _body: unknown, opts?: { upsert?: boolean }) {
            if (self.objects.has(key) && !opts?.upsert) {
              return { data: null, error: { message: 'The resource already exists' } }
            }
            self.objects.set(key, { size: 1024, contentType: 'application/octet-stream' })
            return { data: { path: key }, error: null }
          },
          async remove(keys: string[]) {
            self.removeBatches.push([...keys])
            const failure = self.takeFailure('__storage__')
            if (failure) return { data: null, error: failure }
            for (const key of keys) self.objects.delete(key)
            return { data: keys.map((key) => ({ name: key })), error: null }
          },
          async createSignedUrl(key: string, ttl: number) {
            if (!self.objects.has(key)) {
              return { data: null, error: { message: 'Object not found' } }
            }
            return { data: { signedUrl: `https://storage.test/${key}?ttl=${ttl}` }, error: null }
          },
          async createSignedUploadUrl(key: string) {
            return {
              data: {
                path: key,
                token: `token-for-${key}`,
                signedUrl: `https://storage.test/upload/${key}`,
              },
              error: null,
            }
          },
          async info(key: string) {
            const object = self.objects.get(key)
            if (!object) return { data: null, error: { message: 'Object not found' } }
            return { data: { size: object.size, contentType: object.contentType }, error: null }
          },
        }
      },
    }
  }
}

type Filter = (row: Row) => boolean

class FakeQuery implements PromiseLike<{ data: any; error: PgError | null }> {
  private operation: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  private filters: Filter[] = []
  private selectString: string | null = null
  private payload: Row | Row[] | null = null
  private conflictColumns: string[] | null = null
  private orderBy: { column: string; ascending: boolean } | null = null
  private limitCount: number | null = null
  private cardinality: 'many' | 'single' | 'maybe' = 'many'

  constructor(private db: FakeSupabase, private table: string) {}

  select(selectString = '*'): this {
    this.selectString = selectString
    return this
  }

  insert(payload: Row | Row[]): this {
    this.operation = 'insert'
    this.payload = payload
    return this
  }

  upsert(payload: Row | Row[], options?: { onConflict?: string }): this {
    this.operation = 'upsert'
    this.payload = payload
    this.conflictColumns = options?.onConflict
      ? options.onConflict.split(',').map((c) => c.trim())
      : null
    return this
  }

  update(payload: Row): this {
    this.operation = 'update'
    this.payload = payload
    return this
  }

  delete(): this {
    this.operation = 'delete'
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value)
    return this
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value)
    return this
  }

  is(column: string, value: null | boolean): this {
    this.filters.push((row) => (row[column] ?? null) === value)
    return this
  }

  in(column: string, values: unknown[]): this {
    const set = new Set(values)
    this.filters.push((row) => set.has(row[column]))
    return this
  }

  lt(column: string, value: string | number): this {
    this.filters.push((row) => row[column] !== null && row[column] < value)
    return this
  }

  lte(column: string, value: string | number): this {
    this.filters.push((row) => row[column] !== null && row[column] <= value)
    return this
  }

  gt(column: string, value: string | number): this {
    this.filters.push((row) => row[column] !== null && row[column] > value)
    return this
  }

  gte(column: string, value: string | number): this {
    this.filters.push((row) => row[column] !== null && row[column] >= value)
    return this
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: options?.ascending ?? true }
    return this
  }

  limit(count: number): this {
    this.limitCount = count
    return this
  }

  single(): this {
    this.cardinality = 'single'
    return this
  }

  maybeSingle(): this {
    this.cardinality = 'maybe'
    return this
  }

  then<TResult1 = { data: any; error: PgError | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: any; error: PgError | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.run())
      .then(onfulfilled, onrejected)
  }

  private matching(): Row[] {
    return this.db.rows(this.table).filter((row) => this.filters.every((f) => f(row)))
  }

  /** Rows that would collide with `candidate` on any unique constraint. */
  private violates(candidate: Row, ignore?: Row): PgError | null {
    for (const spec of UNIQUE[this.table] ?? []) {
      if (spec.where && !spec.where(candidate)) continue
      const clash = this.db.rows(this.table).some((row) => {
        if (row === ignore) return false
        if (spec.where && !spec.where(row)) return false
        return spec.columns.every((column) => (row[column] ?? null) === (candidate[column] ?? null))
      })
      if (clash) {
        return {
          code: UNIQUE_VIOLATION,
          message: `duplicate key value violates unique constraint on ${spec.columns.join(', ')}`,
        }
      }
    }
    return null
  }

  /** `on delete cascade`: folders take their subfolders and files with them. */
  private cascadeDelete(removed: Row[]): void {
    if (this.table === 'folders') {
      const ids = new Set(removed.map((row) => row.id))
      if (ids.size === 0) return

      const files = this.db.rows('files')
      const remainingFiles = files.filter((row) => !ids.has(row.folder_id))
      files.length = 0
      files.push(...remainingFiles)

      const folders = this.db.rows('folders')
      const childFolders = folders.filter((row) => ids.has(row.parent_id))
      if (childFolders.length > 0) {
        const remaining = folders.filter((row) => !childFolders.includes(row))
        folders.length = 0
        folders.push(...remaining)
        this.cascadeDelete(childFolders)
      }
    }

    if (this.table === 'users') {
      const ids = new Set(removed.map((row) => row.id))
      const ownerColumn: Record<string, string> = {
        folders: 'owner_id',
        files: 'owner_id',
        stars: 'user_id',
        share_links: 'created_by',
      }
      for (const [table, column] of Object.entries(ownerColumn)) {
        const rows = this.db.rows(table)
        const remaining = rows.filter((row) => !ids.has(row[column]))
        rows.length = 0
        rows.push(...remaining)
      }
    }
  }

  private finish(rows: Row[]): { data: any; error: PgError | null } {
    // A write with no .select() reports nothing but the error slot.
    if (this.operation !== 'select' && this.selectString === null) {
      return { data: null, error: null }
    }

    let result = rows
    if (this.orderBy) {
      const { column, ascending } = this.orderBy
      result = [...result].sort((a, b) => {
        const left = a[column] ?? ''
        const right = b[column] ?? ''
        if (left === right) return 0
        return (left < right ? -1 : 1) * (ascending ? 1 : -1)
      })
    }
    if (this.limitCount !== null) result = result.slice(0, this.limitCount)

    const select = this.selectString ?? '*'
    const columns = select === '*' ? [] : topLevelColumns(select)
    const joins = parseJoins(select)

    const projected = result.map((row) => {
      const out = project(row, columns)
      for (const join of joins) {
        const target = this.db
          .rows(join.table)
          .find((candidate) => candidate.id === row[join.foreignKey])
        out[join.table] = target ? project(target, join.columns) : null
      }
      return out
    })

    if (this.cardinality === 'single') {
      if (projected.length !== 1) {
        return {
          data: null,
          error: {
            code: NO_ROWS,
            message: `JSON object requested, ${projected.length} rows returned`,
          },
        }
      }
      return { data: projected[0], error: null }
    }

    if (this.cardinality === 'maybe') {
      if (projected.length > 1) {
        return { data: null, error: { code: NO_ROWS, message: 'multiple rows returned' } }
      }
      return { data: projected[0] ?? null, error: null }
    }

    return { data: projected, error: null }
  }

  private run(): { data: any; error: PgError | null } {
    const failure = this.db.takeFailure(this.table)
    if (failure) return { data: null, error: failure }

    switch (this.operation) {
      case 'select':
        return this.finish(this.matching())

      case 'insert': {
        const incoming = Array.isArray(this.payload) ? this.payload : [this.payload!]
        const made: Row[] = []
        for (const item of incoming) {
          const row = { id: newId(), ...(DEFAULTS[this.table]?.() ?? {}), ...item }
          const violation = this.violates(row)
          if (violation) return { data: null, error: violation }
          this.db.rows(this.table).push(row)
          made.push(row)
        }
        return this.finish(made)
      }

      case 'upsert': {
        const incoming = Array.isArray(this.payload) ? this.payload : [this.payload!]
        const keys = this.conflictColumns ?? ['id']
        const touched: Row[] = []
        for (const item of incoming) {
          const existing = this.db
            .rows(this.table)
            .find((row) => keys.every((key) => row[key] === item[key]))
          if (existing) {
            Object.assign(existing, item)
            touched.push(existing)
            continue
          }
          const row = { id: newId(), ...(DEFAULTS[this.table]?.() ?? {}), ...item }
          this.db.rows(this.table).push(row)
          touched.push(row)
        }
        return this.finish(touched)
      }

      case 'update': {
        const targets = this.matching()
        for (const row of targets) {
          const candidate = { ...row, ...(this.payload as Row) }
          const violation = this.violates(candidate, row)
          if (violation) return { data: null, error: violation }
        }
        for (const row of targets) Object.assign(row, this.payload)
        return this.finish(targets)
      }

      case 'delete': {
        const targets = this.matching()
        const rows = this.db.rows(this.table)
        const remaining = rows.filter((row) => !targets.includes(row))
        rows.length = 0
        rows.push(...remaining)
        this.cascadeDelete(targets)
        return this.finish(targets)
      }
    }
  }
}

export const fakeDb = new FakeSupabase()
