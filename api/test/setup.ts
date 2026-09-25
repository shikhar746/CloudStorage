/**
 * Test environment, applied before any test file imports application code.
 *
 * Two jobs, both order-sensitive:
 *
 *  1. `config/env.ts` validates required variables at import time and throws on
 *     a gap, so the values have to exist before anything pulls that module in.
 *     `dotenv` never overwrites a variable that is already set, which is what
 *     keeps a developer's real `api/.env` out of the test run.
 *  2. The Supabase client is replaced with the in-memory fake. Mocking the
 *     module rather than threading a client parameter through every controller
 *     keeps production signatures honest: nothing in `src` knows tests exist.
 */
process.env.NODE_ENV ??= 'test'
process.env.SUPABASE_URL = 'https://project.supabase.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-for-tests'
process.env.SUPABASE_STORAGE_BUCKET = 'test-bucket'
process.env.JWT_SECRET = 'access-secret-for-tests-only-0000000000'
process.env.REFRESH_SECRET = 'refresh-secret-for-tests-only-000000000'
process.env.TRASH_RETENTION_DAYS = '30'
// the in-process sweeper must never start on its own during a test run
process.env.TRASH_PURGE_INTERVAL_MINUTES = '0'
process.env.PURGE_SECRET = 'purge-secret-for-tests'
process.env.RATE_LIMIT_WINDOW_MINUTES = '15'
// high enough that ordinary tests never trip it; the limiter tests set their own
process.env.RATE_LIMIT_MAX = '1000'

import { vi } from 'vitest'
import { fakeDb } from './fakeSupabase.js'

vi.mock('../src/lib/supabase.js', () => ({ supabase: fakeDb }))
