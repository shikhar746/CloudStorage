import type { Request, Response } from "express";
import { createFolderSchema, updateFolderSchema } from "../schemas/folder.schema.js";
import { supabase } from "../lib/supabase.js";
import { attachStarred } from '../lib/stars.js'
import { getAccessRole } from "../lib/access.js"
import { collectSubtreeFolderIds, parentFolderIsUnavailable } from "../lib/folderTree.js"
import { hardDeleteResources } from "../lib/hardDelete.js"

const FOLDER_COLUMNS = "id, name, parent_id, owner_id, created_at"
const FILE_COLUMNS = "id, name, mime_type, size_bytes, folder_id, owner_id, created_at"

/** The 500 every read path in here returns, so the wording stays consistent. */
function internalError(res: Response, message: string) {
    return res.status(500).json({
        error: { code: "INTERNAL_ERROR", message },
    })
}

function folderNotFound(res: Response) {
    return res.status(404).json({
        error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
    })
}

export async function createFolderController(req:Request, res:Response){
    const { success, error, data } = createFolderSchema.safeParse(req.body)
    if (!success) {
        return res.status(400).json({
            error: { code: "VALIDATION_ERROR", issues: error.issues },
        })
    }
    const parentId = data.parentId ?? null
    if(parentId){
        // editors on a shared folder may create subfolders in it, same rule as
        // renaming or moving — see updateFolderController
        const parentRole = await getAccessRole(req.userId, 'folder', parentId)
        if (parentRole !== 'owner' && parentRole !== 'editor') {
            return res.status(404).json({
                error: { code: "PARENT_NOT_FOUND", message: "Parent folder not found" },
            })
        }
    }

    const { data: folder, error: folderError } = await supabase
        .from('folders')
        .insert({
            name: data.name,
            parent_id: parentId,
            owner_id: req.userId,
        })
        .select()
        .single()

    if (folderError) {
        if (folderError.code === "23505") {
            return res.status(409).json({
                error: { code: "FOLDER_EXISTS", message: "A folder with that name already exists here" },
            })
        }
        console.error("create folder failed", folderError)
        return internalError(res, "Failed to create folder")
    }

    return res.status(201).json({
        folder,
    })
}

export async function getFolderController(req: Request, res: Response) {
  const { id } = req.params

  // owned, or shared with us directly / through a parent folder
  const role = await getAccessRole(req.userId, 'folder', id as string)
  if (!role) return folderNotFound(res)

  const { data: folder, error: folderError } = await supabase
    .from("folders")
    .select(FOLDER_COLUMNS)
    .eq("id", id)
    .eq("is_deleted", false)
    .single()

  if (folderError || !folder) return folderNotFound(res)

  // independent reads, so they overlap rather than queue behind each other
  const [{ data: folders, error: foldersError }, { data: files, error: filesError }] =
    await Promise.all([
      supabase.from("folders").select(FOLDER_COLUMNS).eq("parent_id", id).eq("is_deleted", false),
      supabase.from("files").select(FILE_COLUMNS).eq("folder_id", id).eq("is_deleted", false),
    ])

  if (foldersError || filesError) {
    console.error("list folder children failed", foldersError, filesError)
    return internalError(res, "Failed to load folder")
  }

  const children = await attachStarred(req.userId, folders ?? [], files ?? [])

  // the caller's role here also covers the children: access to a shared folder
  // is inherited by everything inside it (see getAccessRole)
  return res.status(200).json({
    folder,
    children,
    role,
  })
}

export async function getRootController(req: Request, res: Response){
    const [{ data: folders, error: foldersError }, { data: files, error: filesError }] =
        await Promise.all([
            supabase
                .from("folders")
                .select(FOLDER_COLUMNS)
                .is("parent_id", null)
                .eq("owner_id", req.userId)
                .eq("is_deleted", false),
            supabase
                .from("files")
                .select(FILE_COLUMNS)
                .is("folder_id", null)
                .eq("owner_id", req.userId)
                .eq("is_deleted", false),
        ])

    if (filesError || foldersError) {
        console.error("list root failed", filesError, foldersError)
        return internalError(res, "Failed to load root")
    }

    const children = await attachStarred(req.userId, folders ?? [], files ?? [])

    // root only ever holds the caller's own items
    return res.status(200).json({
        folder: null,
        children,
        role: 'owner',
    })
}

