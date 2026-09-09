import crypto from 'crypto'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase.js'
import { env } from '../config/env.js'
import { attachStarred, deleteStarsFor } from '../lib/stars.js'
import { getAccessRole } from '../lib/access.js'
import {
  uploadFileSchema,
  updateFileSchema,
  createUploadUrlSchema,
  completeUploadSchema,
} from '../schemas/file.schema.js'

export async function uploadFileController(req: Request, res: Response) {
  // 1. multer puts the file here — no file means nothing to do
  if (!req.file) {
    return res.status(400).json({
      error: { code: "NO_FILE", message: "No file uploaded" },
    })
  }

  // 2. multipart text fields arrive as STRINGS, so "" is what an empty
  //    form field gives you — normalize it away before zod sees it
  const rawFolderId = req.body?.folderId
  const { success, error, data } = uploadFileSchema.safeParse({
    folderId: rawFolderId === "" || rawFolderId === "null" ? null : rawFolderId,
  })

  if (!success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", issues: error.issues },
    })
  }

  const folderId = data.folderId ?? null

  // 3. service role key bypasses RLS — this check is the ONLY thing
  //    stopping someone uploading into another user's folder. Editors on a
  //    shared folder may upload into it, same rule as renaming or moving.
  if (folderId) {
    const folderRole = await getAccessRole(req.userId, 'folder', folderId)
    if (folderRole !== 'owner' && folderRole !== 'editor') {
      return res.status(404).json({
        error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
      })
    }
  }

  // 4. generated key, never the user's filename
  const storageKey = `${req.userId}/${crypto.randomUUID()}`

  const { error: uploadError } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(storageKey, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    })

  if (uploadError) {
    console.error("storage upload failed", uploadError)
    return res.status(500).json({
      error: { code: "UPLOAD_FAILED", message: "Failed to store file" },
    })
  }

  // 5. blob is up. if the row fails now, the blob is orphaned —
  //    so delete it before bailing out
  const { data: file, error: insertError } = await supabase
    .from("files")
    .insert({
      name: req.file.originalname,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      storage_key: storageKey,
      owner_id: req.userId,
      folder_id: folderId,
    })
    .select("id, name, mime_type, size_bytes, folder_id, owner_id, created_at")
    .single()

  if (insertError) {
    await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).remove([storageKey])
    console.error("file insert failed", insertError)
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to save file" },
    })
  }

  return res.status(201).json({ file })
}

export async function createUploadUrlController(req: Request, res: Response) {
  const { success, error, data } = createUploadUrlSchema.safeParse(req.body)

  if (!success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", issues: error.issues },
    })
  }

  if (data.sizeBytes && data.sizeBytes > env.MAX_DIRECT_UPLOAD_BYTES) {
    return res.status(413).json({
      error: {
        code: "FILE_TOO_LARGE",
        message: `File exceeds the ${env.MAX_DIRECT_UPLOAD_BYTES} byte limit`,
      },
    })
  }

  const folderId = data.folderId ?? null

  // same rule as the multipart path — owner or editor on the destination
  if (folderId) {
    const folderRole = await getAccessRole(req.userId, 'folder', folderId)
    if (folderRole !== 'owner' && folderRole !== 'editor') {
      return res.status(404).json({
        error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
      })
    }
  }

  // same shape as the multipart path: the prefix is what /complete checks
  const storageKey = `${req.userId}/${crypto.randomUUID()}`

  const { data: signed, error: signError } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .createSignedUploadUrl(storageKey)

  if (signError || !signed) {
    console.error("create signed upload url failed", signError)
    return res.status(500).json({
      error: { code: "UPLOAD_URL_FAILED", message: "Could not start upload" },
    })
  }

  // remember we handed this key out, so /complete can tell a real upload from
  // a guessed key, and so an abandoned blob can be swept later
  const { error: pendingError } = await supabase.from("pending_uploads").insert({
    storage_key: storageKey,
    owner_id: req.userId,
    folder_id: folderId,
  })

  if (pendingError) {
    console.error("pending upload insert failed", pendingError)
    return res.status(500).json({
      error: { code: "UPLOAD_URL_FAILED", message: "Could not start upload" },
    })
  }

  return res.status(201).json({
    storageKey,
    path: signed.path,
    token: signed.token,
    signedUrl: signed.signedUrl,
  })
}

