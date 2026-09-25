import 'dotenv/config'

// Missing required vars are collected instead of thrown one at a time, so a
// failed deploy reports every gap in a single log line rather than making you
// redeploy once per variable.
const missing: string[] = []

// required (name) helper
// records the name if the value is missing; the collected list is thrown below
function required(name: string): string {
    const value = process.env[name]
    if (!value) {
        missing.push(name)
        return ''
    }
    return value
}

// optionalNumber(name, fallback, options)
// Reads a numeric setting, rejecting anything that is not a whole number.
// `min` is 1 by default because most of these are sizes and windows where zero
// is meaningless; the purge interval passes 0 to mean "switched off", which is
// a real setting rather than a mistake.
function optionalNumber(name: string, fallback: number, options: { min?: number } = {}): number {
    const min = options.min ?? 1
    const value = process.env[name]
    if (value === undefined || value.trim() === '') return fallback
    const n = Number(value)
    if (!Number.isInteger(n) || n < min)
        throw new Error(
            `Environment variable ${name} must be an integer of at least ${min}, got: ${value}`
        )
    return n
}

// helper for cors origin (comma separated env values)
// and return array of strings
function optionalStringArray(name: string, fallback: string[]): string[] {
    const v = process.env[name]
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback
}

// optionalString(name)
// helper for settings a deployment may simply not use — Google sign-in is off
// unless a client id is configured, so this returns undefined instead of throwing
function optionalString(name: string): string | undefined {
    const v = process.env[name]?.trim()
    return v ? v : undefined
}

const DURATION_UNIT_MS: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
}

// optionalDuration(name, fallback)
// helper for token TTLs, e.g. "15m", "1h", "7d" — returns both the raw
// string (for jsonwebtoken's expiresIn) and the millisecond value (for
// cookie maxAge), so the two never drift apart
function optionalDuration(name: string, fallback: string): { raw: string; ms: number } {
    const raw = process.env[name] ?? fallback
    const match = /^(\d+)(s|m|h|d)$/.exec(raw)
    if (!match)
        throw new Error(`Environment variable ${name} must look like "15m", "1h", or "7d", got: ${raw}`)
    const [, amount, unit] = match as unknown as [string, string, string]
    return { raw, ms: Number(amount) * DURATION_UNIT_MS[unit]! }
}

// trailing slashes on a pasted dashboard value would turn every allowed origin
// into one the browser never sends, so they are stripped here once
function normalizeOrigin(origin: string): string {
    return origin.replace(/\/+$/, '')
}

export const env = {
    // server
    PORT: optionalNumber('PORT', 8080),
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    // comma-separated list of browser origins allowed to call this API with
    // credentials. Entries may use "*" as a wildcard segment so one line can
    // cover every Vercel preview deploy, e.g. https://*.vercel.app
    // The deployed frontend is listed by exact origin rather than a
    // "https://*.vercel.app" wildcard: this API sends credentials, and that
    // wildcard would let any site on vercel.app call it with the user's
    // cookies. Add preview URLs by setting CORS_ORIGIN, which replaces this
    // list entirely.
    CORS_ORIGIN: optionalStringArray('CORS_ORIGIN', [
        'http://localhost:5173',
        'http://localhost:3000',
        'https://cloud-storage-api-six.vercel.app',
    ]).map(normalizeOrigin),
    // auth
    JWT_SECRET: required('JWT_SECRET'),
    REFRESH_SECRET: required('REFRESH_SECRET'),
    ACCESS_TOKEN_TTL: optionalDuration('ACCESS_TOKEN_TTL', '15m'),
    REFRESH_TOKEN_TTL: optionalDuration('REFRESH_TOKEN_TTL', '7d'),
    // Google sign-in (optional — POST /api/auth/google is disabled without it).
    // Only the client id is needed: the browser gets the ID token from Google
    // Identity Services and this API only verifies its signature against
    // Google's public certs. There is no code exchange, so no client secret.
    GOOGLE_CLIENT_ID: optionalString('GOOGLE_CLIENT_ID'),
    // rate limiting
    // window and ceiling for the guessing-prone endpoints: sign-in,
    // registration, and opening a password-protected share link
    RATE_LIMIT_WINDOW_MINUTES: optionalNumber('RATE_LIMIT_WINDOW_MINUTES', 15),
    RATE_LIMIT_MAX: optionalNumber('RATE_LIMIT_MAX', 10),

    // trash retention
    // how long a soft-deleted item survives before the sweeper removes it and
    // its stored blob for good
    TRASH_RETENTION_DAYS: optionalNumber('TRASH_RETENTION_DAYS', 30),
    // how often the in-process sweeper runs. 0 switches it off, which is what
    // you want when an external scheduler drives the purge instead.
    TRASH_PURGE_INTERVAL_MINUTES: optionalNumber('TRASH_PURGE_INTERVAL_MINUTES', 360, { min: 0 }),
    // shared secret for POST /api/maintenance/purge-trash. Unset disables the
    // endpoint entirely rather than leaving it open.
    PURGE_SECRET: optionalString('PURGE_SECRET'),

    // supabase
    SUPABASE_URL: required('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
    SUPABASE_STORAGE_BUCKET: required('SUPABASE_STORAGE_BUCKET'),

    // uploads
    // anything at or under this goes through the API as multipart (multer buffers
    // it in memory); anything larger must use the signed-URL path straight to storage
    MAX_FILE_SIZE_BYTES: optionalNumber('MAX_FILE_SIZE_BYTES', 52_428_800),
    // ceiling for the direct-to-storage path — must not exceed the bucket's own
    // file size limit, or the signed upload is rejected by storage instead
    MAX_DIRECT_UPLOAD_BYTES: optionalNumber('MAX_DIRECT_UPLOAD_BYTES', 5_368_709_120),
} as const

if (missing.length > 0) {
    throw new Error(
        `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
        `Set ${missing.length > 1 ? 'them' : 'it'} in the host's environment (Render: Settings > Environment) or in api/.env locally.`
    )
}
