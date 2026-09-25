import {
  User,
  Folder,
  FileItem,
  ShareItem,
  FolderContentResponse,
  TrashResponse,
  SearchResponse,
  SharedWithMeResponse,
  StarredResponse,
  ShareLink,
  PublicShareMeta,
  PublicSharePayload,
  ResourceType,
  ShareRole,
  UploadLimits,
  BreadcrumbItem,
} from '../types/storage';

/**
 * The one and only backend. There is no second deployment and no runtime
 * override, so this is a constant rather than build-time configuration.
 *
 * It is the same origin the app itself is served from, which is what keeps the
 * auth cookies first-party: hosted separately they would be third-party
 * cookies, which Safari, Brave and any blocker extension drop outright — login
 * returns 200 and the very next request is a 401. Written out in full so that
 * running the dev server locally still talks to the real API.
 */
export const API_BASE_URL = 'https://cloud-storage-api-hquw.onrender.com';

/** Matches the API defaults; only used when the server reports no limits. */
export const FALLBACK_UPLOAD_LIMITS: UploadLimits = {
  maxFileSizeBytes: 50 * 1024 * 1024,
  maxDirectUploadBytes: 5 * 1024 * 1024 * 1024,
};

/** Status and upload limits, used to pick the upload path. */
function fetchHealth(): Promise<Response> {
  return fetch(`${API_BASE_URL}/api/health`, { method: 'GET' });
}

/** Turns an API error envelope into the most specific message available. */
function extractErrorMessage(data: any, status: number): string {
  // Surface issues array, specific validation errors, and error codes
  let errorMsg = data?.error?.message;
  if (!errorMsg && Array.isArray(data?.error?.issues) && data.error.issues.length > 0) {
    errorMsg = data.error.issues
      .map((iss: any) => {
        const pathStr = Array.isArray(iss.path) && iss.path.length > 0 ? `${iss.path.join('.')}: ` : '';
        return `${pathStr}${iss.message || JSON.stringify(iss)}`;
      })
      .join('; ');
  }
  if (!errorMsg && data?.error?.code) {
    errorMsg = `[${data.error.code}] Validation error`;
  }
  if (!errorMsg && data?.message) {
    errorMsg = data.message;
  }
  return errorMsg || `Request failed with status ${status}`;
}

/** An API error that kept its machine-readable code, so callers can branch. */
export class ApiError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Builds the ApiError for a failed response, whatever shape the body took. */
function apiErrorFrom(data: any, status: number): ApiError {
  return new ApiError(extractErrorMessage(data, status), data?.error?.code, status);
}

/**
 * Calls a public share endpoint.
 *
 * Deliberately NOT routed through ApiClient.request: that wrapper treats every
 * 401 as an expired session and silently retries after refreshing. Here a 401
 * means "wrong password", and retrying it would be both useless and confusing.
 * It also sends no credentials — the token in the path is the only credential,
 * and a stray session cookie must never be what makes a public link work.
 */
async function publicRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}/api/public${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiErrorFrom(data, res.status);
  return data as T;
}

/** What this link points at, and whether it wants a password. */
export function getPublicShare(token: string): Promise<PublicShareMeta> {
  return publicRequest<PublicShareMeta>(`/${encodeURIComponent(token)}`);
}

export function accessPublicShare(token: string, password?: string): Promise<PublicSharePayload> {
  return publicRequest<PublicSharePayload>(`/${encodeURIComponent(token)}/access`, { password });
}

export function browsePublicShare(
  token: string,
  folderId: string,
  password?: string
): Promise<PublicSharePayload> {
  return publicRequest<PublicSharePayload>(
    `/${encodeURIComponent(token)}/folder/${encodeURIComponent(folderId)}`,
    { password }
  );
}

export function getPublicFile(
  token: string,
  fileId: string,
  password?: string
): Promise<{ file: FileItem; signedUrl: string }> {
  return publicRequest(`/${encodeURIComponent(token)}/file/${encodeURIComponent(fileId)}`, {
    password,
  });
}

/** The embedded user the shares endpoints join in. */
interface ShareUserRow {
  id: string;
  email: string;
  name: string | null;
}

/** POST /api/shares — the row is returned with its own columns, flat. */
interface CreatedShareRow {
  id: string;
  resource_type: ResourceType;
  resource_id: string;
  grantee_user_id: string;
  role: ShareRole;
  created_at: string;
}

/** GET /api/shares/:type/:id — the grantee arrives as an embedded resource. */
interface ListedShareRow {
  id: string;
  role: ShareRole;
  created_at: string;
  users: ShareUserRow | null;
}

