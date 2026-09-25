import type { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import { supabase } from '../lib/supabase.js'
import { publicAccessSchema } from '../schemas/shareLink.schema.js'

export interface ShareLinkRow {
  id: string
  token: string
  resource_type: 'file' | 'folder'
  resource_id: string
  password_hash: string | null
  expires_at: string | null
}

/**
 * Loads a share link by its token and enforces existence and expiry.
 *
 * Separate from the password check because the metadata endpoint has to be
 * able to say "this one needs a password" without having been given one.
 */
export async function loadShareLink(token: string): Promise<ShareLinkRow | null> {
  const { data, error } = await supabase
    .from('share_links')
    .select('id, token, resource_type, resource_id, password_hash, expires_at')
    .eq('token', token)
    .maybeSingle()

  // A failed query and a genuinely absent link both end up denying access,
  // which is the right default — but only one of them is a bug, so say which.
  if (error) console.error('share link lookup failed', error)

  return (data as ShareLinkRow | null) ?? null
}

export function linkHasExpired(link: ShareLinkRow): boolean {
  return Boolean(link.expires_at && new Date(link.expires_at).getTime() <= Date.now())
}

/**
 * Resolves the link a public request is addressed to, or ends the request.
 *
 * Every public endpoint needs the same four things to have happened before it
 * can do anything: the body parsed, the token resolved, the expiry checked and
 * the password verified. Doing that here rather than at the top of each handler
 * is not only shorter — it means a new public route cannot be added that
 * forgets the password check, which would be a silent authorisation bypass
 * rather than a visible bug. `requireAuth` earns its keep the same way on the
 * authenticated side.
 *
 * Deliberately not a session: holding the token is the credential, and it is
 * re-checked on every single call rather than exchanged for something durable.
 */
export async function resolvePublicLink(req: Request, res: Response, next: NextFunction) {
  const parsed = publicAccessSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', issues: parsed.error.issues },
    })
  }

  const link = await loadShareLink(req.params.token as string)

  if (!link) {
    return res.status(404).json({
      error: { code: 'LINK_NOT_FOUND', message: 'This link does not exist' },
    })
  }

  // 410 rather than 404: the link genuinely existed, and telling the visitor it
  // expired is more useful than pretending it was never real
  if (linkHasExpired(link)) {
    return res.status(410).json({
      error: { code: 'LINK_EXPIRED', message: 'This link has expired' },
    })
  }

  const supplied = parsed.data.password
  const accepted = !link.password_hash
    ? true
    : supplied
      ? await bcrypt.compare(supplied, link.password_hash)
      : false

  if (!accepted) {
    return res.status(401).json({
      error: { code: 'INVALID_PASSWORD', message: 'Incorrect password' },
    })
  }

  req.shareLink = link
  next()
}
