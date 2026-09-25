import type { ShareLinkRow } from '../middleware/resolvePublicLink.js'

declare global {
    namespace Express {
        interface Request {
            /** Set by requireAuth. Present on every authenticated route. */
            userId: string
            /**
             * Set by resolvePublicLink, after the token, expiry and password
             * have all been checked. Present on every route behind it.
             */
            shareLink: ShareLinkRow
        }
    }
}


export {}
