import type { Request, Response } from "express";
import { createFolderSchema, updateFolderSchema } from "../schemas/folder.schema.js";
import { supabase } from "../lib/supabase.js";
import { env } from "../config/env.js"
import { attachStarred, deleteStarsFor } from '../lib/stars.js'
import { getAccessRole } from "../lib/access.js"

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
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to create folder" },
        })
    }

    return res.status(201).json({
        folder,
    })
}   

export async function getFolderController(req: Request, res: Response) {
  const { id } = req.params

  // owned, or shared with us directly / through a parent folder
  const role = await getAccessRole(req.userId, 'folder', id as string)
  if (!role) {
    return res.status(404).json({
      error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
    })
  }

  // 1. fetch the folder itself
  const { data: folder, error: folderError } = await supabase
    .from("folders")
    .select("id, name, parent_id, owner_id, created_at")
    .eq("id", id)
    .eq("is_deleted", false)
    .single()

  if (folderError || !folder) {
    return res.status(404).json({
      error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
    })
  }
    const { data: folders, error: foldersError } = await supabase
        .from("folders")
        .select("id, name, parent_id, owner_id, created_at")
        .eq("parent_id", id)
        .eq("is_deleted", false)

    if (foldersError) {
        console.error("list child folders failed", foldersError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to load folder" },
        })
    }

    const { data: files, error: filesError } = await supabase
        .from("files")
        .select("id, name, mime_type, size_bytes, folder_id, owner_id, created_at")
        .eq("folder_id", id)
        .eq("is_deleted", false)

    if (filesError) {
        console.error("list files failed", filesError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to load folder" },
        })
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
    const {data: folders, error: foldersError}= await supabase
        .from("folders")
        .select("id, name, parent_id, owner_id, created_at")
        .is("parent_id", null)
        .eq("owner_id", req.userId)
        .eq("is_deleted", false)

    const{data: files, error: filesError} = await supabase
        .from("files")
        .select("id, name, mime_type, size_bytes, folder_id, owner_id, created_at")
        .is("folder_id", null)
        .eq("owner_id", req.userId)
        .eq("is_deleted", false)

    if (filesError || foldersError) {
        console.error("list root failed", filesError, foldersError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to load root" },
        })
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

    if (folderError || !folder)
        return res.status(404).json({
            error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
        })
    const allFolderIds = [id]
    let currentLevel = [id]

    while (currentLevel.length > 0) {
        const { data: children, error: childError } = await supabase
            .from("folders")
            .select("id")
            .in("parent_id", currentLevel)
            .eq("owner_id", req.userId)
            .eq("is_deleted", false)

        if (childError) {
            console.error("cascade lookup failed", childError)
            return res.status(500).json({
                error: { code: "INTERNAL_ERROR", message: "Failed to delete folder" },
            })
        }

        currentLevel = children.map(c => c.id)
        allFolderIds.push(...currentLevel)
    }

    const deletedAt = new Date().toISOString()

    const { error: filesUpdateError } = await supabase
        .from("files")
        .update({ is_deleted: true, deleted_at: deletedAt })
        .in("folder_id", allFolderIds)
        .eq("owner_id", req.userId)

    if (filesUpdateError) {
        console.error("cascade folder update failed", filesUpdateError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to delete folder" },
        })
    }

    const { error: folderUpdateError } = await supabase
    .from("folders")
    .update({ is_deleted: true, deleted_at: deletedAt })
    .in("id", allFolderIds)
    .eq("owner_id", req.userId)

    if (folderUpdateError) {

        if (folderUpdateError.code === "23505") {
            return res.status(409).json({
                error: {
                    code: "NAME_CONFLICT",
                    message: "A folder with that name already exists here",
                },
        })
    }
        console.error("cascade folder update failed", folderUpdateError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to delete folder" },
        })
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

    if (targetError || !target)
        return res.status(404).json({
            error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
        })

    // if the original parent is still in the trash, restore to root instead
    let parentIsDeleted = false

    if (target.parent_id) {
        const { data: parent } = await supabase
            .from("folders")
            .select("id, is_deleted")
            .eq("id", target.parent_id)
            .eq("owner_id", req.userId)
            .single()

        parentIsDeleted = !parent || parent.is_deleted
    }

    const restoreUpdate: Record<string, unknown> = { is_deleted: false, deleted_at: null }
    if (parentIsDeleted) restoreUpdate.parent_id = null

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
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to restore folder" },
        })
    }

    if (!folder)
        return res.status(404).json({
            error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
        })

    // collect descendants that were cascade-deleted along with this folder
    const allFolderIds = [id]
    let currentLevel = [id]

    while (currentLevel.length > 0) {
        const { data: children, error: childError } = await supabase
            .from("folders")
            .select("id")
            .in("parent_id", currentLevel)
            .eq("owner_id", req.userId)
            .eq("is_deleted", true)

        if (childError) {
            console.error("cascade lookup failed", childError)
            return res.status(500).json({
                error: { code: "INTERNAL_ERROR", message: "Failed to restore folder" },
            })
        }

        currentLevel = children.map(c => c.id)
        allFolderIds.push(...currentLevel)
    }

    const { error: filesUpdateError } = await supabase
        .from("files")
        .update({ is_deleted: false, deleted_at: null })
        .in("folder_id", allFolderIds)
        .eq("owner_id", req.userId)

    if (filesUpdateError) {
        console.error("cascade file restore failed", filesUpdateError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to restore folder" },
        })
    }

    const { error: folderUpdateError } = await supabase
        .from("folders")
        .update({ is_deleted: false, deleted_at: null })
        .in("id", allFolderIds)
        .eq("owner_id", req.userId)

    if (folderUpdateError) {
        console.error("cascade folder restore failed", folderUpdateError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to restore folder" },
        })
    }

    return res.status(204).send()
}