/**
 * The API's identity comes from the httpOnly session cookie, which the browser
 * attaches on its own. No method here takes a user id: passing one would imply
 * the client scopes the request, and it does not.
 */
export class ApiClient {
  private refreshPromise: Promise<boolean> | null = null;
  private serverInfo: { limits: UploadLimits; trashRetentionDays: number | null } | null = null;

  private async refreshSession(): Promise<boolean> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        return res.ok;
      } catch {
        return false;
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}, isRetry = false): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`;
    const res = await fetch(url, {
      ...options,
      credentials: 'include', // Backend uses httpOnly cookies for access/refresh tokens
      headers: {
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
    });

    // Automatically handle token refresh on 401 for non-auth endpoints
    if (
      res.status === 401 &&
      !isRetry &&
      !endpoint.startsWith('/api/auth/login') &&
      !endpoint.startsWith('/api/auth/refresh')
    ) {
      const refreshed = await this.refreshSession();
      if (refreshed) {
        return this.request<T>(endpoint, options, true);
      }
    }

    if (res.status === 204) {
      return null as T;
    }

    const data = await res.json().catch(() => ({}));
    // an ApiError, not a bare Error: the server's `code` is the only thing that
    // lets a caller tell "that name is taken" from "the request was rejected",
    // and dropping it forces guesswork at every call site
    if (!res.ok) throw apiErrorFrom(data, res.status);
    return data as T;
  }

  /**
   * fetch() cannot report upload progress, so anything that sends a file body
   * goes through XMLHttpRequest instead. Returns the raw response for the
   * caller to interpret — including 401, which only our own API can retry.
   */
  private xhrSend(opts: {
    method: string;
    url: string;
    body: XMLHttpRequestBodyInit;
    headers?: Record<string, string>;
    withCredentials: boolean;
    onProgress?: (loaded: number, total: number) => void;
  }): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(opts.method, opts.url, true);
      xhr.withCredentials = opts.withCredentials;

      for (const [key, value] of Object.entries(opts.headers ?? {})) {
        xhr.setRequestHeader(key, value);
      }

      if (opts.onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          // lengthComputable is false for chunked bodies; skip rather than lie
          if (e.lengthComputable) opts.onProgress!(e.loaded, e.total);
        });
      }

      xhr.addEventListener('load', () => resolve({ status: xhr.status, text: xhr.responseText }));
      xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
      xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
      xhr.addEventListener('timeout', () => reject(new Error('Upload timed out')));

      xhr.send(opts.body);
    });
  }

  /** Upload limits the server enforces, cached for the life of the connection. */
  async getLimits(): Promise<UploadLimits> {
    return (await this.fetchServerInfo()).limits;
  }

  /** How long trash survives before the server purges it, or null if unreported. */
  async getTrashRetentionDays(): Promise<number | null> {
    return (await this.fetchServerInfo()).trashRetentionDays;
  }

  /** One cached read of /api/health, shared by every caller that needs it. */
  private async fetchServerInfo(): Promise<{
    limits: UploadLimits;
    trashRetentionDays: number | null;
  }> {
    if (this.serverInfo) return this.serverInfo;

    // an older API that reports neither: assume the documented defaults
    let limits = FALLBACK_UPLOAD_LIMITS;
    let trashRetentionDays: number | null = null;

    try {
      const res = await fetchHealth();
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const reported = data?.limits;
        if (
          Number.isFinite(reported?.maxFileSizeBytes) &&
          Number.isFinite(reported?.maxDirectUploadBytes)
        ) {
          limits = {
            maxFileSizeBytes: reported.maxFileSizeBytes,
            maxDirectUploadBytes: reported.maxDirectUploadBytes,
          };
        }
        if (Number.isFinite(data?.trashRetentionDays)) {
          trashRetentionDays = data.trashRetentionDays;
        }
      }
    } catch {
      // unreachable server — the operation itself will surface the real problem
    }

    this.serverInfo = { limits, trashRetentionDays };
    return this.serverInfo;
  }

  // Authentication
  async me(): Promise<User | null> {
    try {
      const res = await this.request<{ user: User }>('/api/auth/me');
      return res.user;
    } catch {
      return null;
    }
  }

  async login(email: string, password: string): Promise<User> {
    const res = await this.request<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return res.user;
  }

  async register(name: string, email: string, password: string): Promise<User> {
    const res = await this.request<{ user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    });
    return res.user;
  }

  async loginWithGoogle(credential: string): Promise<User> {
    const res = await this.request<{ user: User }>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    });
    return res.user;
  }

  async logout(): Promise<void> {
    try {
      await this.request('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      console.warn('Backend logout failed', e);
    }
  }

  // Folder Operations
  async getRoot(): Promise<FolderContentResponse> {
    return this.request<FolderContentResponse>('/api/folders/root');
  }

  async getFolder(folderId: string): Promise<FolderContentResponse> {
    return this.request<FolderContentResponse>(`/api/folders/${folderId}`);
  }

  async createFolder(name: string, parentId?: string | null): Promise<Folder> {
    const res = await this.request<{ folder: Folder }>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId: parentId ?? null }),
    });
    return res.folder;
  }

  async updateFolder(
    folderId: string,
    updates: { name?: string; parentId?: string | null }
  ): Promise<Folder> {
    const res = await this.request<{ folder: Folder }>(`/api/folders/${folderId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    return res.folder;
  }

  /** Ancestor chain ending at this folder, so breadcrumbs survive a refresh. */
  async getFolderPath(folderId: string): Promise<BreadcrumbItem[]> {
    const res = await this.request<{ path: Array<{ id: string; name: string }> }>(
      `/api/folders/${folderId}/path`
    );
    return res.path || [];
  }

  async deleteFolder(folderId: string): Promise<void> {
    return this.request<void>(`/api/folders/${folderId}`, { method: 'DELETE' });
  }

  async restoreFolder(folderId: string): Promise<void> {
    return this.request<void>(`/api/folders/${folderId}/restore`, { method: 'PATCH' });
  }

  async permanentDeleteFolder(folderId: string): Promise<void> {
    return this.request<void>(`/api/folders/${folderId}/permanent`, { method: 'DELETE' });
  }

  // File Operations

  /**
   * Small-file path: multipart straight at the API, which buffers the body and
   * forwards it to storage. Capped server-side at MAX_FILE_SIZE_BYTES.
   */
  async uploadFile(
    file: File,
    folderId?: string | null,
    onProgress?: (loaded: number, total: number) => void,
    isRetry = false
  ): Promise<FileItem> {
    const formData = new FormData();
    formData.append('file', file);
    if (folderId) {
      formData.append('folderId', folderId);
    }

    const res = await this.xhrSend({
      method: 'POST',
      url: `${API_BASE_URL}/api/files/upload`,
      body: formData,
      withCredentials: true,
      onProgress,
    });

    // xhrSend does not run the fetch path's refresh-on-401, so do it here
    if (res.status === 401 && !isRetry && (await this.refreshSession())) {
      return this.uploadFile(file, folderId, onProgress, true);
    }

    // a proxy or gateway can answer with HTML, so never assume JSON parses
    let data: any = {};
    try {
      data = res.text ? JSON.parse(res.text) : {};
    } catch {
      data = {};
    }

    if (res.status < 200 || res.status >= 300) {
      throw apiErrorFrom(data, res.status);
    }
    return data.file as FileItem;
  }

  /**
   * Large-file path: the bytes never touch the API. Ask it for a signed URL,
   * PUT the file straight to storage, then tell the API to record the row.
   */
  async uploadFileDirect(
    file: File,
    folderId?: string | null,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<FileItem> {
    const ticket = await this.request<{
      storageKey: string;
      path: string;
      token: string;
      signedUrl: string;
    }>('/api/files/upload-url', {
      method: 'POST',
      body: JSON.stringify({ folderId: folderId ?? null, sizeBytes: file.size }),
    });

    // Supabase's signed upload expects a PUT of a multipart body with the file
    // under the empty field name; the signed URL already carries its token.
    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', file);

    const put = await this.xhrSend({
      method: 'PUT',
      url: ticket.signedUrl,
      body: form,
      headers: { 'x-upsert': 'false' },
      // a different origin entirely — never send our session cookies there
      withCredentials: false,
      onProgress,
    });

    if (put.status < 200 || put.status >= 300) {
      throw new Error(`Storage rejected the upload (HTTP ${put.status})`);
    }

    const res = await this.request<{ file: FileItem }>('/api/files/complete', {
      method: 'POST',
      body: JSON.stringify({
        storageKey: ticket.storageKey,
        name: file.name,
        folderId: folderId ?? null,
      }),
    });
    return res.file;
  }

  /** Files in one folder, without the folder tree that getFolder also returns. */
  async listFiles(folderId?: string | null): Promise<FileItem[]> {
    const qs = folderId ? `?folderId=${encodeURIComponent(folderId)}` : '';
    const res = await this.request<{ files: FileItem[] }>(`/api/files${qs}`);
    return res.files || [];
  }

  async getFile(fileId: string): Promise<{ file: FileItem; signedUrl: string }> {
    return this.request<{ file: FileItem; signedUrl: string }>(`/api/files/${fileId}`);
  }

  async updateFile(
    fileId: string,
    updates: { name?: string; folderId?: string | null }
  ): Promise<FileItem> {
    const res = await this.request<{ file: FileItem }>(`/api/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    return res.file;
  }

  async deleteFile(fileId: string): Promise<void> {
    return this.request<void>(`/api/files/${fileId}`, { method: 'DELETE' });
  }

  async restoreFile(fileId: string): Promise<FileItem> {
    const res = await this.request<{ file: FileItem }>(`/api/files/${fileId}/restore`, {
      method: 'PATCH',
    });
    return res.file;
  }

  async permanentDeleteFile(fileId: string): Promise<void> {
    return this.request<void>(`/api/files/${fileId}/permanent`, { method: 'DELETE' });
  }

  // Trash
  async getTrash(): Promise<TrashResponse> {
    return this.request<TrashResponse>('/api/folders/trash');
  }

  async emptyTrash(): Promise<void> {
    // one server-side sweep — the old client loop fired a request per item and
    // could leave the trash half emptied if any one of them failed
    return this.request<void>('/api/folders/trash', { method: 'DELETE' });
  }

  // Search
  async search(query: string): Promise<SearchResponse> {
    return this.request<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}`);
  }

  // Public share links — owner side. The visitor side is unauthenticated and
  // lives in the standalone helpers above.
  async createShareLink(
    resourceType: ResourceType,
    resourceId: string,
    options: { expiresInDays?: number | null; password?: string | null } = {}
  ): Promise<ShareLink> {
    const res = await this.request<{ link: ShareLink }>('/api/share-links', {
      method: 'POST',
      body: JSON.stringify({
        resourceType,
        resourceId,
        expiresInDays: options.expiresInDays ?? null,
        password: options.password || null,
      }),
    });
    return res.link;
  }

  async listShareLinks(resourceType: ResourceType, resourceId: string): Promise<ShareLink[]> {
    const res = await this.request<{ links: ShareLink[] }>(
      `/api/share-links/${resourceType}/${resourceId}`
    );
    return res.links || [];
  }

  async deleteShareLink(id: string): Promise<void> {
    await this.request(`/api/share-links/${id}`, { method: 'DELETE' });
  }

  // Stars — per-user bookmarks, not a property of the resource
  async getStarred(): Promise<StarredResponse> {
    const res = await this.request<StarredResponse>('/api/stars');
    return { folders: res.folders || [], files: res.files || [] };
  }

  /** Idempotent on both sides: starring twice, or unstarring nothing, is a no-op. */
  async setStarred(resourceType: ResourceType, resourceId: string, starred: boolean): Promise<void> {
    if (starred) {
      await this.request('/api/stars', {
        method: 'POST',
        body: JSON.stringify({ resourceType, resourceId }),
      });
      return;
    }
    await this.request(`/api/stars/${resourceType}/${resourceId}`, { method: 'DELETE' });
  }

  // Shares
  async createShare(
    resourceType: ResourceType,
    resourceId: string,
    granteeUserId: string,
    role: ShareRole
  ): Promise<ShareItem> {
    // the create endpoint returns the row's own columns, flat
    const res = await this.request<{ share: CreatedShareRow }>('/api/shares', {
      method: 'POST',
      body: JSON.stringify({ resourceType, resourceId, granteeUserId, role }),
    });
    return { ...res.share };
  }

  async listShares(resourceType: ResourceType, resourceId: string): Promise<ShareItem[]> {
    // this endpoint joins the grantee in as an embedded `users` resource and
    // does not repeat resource_type/resource_id on each row, so they come from
    // the arguments that selected them
    const res = await this.request<{ shares: ListedShareRow[] }>(
      `/api/shares/${resourceType}/${resourceId}`
    );
    return (res.shares || []).map((share) => ({
      id: share.id,
      resource_type: resourceType,
      resource_id: resourceId,
      role: share.role,
      created_at: share.created_at,
      grantee_user_id: share.users?.id ?? '',
      grantee_name: share.users?.name ?? '',
      grantee_email: share.users?.email ?? '',
    }));
  }

  /** Resources other people have shared directly with the signed-in user. */
  async getSharedWithMe(): Promise<SharedWithMeResponse> {
    const res = await this.request<SharedWithMeResponse>('/api/shares/shared-with-me');
    return { folders: res.folders || [], files: res.files || [] };
  }

  /** Exact-address lookup, so sharing can take an email instead of a UUID. */
  async lookupUserByEmail(email: string): Promise<User> {
    const res = await this.request<{ user: User }>(
      `/api/users/lookup?email=${encodeURIComponent(email)}`
    );
    return res.user;
  }

  async deleteShare(shareId: string): Promise<void> {
    return this.request<void>(`/api/shares/${shareId}`, { method: 'DELETE' });
  }
}

export const api = new ApiClient();