export async function deleteFolderController(req:Request, res:Response){
    const {id} = req.params

    const { data: folder, error: folderError } = await supabase
        .from("folders")
        .select("id")
        .eq("id", id)
        .eq("owner_id", req.userId)
        .eq("is_deleted", false)
        .single()

    if (folderError || !folder) return folderNotFound(res)

    let allFolderIds: string[]
    try {
        allFolderIds = await collectSubtreeFolderIds(id as string, {
            ownerId: req.userId,
            isDeleted: false,
        })
    } catch (err) {
        console.error("cascade lookup failed", err)
        return internalError(res, "Failed to delete folder")
    }

    // one timestamp across the cascade, so the whole subtree expires together
    const deletedAt = new Date().toISOString()

    const { error: filesUpdateError } = await supabase
        .from("files")
        .update({ is_deleted: true, deleted_at: deletedAt })
        .in("folder_id", allFolderIds)
        .eq("owner_id", req.userId)

    if (filesUpdateError) {
        console.error("cascade file update failed", filesUpdateError)
        return internalError(res, "Failed to delete folder")
    }

    // No unique-violation branch here: the index is partial on
    // `where is_deleted = false`, so setting the flag only ever removes rows
    // from it. A name collision is impossible on this statement.
    const { error: folderUpdateError } = await supabase
        .from("folders")
        .update({ is_deleted: true, deleted_at: deletedAt })
        .in("id", allFolderIds)
        .eq("owner_id", req.userId)

    if (folderUpdateError) {
        console.error("cascade folder update failed", folderUpdateError)
        return internalError(res, "Failed to delete folder")
    }

    return res.status(204).send()
}

export async function restoreFolderController(req: Request, res: Response) {
    const { id } = req.params

    // look before writing — we may need to change the parent
    const { data: target, error: targetError } = await supabase
        .from("folders")
        .select("id, parent_id")
        .eq("id", id)
        .eq("owner_id", req.userId)
        .eq("is_deleted", true)
        .single()

    if (targetError || !target) return folderNotFound(res)

    const restoreUpdate: Record<string, unknown> = { is_deleted: false, deleted_at: null }
    // if the original parent is still in the trash, restore to root instead
    if (await parentFolderIsUnavailable(req.userId, target.parent_id)) {
        restoreUpdate.parent_id = null
    }

    const { data: folder, error: folderError } = await supabase
        .from("folders")
        .update(restoreUpdate)
        .eq("id", id)
        .eq("owner_id", req.userId)
        .eq("is_deleted", true)
        .select("id")
        .single()

    if (folderError) {
        if (folderError.code === "23505") {
            return res.status(409).json({
                error: {
                    code: "NAME_CONFLICT",
                    message: "A folder with that name already exists there. Rename it and try again.",
                },
            })
        }
        console.error("restore failed", folderError)
        return internalError(res, "Failed to restore folder")
    }

    if (!folder) return folderNotFound(res)

    // collect descendants that were cascade-deleted along with this folder
    let allFolderIds: string[]
    try {
        allFolderIds = await collectSubtreeFolderIds(id as string, {
            ownerId: req.userId,
            isDeleted: true,
        })
    } catch (err) {
        console.error("cascade lookup failed", err)
        return internalError(res, "Failed to restore folder")
    }

    const { error: filesUpdateError } = await supabase
        .from("files")
        .update({ is_deleted: false, deleted_at: null })
        .in("folder_id", allFolderIds)
        .eq("owner_id", req.userId)

    if (filesUpdateError) {
        console.error("cascade file restore failed", filesUpdateError)
        return internalError(res, "Failed to restore folder")
    }

    const { error: folderUpdateError } = await supabase
        .from("folders")
        .update({ is_deleted: false, deleted_at: null })
        .in("id", allFolderIds)
        .eq("owner_id", req.userId)

    if (folderUpdateError) {
        console.error("cascade folder restore failed", folderUpdateError)
        return internalError(res, "Failed to restore folder")
    }

    return res.status(204).send()
}