export async function completeUploadController(req: Request, res: Response) {
  const { success, error, data } = completeUploadSchema.safeParse(req.body)

  if (!success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", issues: error.issues },
    })
  }

  // belt and braces: a key outside the caller's prefix is never theirs to claim
  if (!data.storageKey.startsWith(`${req.userId}/`)) {
    return res.status(403).json({
      error: { code: "FORBIDDEN", message: "Not your upload" },
    })
  }

  // and it has to be a key we actually issued, still unclaimed
  const { data: pending } = await supabase
    .from("pending_uploads")
    .select("storage_key, folder_id")
    .eq("storage_key", data.storageKey)
    .eq("owner_id", req.userId)
    .maybeSingle()

  if (!pending) {
    return res.status(404).json({
      error: { code: "UPLOAD_NOT_FOUND", message: "No pending upload for that key" },
    })
  }

  // the body may re-state the folder, but the one from /upload-url wins unless
  // the client explicitly sends a different one — which is re-checked either way
  const folderId = data.folderId !== undefined ? data.folderId : pending.folder_id

  if (folderId) {
    const folderRole = await getAccessRole(req.userId, 'folder', folderId)
    if (folderRole !== 'owner' && folderRole !== 'editor') {
      return res.status(404).json({
        error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
      })
    }
  }

  // read size and mime back from storage: it proves the blob really landed, and
  // means a client can't understate how much space it just used
  const { data: info, error: infoError } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .info(data.storageKey)

  if (infoError || !info) {
    return res.status(404).json({
      error: { code: "UPLOAD_NOT_FOUND", message: "Nothing was uploaded to that key" },
    })
  }

  const { data: file, error: insertError } = await supabase
    .from("files")
    .insert({
      name: data.name,
      mime_type: info.contentType ?? "application/octet-stream",
      size_bytes: info.size ?? 0,
      storage_key: data.storageKey,
      owner_id: req.userId,
      folder_id: folderId,
    })
    .select("id, name, mime_type, size_bytes, folder_id, owner_id, created_at")
    .single()

  if (insertError) {
    // same rule as the multipart path: no row means no orphaned blob
    await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).remove([data.storageKey])
    await supabase.from("pending_uploads").delete().eq("storage_key", data.storageKey)
    console.error("complete upload insert failed", insertError)
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to save file" },
    })
  }

  // claimed — it is a real file now, not a dangling blob
  await supabase.from("pending_uploads").delete().eq("storage_key", data.storageKey)

  return res.status(201).json({ file })
}

export async function getFileController(req:Request, res: Response){
    const { id }= req.params

    // owned, or shared with us directly / through a parent folder
    const role = await getAccessRole(req.userId, 'file', id as string)
    if (!role)
        return res.status(404).json({
            error: {code : "FILE_NOT_FOUND", message: "File not found"}
        })

    const {data: file, error: fileError } = await supabase
        .from("files")
        .select("id, name, mime_type, size_bytes, storage_key, folder_id, owner_id, created_at")
        .eq("id", id)
        .eq("is_deleted", false)
        .single()

    if(fileError|| !file)
        return res.status(404).json({
            error: {code : "FILE_NOT_FOUND", message: "File not found"}
        })

     const { data: signed, error: signedError } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(file.storage_key, 60 * 60)

    if (signedError || !signed) {
        console.error("sign url failed", signedError, file.storage_key)
        return res.status(404).json({
        error: { code: "FILE_NOT_FOUND", message: "File not found" },
        })
    }   

    const { storage_key, ...safeFile } = file

    return res.status(200).json({
        file: safeFile,
        signedUrl: signed.signedUrl,
        role,
    })
}

export async function deleteFileController(req: Request, res: Response) {
    const { id } = req.params

    const { data: file, error: fileError } = await supabase
        .from("files")
        .update({ is_deleted: true, deleted_at: new Date().toISOString() })
        .eq("id", id)
        .eq("owner_id", req.userId)
        .eq("is_deleted", false)
        .select("id")
        .single()

    if (fileError || !file)
        return res.status(404).json({
            error: { code: "FILE_NOT_FOUND", message: "File not found" },
        })

    return res.status(204).send()
}

export async function listFileController (req: Request, res: Response){
  // a repeated ?folderId= arrives as an array — only a single value is meaningful
  const folderId = typeof req.query.folderId === "string" ? req.query.folderId : null

  let query = supabase
    .from("files")
    .select("id, name, mime_type, size_bytes, folder_id, owner_id, created_at")
    .eq("is_deleted", false)
    .order("created_at", { ascending: false })

  if (folderId) {
    // listing inside a folder follows the same access rules as opening it,
    // so a shared folder lists its files too
    const role = await getAccessRole(req.userId, 'folder', folderId)
    if (!role)
      return res.status(404).json({
        error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
      })

    query = query.eq("folder_id", folderId)
  } else {
    // no folder means the caller's own root — never anyone else's
    query = query.is("folder_id", null).eq("owner_id", req.userId)
  }

  const {data:files, error} = await query

  if(error)
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to list files" },
    })
  
  const { files: withStars } = await attachStarred(req.userId, [], files ?? [])

  return res.status(200).json({ files: withStars })
}

