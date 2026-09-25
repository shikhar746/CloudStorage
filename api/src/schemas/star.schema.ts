import { z } from 'zod'

/**
 * A star is identified by the (type, id) pair wherever it appears.
 *
 * The same shape arrives as a JSON body on POST and as route params on DELETE,
 * and zod validates both identically, so this is one schema under two names
 * rather than two definitions that could drift apart.
 */
export const starResourceSchema = z.object({
  resourceType: z.enum(['file', 'folder']),
  resourceId: z.uuid(),
})

export const createStarSchema = starResourceSchema
export const starParamsSchema = starResourceSchema

export type StarResource = z.infer<typeof starResourceSchema>
export type CreateStarInput = StarResource
