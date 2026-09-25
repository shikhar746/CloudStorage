import express from 'express'
import {
  getPublicShareController,
  accessPublicShareController,
  browsePublicShareController,
  publicFileController,
} from '../controllers/publicShare.controller.js'
import { publicShareLimiter } from '../middleware/rateLimit.js'
import { resolvePublicLink } from '../middleware/resolvePublicLink.js'

const router = express.Router()

// Deliberately NO requireAuth on this router: holding the token IS the
// credential. `resolvePublicLink` re-checks the token, its expiry and its
// password on every single call rather than trusting a previous one — and
// because it is wired in here, a route added later cannot forget to.
//
// Every route is rate limited, the metadata read included: it is unauthenticated
// and answers questions about a bearer token, which is exactly the shape that
// invites being hammered.
router.use(publicShareLimiter)

// what this link is, without revealing anything a password should protect.
// The one route not behind resolvePublicLink — it has to answer before the
// visitor knows whether a password is even needed.
router.get('/:token', getPublicShareController)

// open it: a signed URL for a file, or a listing for a folder
router.post('/:token/access', resolvePublicLink, accessPublicShareController)

// walk into a subfolder of a shared folder
router.post('/:token/folder/:folderId', resolvePublicLink, browsePublicShareController)

// download one file reached through the link
router.post('/:token/file/:fileId', resolvePublicLink, publicFileController)

export default router
