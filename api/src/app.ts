import express from 'express'
import type { Request, Response } from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './config/env.js'
import authRoutes from './routes/auth.routes.js'
import folderRoutes from './routes/folder.routes.js'
import fileRoutes from './routes/file.routes.js'
import { errorHandler } from './middleware/errorHandler.js'
import searchRoutes from "./routes/search.routes.js"
import shareRoutes from './routes/share.routes.js'
import userRoutes from './routes/user.routes.js'
import starRoutes from './routes/star.routes.js'
import maintenanceRoutes from './routes/maintenance.routes.js'
import shareLinkRoutes from './routes/shareLink.routes.js'
import publicShareRoutes from './routes/publicShare.routes.js'

const app = express()

// The built web client, when this service serves it too. Resolved from this
// module rather than the working directory, so it lands in the same place run
// from api/src (tsx) and api/dist (node). If it is absent — an API-only
// deploy, or `web` was never built — every block guarded by this is skipped
// and the server behaves exactly as it did before.
const webDist = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'web', 'dist')
const webIndex = path.join(webDist, 'index.html')
const hasWebBuild = fs.existsSync(webIndex)

/** Where the bundle is served from, or null on an API-only deploy. */
export const webBundle = hasWebBuild ? webDist : null

// Render/Vercel terminate TLS in front of the app; without this Express sees
// every request as plain http and req.ip is the proxy's address
app.set('trust proxy', 1)

// An allowed origin may contain "*" as a wildcard, so a single CORS_ORIGIN
// entry can cover every Vercel preview URL (https://*.vercel.app). Matching
// walks the literal segments in order instead of building a regex, so a dot
// in a hostname is never read as "any character".
function originMatches(pattern: string, origin: string): boolean {
  if (!pattern.includes('*')) return pattern === origin

  const segments = pattern.split('*')
  const head = segments[0]!
  const tail = segments[segments.length - 1]!
  if (!origin.startsWith(head) || !origin.endsWith(tail)) return false
  // head and tail must not overlap, or "https://*.vercel.app" would accept
  // a bare "https://.vercel.app" style origin twice over
  if (head.length + tail.length > origin.length) return false

  let cursor = head.length
  const limit = origin.length - tail.length
  for (const segment of segments.slice(1, -1)) {
    const found = origin.indexOf(segment, cursor)
    if (found === -1 || found + segment.length > limit) return false
    cursor = found + segment.length
  }
  return true
}

// Only cross-origin callers need this: when the bundle ships from this same
// service the browser sends no Origin header on same-site requests at all.
// It still matters for local dev (vite on :3000, api on :8080) and for a
// split deploy, so the allow-list stays.
app.use(cors({
  origin(origin, callback) {
    // no Origin header at all: curl, server-to-server, Render's health check
    if (!origin) return callback(null, true)
    // reflect the caller's own origin — a literal "*" is illegal alongside
    // credentials, and the browser needs the exact origin echoed back
    if (env.CORS_ORIGIN.some((pattern) => originMatches(pattern, origin))) return callback(null, true)
    // deny without throwing: the response simply carries no CORS headers,
    // which the browser blocks, instead of turning into a 500
    return callback(null, false)
  },
  credentials: true,   // the auth tokens ride in httpOnly cookies
}))

//--------->Auth routes<------------//

app.use(express.json())
app.use(cookieParser())

// Liveness plus the upload limits, which ride along so the web client can pick
// its upload path from the server's numbers instead of hard-coding them. It
// lives under /api because the SPA owns "/" whenever the two are served
// together.
function health(_req: Request, res: Response) {
    res.json({
        status: 'ok',
        limits: {
            maxFileSizeBytes: env.MAX_FILE_SIZE_BYTES,
            maxDirectUploadBytes: env.MAX_DIRECT_UPLOAD_BYTES,
        },
        // the web client tells the user how long trash survives
        trashRetentionDays: env.TRASH_RETENTION_DAYS,
    })
}

app.get('/api/health', health)
// an API-only deploy has nothing else to put at the root, and older clients
// still probe there
if (!hasWebBuild) app.get('/', health)

app.use('/api/auth', authRoutes)

//--------->Folder routes<------------//
app.use('/api/folders', folderRoutes)

// ---------> Files routes <--------- //
app.use("/api/files", fileRoutes)

app.use('/api/search', searchRoutes)

app.use('/api/shares', shareRoutes)

app.use('/api/users', userRoutes)

app.use('/api/stars', starRoutes)

app.use('/api/share-links', shareLinkRoutes)

// unauthenticated by design — the token in the path is the credential
app.use('/api/public', publicShareRoutes)

app.use('/api/maintenance', maintenanceRoutes)

// ---------> Web client <--------- //
// Serving the bundle from this origin is the point of the single-service
// deploy: it makes the auth cookies first-party. Hosted on a separate site
// they are third-party cookies, which Safari, Brave and any blocker extension
// drop outright — login returns 200 and the next request is still a 401.
if (hasWebBuild) {
    app.use(express.static(webDist, { index: false }))

    // client-side routing: a GET matching no file and no API route is a deep
    // link into the SPA and must be answered with index.html, not a 404
    app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        if (req.path.startsWith('/api/')) return next()
        res.sendFile(webIndex)
    })
}

app.use((_req, res) => {
    res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Route not found' },
    })
})  

app.use(errorHandler)
export default app