export async function getTrashController(req: Request, res: Response) {
    const [{ data: folders, error: foldersError }, { data: files, error: filesError }] =
        await Promise.all([
            supabase
                .from("folders")
                .select(FOLDER_COLUMNS)
                .eq("owner_id", req.userId)
                .eq("is_deleted", true),
            supabase
                .from("files")
                .select(FILE_COLUMNS)
                .eq("owner_id", req.userId)
                .eq("is_deleted", true),
        ])

    if (foldersError || filesError) {
        console.error("list trash failed", foldersError, filesError)
        return internalError(res, "Failed to load trash")
    }

    // anything whose parent is also deleted got here by cascade — hide it
    const deletedFolderIds = new Set((folders ?? []).map(f => f.id))

    return res.status(200).json({
        folders: (folders ?? []).filter(
            f => f.parent_id === null || !deletedFolderIds.has(f.parent_id)
        ),
        files: (files ?? []).filter(
            f => f.folder_id === null || !deletedFolderIds.has(f.folder_id)
        ),
    })
}

export async function getFolderPathController(req: Request, res: Response) {
    const { id } = req.params

    const role = await getAccessRole(req.userId, 'folder', id as string)
    if (!role) return folderNotFound(res)

    // climb to the root, but only through folders the caller may actually see:
    // for someone working inside a shared subtree the path stops at the folder
    // that was shared, not at the owner's real root
    const MAX_DEPTH = 50
    const path: Array<{ id: string; name: string }> = []
    let currentId: string | null = id as string
    let depth = 0

    while (currentId && depth < MAX_DEPTH) {
        // pinned to a local so the query's inferred type doesn't depend on
        // currentId, which this loop is about to reassign from that same query
        const lookupId: string = currentId

        const { data: folder } = await supabase
            .from("folders")
            .select("id, name, parent_id, owner_id")
            .eq("id", lookupId)
            .eq("is_deleted", false)
            .single()

        if (!folder) break

        // owning it settles the question without another round trip
        if (folder.owner_id !== req.userId) {
            const ancestorRole = await getAccessRole(req.userId, 'folder', folder.id)
            if (!ancestorRole) break
        }

        path.unshift({ id: folder.id, name: folder.name })
        currentId = folder.parent_id
        depth++
    }

    return res.status(200).json({ path, role })
}

export async function emptyTrashController(req: Request, res: Response) {
    const [{ data: deletedFolders, error: foldersError }, { data: trashedFiles, error: filesError }] =
        await Promise.all([
            supabase
                .from("folders")
                .select("id")
                .eq("owner_id", req.userId)
                .eq("is_deleted", true),
            supabase
                .from("files")
                .select("id, storage_key")
                .eq("owner_id", req.userId)
                .eq("is_deleted", true),
        ])

    if (foldersError || filesError) {
        console.error("empty trash lookup failed", foldersError, filesError)
        return internalError(res, "Failed to empty trash")
    }

    try {
        await hardDeleteResources({
            folderIds: (deletedFolders ?? []).map(f => f.id as string),
            files: (trashedFiles ?? []) as Array<{ id: string; storage_key: string }>,
            ownerId: req.userId,
        })
    } catch (err) {
        console.error("empty trash failed", err)
        return res.status(500).json({
            error: { code: "DELETE_FAILED", message: "Failed to empty trash" },
        })
    }

    return res.status(204).send()
}