export async function getTrashController(req: Request, res: Response) {
    const { data: folders, error: foldersError } = await supabase
        .from("folders")
        .select("id, name, parent_id, owner_id, created_at")
        .eq("owner_id", req.userId)
        .eq("is_deleted", true)

    if (foldersError) {
        console.error("list trash folders failed", foldersError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to load trash" },
        })
    }

    const { data: files, error: filesError } = await supabase
        .from("files")
        .select("id, name, mime_type, size_bytes, folder_id, owner_id, created_at")
        .eq("owner_id", req.userId)
        .eq("is_deleted", true)

    if (filesError) {
        console.error("list trash files failed", filesError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to load trash" },
        })
    }

    // anything whose parent is also deleted got here by cascade — hide it
    const deletedFolderIds = new Set(folders.map(f => f.id))

    const topLevelFolders = folders.filter(
        f => f.parent_id === null || !deletedFolderIds.has(f.parent_id)
    )

    const topLevelFiles = files.filter(
        f => f.folder_id === null || !deletedFolderIds.has(f.folder_id)
    )

    return res.status(200).json({
        folders: topLevelFolders,
        files: topLevelFiles,
    })
}

export async function getFolderPathController(req: Request, res: Response) {
    const { id } = req.params

    const role = await getAccessRole(req.userId, 'folder', id as string)
    if (!role) {
        return res.status(404).json({
            error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
        })
    }

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
    const { data: deletedFolders, error: foldersError } = await supabase
        .from("folders")
        .select("id")
        .eq("owner_id", req.userId)
        .eq("is_deleted", true)

    if (foldersError) {
        console.error("empty trash folder lookup failed", foldersError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to empty trash" },
        })
    }

    const deletedFolderIds = deletedFolders.map(f => f.id)

    const { data: trashedFiles, error: filesError } = await supabase
        .from("files")
        .select("id, storage_key")
        .eq("owner_id", req.userId)
        .eq("is_deleted", true)

    if (filesError) {
        console.error("empty trash file lookup failed", filesError)
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to empty trash" },
        })
    }

    // dropping a folder row cascades to its files, so any file living in a
    // trashed folder is about to disappear too — collect its blob as well, or
    // the row goes and the object stays behind forever
    const storageKeys = new Set(trashedFiles.map(f => f.storage_key))
    // stars do not cascade either, so their ids are collected in the same pass
    const purgedFileIds = new Set(trashedFiles.map(f => f.id))

    if (deletedFolderIds.length > 0) {
        const { data: nested, error: nestedError } = await supabase
            .from("files")
            .select("id, storage_key")
            .eq("owner_id", req.userId)
            .in("folder_id", deletedFolderIds)

        if (nestedError) {
            console.error("empty trash nested file lookup failed", nestedError)
            return res.status(500).json({
                error: { code: "INTERNAL_ERROR", message: "Failed to empty trash" },
            })
        }

        for (const f of nested) {
            storageKeys.add(f.storage_key)
            purgedFileIds.add(f.id)
        }
    }

    if (storageKeys.size > 0) {
        const { error: storageError } = await supabase.storage
            .from(env.SUPABASE_STORAGE_BUCKET)
            .remove([...storageKeys])

        if (storageError) {
            // log and continue — a stuck trash is worse than a logged orphan,
            // same call as permanentDeleteFolderController makes
            console.error("empty trash storage delete failed", storageError)
        }
    }

    const { error: fileDeleteError } = await supabase
        .from("files")
        .delete()
        .eq("owner_id", req.userId)
        .eq("is_deleted", true)

    if (fileDeleteError) {
        console.error("empty trash file delete failed", fileDeleteError)
        return res.status(500).json({
            error: { code: "DELETE_FAILED", message: "Failed to empty trash" },
        })
    }

    if (deletedFolderIds.length > 0) {
        const { error: folderDeleteError } = await supabase
            .from("folders")
            .delete()
            .in("id", deletedFolderIds)
            .eq("owner_id", req.userId)

        if (folderDeleteError) {
            console.error("empty trash folder delete failed", folderDeleteError)
            return res.status(500).json({
                error: { code: "DELETE_FAILED", message: "Failed to empty trash" },
            })
        }
    }

    await deleteStarsFor('file', [...purgedFileIds])
    await deleteStarsFor('folder', deletedFolderIds)

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
    if (role !== 'owner' && role !== 'editor') {
        return res.status(404).json({
            error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
        })
    }

    // only validate the destination when the folder is actually moving
    if (data.parentId) {
        if (data.parentId === id) {
            return res.status(400).json({
                error: { code: "INVALID_MOVE", message: "Cannot move a folder into itself" },
            })
        }

        const parentRole = await getAccessRole(req.userId, 'folder', data.parentId)
        if (parentRole !== 'owner' && parentRole !== 'editor') {
            return res.status(404).json({
                error: { code: "PARENT_NOT_FOUND", message: "Parent folder not found" },
            })
        }

        // walk down from this folder — if the destination is somewhere below it,
        // the move would create a cycle
        let currentLevel = [id]

        while (currentLevel.length > 0) {
            const { data: children, error: childError } = await supabase
                .from("folders")
                .select("id")
                .in("parent_id", currentLevel)
                .eq("is_deleted", false)

            if (childError) {
                console.error("descendant lookup failed", childError)
                return res.status(500).json({
                    error: { code: "INTERNAL_ERROR", message: "Failed to update folder" },
                })
            }

            currentLevel = children.map(c => c.id)

            if (currentLevel.includes(data.parentId)) {
                return res.status(400).json({
                    error: {
                        code: "INVALID_MOVE",
                        message: "Cannot move a folder into its own subfolder",
                    },
                })
            }
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
        .select("id, name, parent_id, owner_id, created_at")
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
        return res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Failed to update folder" },
        })
    }

    return res.status(200).json({ folder })
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

  if (selectError || !folder) {
    return res.status(404).json({
      error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
    })
  }

  // collect the whole subtree
  const allFolderIds: string[] = [id as string]
  let currentLevel: string[] = [id as string]

  while (currentLevel.length > 0) {
    const { data: children, error: childError } = await supabase
      .from("folders")
      .select("id")
      .in("parent_id", currentLevel)
      .eq("owner_id", req.userId)
      .eq("is_deleted", true)

    if (childError) {
      console.error("cascade lookup failed", childError)
      return res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Failed to delete folder" },
      })
    }

    currentLevel = children.map(c => c.id)
    allFolderIds.push(...currentLevel)
  }

  // find every file in that subtree so we can clear the bucket
  const { data: files, error: filesError } = await supabase
    .from("files")
    .select("id, storage_key")
    .in("folder_id", allFolderIds)
    .eq("owner_id", req.userId)

  if (filesError) {
    console.error("file lookup failed", filesError)
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to delete folder" },
    })
  }

  const storageKeys = files.map(f => f.storage_key)

  if (storageKeys.length > 0) {
    const { error: storageError } = await supabase.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .remove(storageKeys)

    if (storageError) {
      console.error("bulk storage delete failed", storageError, storageKeys)
      // log and continue — a stuck row is worse than a logged orphan
    }
  }

  const { error: dbError } = await supabase
    .from("folders")
    .delete()
    .in("id", allFolderIds)
    .eq("owner_id", req.userId)

  if (dbError) {
    console.error("db delete failed", dbError)
    return res.status(500).json({
      error: { code: "DELETE_FAILED", message: "Failed to delete folder" },
    })
  }

  // the whole subtree is gone for good — drop every user's stars across all of it
  await deleteStarsFor('file', files.map(f => f.id))
  await deleteStarsFor('folder', allFolderIds)

  return res.status(204).send()
}