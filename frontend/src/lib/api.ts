/**
 * Frontend Typed API Client for LabNotes.
 * Aligned with backend contracts in backend/src/models.rs and backend/src/error.rs.
 */

// ============================================================================
// DTO Interfaces
// ============================================================================

export interface PublicSubjectItem {
  id: string;
  name: string;
  position: number;
  page_count: number;
}

export interface PublicPageItem {
  id: string;
  subject_id: string;
  subject_name: string;
  title: string;
  snippet: string;
  published_at: string;
}

export interface PublicPageListResponse {
  items: PublicPageItem[];
  total: number;
  limit?: number;
  offset?: number;
}

export interface PublicAttachmentItem {
  id: string;
  original_name: string;
  byte_size: number;
  mime: string;
  url: string; // Synthesized `/media/${id}`
}

export interface PublicPageViewResponse {
  id: string;
  subject_id: string;
  subject_name: string;
  title: string;
  markdown: string;
  published_at: string;
  attachments: PublicAttachmentItem[];
}

export interface SubjectResponse {
  id: string;
  name: string;
  position: number;
  page_count: number;
  created_at: string;
  updated_at: string;
}

export interface CreateSubjectRequest {
  name: string;
  position?: number;
}

export interface UpdateSubjectRequest {
  name?: string;
  position?: number;
}

export interface AdminPageListItem {
  id: string;
  draft_subject_id: string;
  draft_title: string;
  revision: number;
  is_published: boolean;
  published_revision: number | null;
  created_at: string;
  updated_at: string;
}

export interface AdminPageDetail {
  id: string;
  draft_subject_id: string;
  draft_title: string;
  draft_markdown: string;
  revision: number;
  is_published: boolean;
  published_revision: number | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePageRequest {
  subject_id: string;
  title: string;
}

export interface UpdatePageRequest {
  expected_revision: number;
  title?: string;
  subject_id?: string;
  markdown?: string;
}

export interface UpdatePageResponse {
  id: string;
  revision: number;
}

export interface PublishPageRequest {
  expected_revision: number;
  attachment_ids?: string[];
}

export interface PublishPageResponse {
  page_id: string;
  published_revision: number;
  published_at: string;
}

export interface AssetResponse {
  id: string;
  page_id: string;
  original_name: string;
  mime: string;
  byte_size: number;
  kind: string; // 'image' | 'attachment'
  url: string;
  created_at: string;
}

export interface AdminUserDto {
  id: number;
  username: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  user: AdminUserDto;
  csrf_token: string;
}

export interface LogoutResponse {
  success: boolean;
}

export interface MeResponse {
  id: number;
  username: string;
  csrf_token: string;
}

export interface ApiErrorDetail {
  code: string;
  message: string;
}

export interface ApiErrorEnvelope {
  error: ApiErrorDetail;
}

// ============================================================================
// ApiClientError
// ============================================================================

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly retryAfter?: number;

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, ApiClientError.prototype);
  }

  isNotFound(): boolean {
    return (
      this.status === 404 ||
      this.code === 'PAGE_NOT_FOUND' ||
      this.code === 'NOT_FOUND' ||
      this.code === 'MEDIA_NOT_FOUND'
    );
  }

  isUnauthorized(): boolean {
    return (
      this.status === 401 ||
      this.code === 'UNAUTHORIZED' ||
      this.code === 'INVALID_CREDENTIALS'
    );
  }

  isForbidden(): boolean {
    return this.status === 403 || this.code === 'FORBIDDEN';
  }

  isConflict(): boolean {
    return (
      this.status === 409 ||
      this.code === 'REVISION_CONFLICT' ||
      this.code === 'SUBJECT_NOT_EMPTY'
    );
  }

  isRateLimited(): boolean {
    return this.status === 429 || this.code === 'RATE_LIMIT_EXCEEDED';
  }

  isValidationError(): boolean {
    return this.status === 400 || this.code === 'VALIDATION_ERROR';
  }

  isFileTooLarge(): boolean {
    return this.status === 413 || this.code === 'FILE_TOO_LARGE';
  }

  isSubjectNotEmpty(): boolean {
    return this.status === 409 && this.code === 'SUBJECT_NOT_EMPTY';
  }

  isRevisionConflict(): boolean {
    return this.status === 409 && this.code === 'REVISION_CONFLICT';
  }
}

// ============================================================================
// ApiClient
// ============================================================================

