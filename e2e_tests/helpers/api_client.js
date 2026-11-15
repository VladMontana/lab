// e2e_tests/helpers/api_client.js
import { CookieJar } from './cookie_jar.js';
import { config } from '../config.js';

export class ApiClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]
   * @param {CookieJar} [options.cookieJar]
   * @param {string|null} [options.csrfToken]
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || config.baseUrl;
    this.cookieJar = options.cookieJar || new CookieJar();
    this.csrfToken = options.csrfToken || null;
    
    try {
      this.origin = new URL(this.baseUrl).origin;
    } catch {
      this.origin = 'http://127.0.0.1:8080';
    }
  }

  /**
   * Perform an HTTP request with per-request timeout support.
   * @param {string} method
   * @param {string} path
   * @param {object} [options]
   * @param {number} [options.timeout] - Custom timeout in ms (defaults to config.testTimeout; 0 to disable)
   * @param {AbortSignal} [options.signal] - Optional caller AbortSignal
   * @returns {Promise<{status: number, ok: boolean, headers: Headers, data: any, text: string|null, raw: Response}>}
   */
  async request(method, path, options = {}) {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers = new Headers(options.headers || {});

    // Attach cookies from jar if not explicitly overridden
    const cookieHeader = this.cookieJar.getCookieHeader();
    if (cookieHeader && !headers.has('Cookie')) {
      headers.set('Cookie', cookieHeader);
    }

    // Attach Origin and CSRF token for mutating methods
    const upperMethod = method.toUpperCase();
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(upperMethod);
    if (isMutating) {
      if (!headers.has('Origin')) {
        headers.set('Origin', this.origin);
      }
      if (this.csrfToken && !headers.has('X-CSRF-Token')) {
        headers.set('X-CSRF-Token', this.csrfToken);
      }
    }

    let body = options.body;
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
    const isBuffer = Buffer.isBuffer(body);

    if (body !== undefined && !isFormData && !isBlob && !isBuffer && typeof body !== 'string') {
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      body = JSON.stringify(body);
    }

    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json, text/plain, */*');
    }

    const fetchOptions = {
      method: upperMethod,
      headers,
      body,
      redirect: options.redirect || 'manual',
    };

    // Attach per-request timeout signal (composed with caller signal if present)
    const timeoutMs = typeof options.timeout === 'number' ? options.timeout : config.testTimeout;
    if (options.signal && timeoutMs > 0) {
      fetchOptions.signal = typeof AbortSignal.any === 'function'
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
        : options.signal;
    } else if (options.signal) {
      fetchOptions.signal = options.signal;
    } else if (timeoutMs > 0) {
      fetchOptions.signal = AbortSignal.timeout(timeoutMs);
    }

    const res = await fetch(url, fetchOptions);

    // Update cookies from response
    this.cookieJar.setFromHeaders(res.headers);

    // Parse response payload
    const contentType = res.headers.get('content-type') || '';
    let data = null;
    let text = null;

    if (contentType.includes('application/json')) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    } else {
      try {
        text = await res.text();
      } catch {
        text = null;
      }
    }

    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      data,
      text,
      raw: res,
    };
  }

  get(path, options = {}) {
    return this.request('GET', path, options);
  }

  post(path, body, options = {}) {
    return this.request('POST', path, { ...options, body });
  }

  patch(path, body, options = {}) {
    return this.request('PATCH', path, { ...options, body });
  }

  put(path, body, options = {}) {
    return this.request('PUT', path, { ...options, body });
  }

  delete(path, options = {}) {
    return this.request('DELETE', path, options);
  }

  /**
   * Upload multipart/form-data.
   * @param {string} path
   * @param {FormData} formData
   * @param {object} [options]
   */
  async postMultipart(path, formData, options = {}) {
    return this.request('POST', path, {
      ...options,
      body: formData,
    });
  }

  /**
   * Login as admin using configured or custom credentials.
   * Updates session cookie and CSRF token.
   * @param {string} [username]
   * @param {string} [password]
   * @param {object} [options]
   */
  async login(username = config.adminUsername, password = config.adminPassword, options = {}) {
    const res = await this.post('/api/admin/login', { username, password }, options);
    if (res.ok && res.data?.csrf_token) {
      this.csrfToken = res.data.csrf_token;
    }
    return res;
  }

  /**
   * Logout current admin session.
   * Clears CSRF token and in-memory cookies.
   */
  async logout() {
    const res = await this.post('/api/admin/logout', {});
    this.csrfToken = null;
    this.cookieJar.clear();
    return res;
  }

  /**
   * Check current admin session via GET /api/admin/me.
   * Updates CSRF token if session is valid.
   */
  async checkMe() {
    const res = await this.get('/api/admin/me');
    if (res.ok && res.data?.csrf_token) {
      this.csrfToken = res.data.csrf_token;
    }
    return res;
  }

  /**
   * Create an independent clone of this client with isolated cookie jar.
   * @returns {ApiClient}
   */
  clone() {
    return new ApiClient({
      baseUrl: this.baseUrl,
      cookieJar: this.cookieJar.clone(),
      csrfToken: this.csrfToken,
    });
  }

  /**
   * Factory method to create an unauthenticated client.
   * @param {string} [baseUrl]
   * @returns {ApiClient}
   */
  static anonymous(baseUrl) {
    return new ApiClient({ baseUrl });
  }
}