export async function updateFolderController(req: Request, res: Response) {
    const { id } = req.params

    const { success, error, data } = updateFolderSchema.safeParse(req.body)
    if (!success) {
        return res.status(400).json({
            error: { code: "VALIDATION_ERROR", issues: error.issues },
        })
    }

    // editing (rename/move) requires owner or editor access to the folder itself
    const role = await getAccessRole(req.userId, 'folder', id as string)
    if (role !== 'owner' && role !== 'editor') return folderNotFound(res)

    // `undefined` means "not moving"; an explicit null means "move to my root",
    // which is still a move and still has to be authorised. Testing the value
    // for truthiness instead would wave that case straight through, letting an
    // editor pull a folder out of the share they reached it through.
    if (data.parentId !== undefined) {
        const destinationError = await validateFolderDestination(req.userId, id as string, data.parentId)
        if (destinationError) {
            return res.status(destinationError.status).json({ error: destinationError.body })
        }
    }

    const updates: Record<string, unknown> = {}
    if (data.name !== undefined) updates.name = data.name
    if (data.parentId !== undefined) updates.parent_id = data.parentId

    const { data: folder, error: updateError } = await supabase
        .from("folders")
        .update(updates)
        .eq("id", id)
        .eq("is_deleted", false)
        .select(FOLDER_COLUMNS)
        .single()

    if (updateError) {
        if (updateError.code === "23505") {
            return res.status(409).json({
                error: {
                    code: "FOLDER_EXISTS",
                    message: "A folder with that name already exists here",
                },
            })
        }
        console.error("update folder failed", updateError)
        return internalError(res, "Failed to update folder")
    }

    return res.status(200).json({ folder })
}

interface DestinationError {
    status: number
    body: { code: string; message: string }
}

/**
 * Checks that `folderId` may move to `parentId`.
 *
 * Moving to the root (`null`) is checked as strictly as any other move: the
 * root in question belongs to the folder's owner, so only the owner may put
 * something there. An editor doing it would quietly remove the folder from the
 * share that granted them access in the first place.
 */
async function validateFolderDestination(
    userId: string,
    folderId: string,
    parentId: string | null
): Promise<DestinationError | null> {
    if (parentId === null) {
        const role = await getAccessRole(userId, 'folder', folderId)
        if (role !== 'owner') {
            return {
                status: 404,
                body: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
            }
        }
        return null
    }

    if (parentId === folderId) {
        return {
            status: 400,
            body: { code: "INVALID_MOVE", message: "Cannot move a folder into itself" },
        }
    }

    const parentRole = await getAccessRole(userId, 'folder', parentId)
    if (parentRole !== 'owner' && parentRole !== 'editor') {
        return {
            status: 404,
            body: { code: "PARENT_NOT_FOUND", message: "Parent folder not found" },
        }
    }

    // a destination somewhere below this folder would make the tree a cycle
    let subtree: string[]
    try {
        subtree = await collectSubtreeFolderIds(folderId, { isDeleted: false })
    } catch (err) {
        console.error("descendant lookup failed", err)
        return {
            status: 500,
            body: { code: "INTERNAL_ERROR", message: "Failed to update folder" },
        }
    }

    if (subtree.includes(parentId)) {
        return {
            status: 400,
            body: {
                code: "INVALID_MOVE",
                message: "Cannot move a folder into its own subfolder",
            },
        }
    }

    return null
}

export async function permanentDeleteFolderController(req: Request, res: Response) {
  const { id } = req.params

  const { data: folder, error: selectError } = await supabase
    .from("folders")
    .select("id")
    .eq("id", id)
    .eq("owner_id", req.userId)
    .eq("is_deleted", true)
    .single()

  if (selectError || !folder) return folderNotFound(res)

  try {
    const allFolderIds = await collectSubtreeFolderIds(id as string, {
      ownerId: req.userId,
      isDeleted: true,
    })

    // the subtree's own files are found by hardDeleteResources through
    // folderIds, so nothing has to be listed separately here
    await hardDeleteResources({ folderIds: allFolderIds, files: [], ownerId: req.userId })
  } catch (err) {
    console.error("permanent folder delete failed", err)
    return res.status(500).json({
      error: { code: "DELETE_FAILED", message: "Failed to delete folder" },
    })
  }

  return res.status(204).send()
}