export async function updateFileController(req: Request, res: Response) {
    const { id } = req.params

    // parse and validate the body first
    const { success, error, data:rawdata } = updateFileSchema.safeParse(req.body)
    if (!success) {
        return res.status(400).json({
            error: { code: "VALIDATION_ERROR", issues: error.issues },
        })
    }

    // editing (rename/move) requires owner or editor access to the file itself
    const role = await getAccessRole(req.userId, 'file', id as string)
    if (role !== 'owner' && role !== 'editor') {
        return res.status(404).json({
            error: { code: "FILE_NOT_FOUND", message: "File not found" },
        })
    }

    if (rawdata.folderId) {
      const folderRole = await getAccessRole(req.userId, 'folder', rawdata.folderId)
      if (folderRole !== 'owner' && folderRole !== 'editor') {
          return res.status(404).json({
              error: { code: "FOLDER_NOT_FOUND", message: "Folder not found" },
          })
      }
    }

    const updates: Record<string, unknown> = {}
    if (rawdata.name !== undefined) updates.name = rawdata.name
    if (rawdata.folderId !== undefined) updates.folder_id = rawdata.folderId

    const { data: file, error: fileError } = await supabase
        .from("files")
        .update(updates)
        .eq("id", id)
        .eq("is_deleted", false)
        .select("id, name, mime_type, size_bytes, folder_id, owner_id, created_at")
        .single()

    if (fileError || !file)
        return res.status(404).json({
            error: { code: "FILE_NOT_FOUND", message: "File not found" },
        })

    return res.status(200).json({ file })
}

export async function permanentDeleteFileController(req: Request, res: Response) {
  const { id } = req.params

  // Delete from Supabase Storage first (physical delete)
  const { data: file, error: selectError } = await supabase
    .from("files")
    .select("storage_key")
    .eq("id", id)
    .eq("owner_id", req.userId)
    .eq("is_deleted", true)
    .single()

  if (selectError || !file) {
    return res.status(404).json({
      error: { code: "FILE_NOT_FOUND", message: "File not found" },
    })
  }

  const { error: storageError } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .remove([file.storage_key])

  if (storageError) {
    console.error("storage delete failed",  storageError, file.storage_key)



    
  //if storage delete fails then we dont delete file from db 

    // return res.status(500).json({
    //   error: { code: "DELETE_FAILED", message: "Failed to delete file" },
    // })
  }

  // Then delete from database
  const { error: dbError } = await supabase
    .from("files")
    .delete()
    .eq("id", id)
    .eq("owner_id", req.userId)

  if (dbError) {
    console.error("db delete failed", dbError)
    return res.status(500).json({
      error: { code: "DELETE_FAILED", message: "Failed to delete file" },
    })
  }

  // the row is gone for good, so every user's star on it now points at nothing
  await deleteStarsFor('file', [id as string])

  return res.status(204).send()
}

export async function restoreFileController(req: Request, res: Response){
    const { id } = req.params

        const { data: target, error: targetError } = await supabase
        .from("files")
        .select("id, folder_id")
        .eq("id", id)
        .eq("owner_id", req.userId)
        .eq("is_deleted", true)
        .single()

    if (targetError || !target)
        return res.status(404).json({
            error: { code: "FILE_NOT_FOUND", message: "File not found" },
        })

    let parentIsDeleted = false

    if (target.folder_id) {
        const { data: parent } = await supabase
            .from("folders")
            .select("id, is_deleted")
            .eq("id", target.folder_id)
            .eq("owner_id", req.userId)
            .single()

        parentIsDeleted = !parent || parent.is_deleted
    }

    const restoreUpdate: Record<string, unknown> = { is_deleted: false, deleted_at: null }
    if (parentIsDeleted) restoreUpdate.folder_id = null

    const { data: file, error: fileError } = await supabase
        .from("files")
        .update(restoreUpdate)
        .eq("id", id)
        .eq("owner_id", req.userId)
        .eq("is_deleted", true)
        .select("id, name, mime_type, size_bytes, folder_id, owner_id, created_at")
        .single()

    if (fileError || !file)
        return res.status(404).json({
            error: { code: "FILE_NOT_FOUND", message: "File not found" },
        })

    return res.status(200).json({ file })
}