export class ApiClient {
  private csrfToken: string | null = null;
  private baseUrl: string = '';

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl;
  }

  public setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  public getCsrfToken(): string | null {
    return this.csrfToken;
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };

    const isMutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
    if (isMutating && this.csrfToken) {
      headers['X-CSRF-Token'] = this.csrfToken;
    }

    let bodyPayload: BodyInit | undefined;
    if (options.body !== undefined) {
      if (options.body instanceof FormData) {
        bodyPayload = options.body;
      } else {
        headers['Content-Type'] = 'application/json';
        bodyPayload = JSON.stringify(options.body);
      }
    }

    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: bodyPayload,
      credentials: 'include',
    });

    if (!response.ok) {
      let errorCode = 'UNKNOWN_ERROR';
      let errorMessage = `HTTP error ${response.status}`;

      try {
        const errorBody = (await response.json()) as ApiErrorEnvelope;
        if (errorBody && errorBody.error) {
          errorCode = errorBody.error.code || errorCode;
          errorMessage = errorBody.error.message || errorMessage;
        }
      } catch {
        errorMessage = response.statusText || errorMessage;
      }

      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

      throw new ApiClientError(response.status, errorCode, errorMessage, retryAfter);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }

  // --- Public API Methods ---

  public async getPublicSubjects(): Promise<PublicSubjectItem[]> {
    return this.request<PublicSubjectItem[]>('GET', '/api/public/subjects');
  }

  public async getPublicPages(params: {
    subject_id?: string;
    q?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<PublicPageListResponse> {
    const query = new URLSearchParams();
    if (params.subject_id) query.set('subject_id', params.subject_id);
    if (params.q) query.set('q', params.q);
    if (params.limit !== undefined) query.set('limit', params.limit.toString());
    if (params.offset !== undefined) query.set('offset', params.offset.toString());

    const qs = query.toString();
    const path = `/api/public/pages${qs ? `?${qs}` : ''}`;
    return this.request<PublicPageListResponse>('GET', path);
  }

  public async getPublicPage(id: string): Promise<PublicPageViewResponse> {
    const raw = await this.request<PublicPageViewResponse>(
      'GET',
      `/api/public/pages/${encodeURIComponent(id)}`
    );
    if (raw && raw.attachments) {
      raw.attachments = raw.attachments.map((att) => ({
        ...att,
        url: att.url || `/media/${att.id}`,
      }));
    }
    return raw;
  }

  // --- Auth API Methods ---

  public async login(credentials: LoginRequest): Promise<LoginResponse> {
    const res = await this.request<LoginResponse>('POST', '/api/admin/login', {
      body: credentials,
    });
    if (res.csrf_token) {
      this.csrfToken = res.csrf_token;
    }
    return res;
  }

  public async logout(): Promise<LogoutResponse> {
    try {
      const res = await this.request<LogoutResponse>('POST', '/api/admin/logout', {
        body: {},
      });
      return res;
    } finally {
      this.csrfToken = null;
    }
  }

  public async getMe(): Promise<MeResponse | null> {
    try {
      const res = await this.request<MeResponse>('GET', '/api/admin/me');
      if (res && res.csrf_token) {
        this.csrfToken = res.csrf_token;
      }
      return res;
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
        this.csrfToken = null;
        return null;
      }
      throw err;
    }
  }

  // --- Utility Methods ---

  public getMediaUrl(assetId: string): string {
    return `/media/${encodeURIComponent(assetId)}`;
  }

  // --- Admin Subjects ---

  public async getAdminSubjects(): Promise<SubjectResponse[]> {
    return this.request<SubjectResponse[]>('GET', '/api/admin/subjects');
  }

  public async createAdminSubject(req: CreateSubjectRequest | string): Promise<SubjectResponse> {
    const body = typeof req === 'string' ? { name: req } : req;
    return this.request<SubjectResponse>('POST', '/api/admin/subjects', { body });
  }

  public async updateAdminSubject(id: string, req: UpdateSubjectRequest): Promise<SubjectResponse> {
    return this.request<SubjectResponse>('PATCH', `/api/admin/subjects/${encodeURIComponent(id)}`, {
      body: req,
    });
  }

  public async deleteAdminSubject(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('DELETE', `/api/admin/subjects/${encodeURIComponent(id)}`);
  }

  // --- Admin Pages ---

  public async getAdminPages(): Promise<AdminPageListItem[]> {
    return this.request<AdminPageListItem[]>('GET', '/api/admin/pages');
  }

  public async createAdminPage(req: CreatePageRequest): Promise<AdminPageDetail> {
    return this.request<AdminPageDetail>('POST', '/api/admin/pages', { body: req });
  }

  public async getAdminPage(id: string): Promise<AdminPageDetail> {
    return this.request<AdminPageDetail>('GET', `/api/admin/pages/${encodeURIComponent(id)}`);
  }

  public async updateAdminPage(id: string, req: UpdatePageRequest): Promise<UpdatePageResponse> {
    return this.request<UpdatePageResponse>('PATCH', `/api/admin/pages/${encodeURIComponent(id)}`, {
      body: req,
    });
  }

  public async deleteAdminPage(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('DELETE', `/api/admin/pages/${encodeURIComponent(id)}`);
  }

  // --- Publishing ---

  public async publishAdminPage(id: string, req: PublishPageRequest): Promise<PublishPageResponse> {
    return this.request<PublishPageResponse>('POST', `/api/admin/pages/${encodeURIComponent(id)}/publish`, {
      body: req,
    });
  }

  public async unpublishAdminPage(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('DELETE', `/api/admin/pages/${encodeURIComponent(id)}/publication`);
  }

  // --- Assets ---

  public async getAdminPageAssets(pageId: string): Promise<AssetResponse[]> {
    return this.request<AssetResponse[]>('GET', `/api/admin/pages/${encodeURIComponent(pageId)}/assets`);
  }

  public async uploadAdminPageAsset(pageId: string, file: File): Promise<AssetResponse> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.request<AssetResponse>('POST', `/api/admin/pages/${encodeURIComponent(pageId)}/assets`, {
      body: formData,
    });
  }

  public async deleteAdminPageAsset(pageId: string, assetId: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(
      'DELETE',
      `/api/admin/pages/${encodeURIComponent(pageId)}/assets/${encodeURIComponent(assetId)}`
    );
  }
}

export const api = new ApiClient();
