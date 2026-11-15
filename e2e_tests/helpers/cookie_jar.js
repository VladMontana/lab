// e2e_tests/helpers/cookie_jar.js

/**
 * RFC 6265 compliant in-memory cookie jar.
 * Supports Node.js native Headers.prototype.getSetCookie().
 */
export class CookieJar {
  constructor() {
    this.cookies = new Map(); // name -> { value, path, httpOnly, sameSite, secure, expires }
  }

  /**
   * Parse and store cookies from a Headers instance or plain object.
   * @param {Headers|object} headers
   */
  setFromHeaders(headers) {
    if (!headers) return;

    let rawCookies = [];
    if (typeof headers.getSetCookie === 'function') {
      rawCookies = headers.getSetCookie();
    } else if (typeof headers.get === 'function') {
      const single = headers.get('set-cookie');
      if (single) {
        rawCookies = [single];
      }
    } else if (headers['set-cookie']) {
      const sc = headers['set-cookie'];
      rawCookies = Array.isArray(sc) ? sc : [sc];
    }

    for (const raw of rawCookies) {
      this.parseCookie(raw);
    }
  }

  /**
   * Parse a single Set-Cookie string.
   * @param {string} cookieStr
   */
  parseCookie(cookieStr) {
    if (!cookieStr || typeof cookieStr !== 'string') return;
    const parts = cookieStr.split(';').map(p => p.trim());
    const [nameVal, ...attrs] = parts;
    const eqIdx = nameVal.indexOf('=');
    if (eqIdx === -1) return;

    const name = nameVal.slice(0, eqIdx).trim();
    const value = nameVal.slice(eqIdx + 1).trim();
    if (!name) return;

    const cookieObj = {
      value,
      httpOnly: false,
      sameSite: 'Lax',
      secure: false,
      path: '/',
      expires: null,
    };

    for (const attr of attrs) {
      const lower = attr.toLowerCase();
      if (lower === 'httponly') {
        cookieObj.httpOnly = true;
      } else if (lower === 'secure') {
        cookieObj.secure = true;
      } else if (lower.startsWith('path=')) {
        cookieObj.path = attr.slice(5).trim();
      } else if (lower.startsWith('samesite=')) {
        cookieObj.sameSite = attr.slice(9).trim();
      } else if (lower.startsWith('max-age=')) {
        const maxAge = parseInt(attr.slice(8).trim(), 10);
        if (maxAge <= 0) {
          this.cookies.delete(name);
          return;
        }
      } else if (lower.startsWith('expires=')) {
        const expiresDate = new Date(attr.slice(8).trim());
        if (!isNaN(expiresDate.getTime())) {
          cookieObj.expires = expiresDate;
          if (expiresDate.getTime() <= Date.now()) {
            this.cookies.delete(name);
            return;
          }
        }
      }
    }

    this.cookies.set(name, cookieObj);
  }

  /**
   * Get the Cookie header string for outgoing requests.
   * @returns {string}
   */
  getCookieHeader() {
    if (this.cookies.size === 0) return '';
    const pairs = [];
    for (const [name, obj] of this.cookies.entries()) {
      pairs.push(`${name}=${obj.value}`);
    }
    return pairs.join('; ');
  }

  /**
   * Get cookie value by name.
   * @param {string} name
   * @returns {string|undefined}
   */
  get(name) {
    return this.cookies.get(name)?.value;
  }

  /**
   * Get full cookie details by name.
   * @param {string} name
   * @returns {object|undefined}
   */
  getDetails(name) {
    const c = this.cookies.get(name);
    return c ? { ...c } : undefined;
  }

  /**
   * Programmatically set a cookie.
   * @param {string} name
   * @param {string} value
   * @param {object} attributes
   */
  set(name, value, attributes = {}) {
    this.cookies.set(name, {
      value,
      httpOnly: false,
      sameSite: 'Lax',
      secure: false,
      path: '/',
      expires: null,
      ...attributes,
    });
  }

  /**
   * Delete a cookie by name.
   * @param {string} name
   */
  delete(name) {
    this.cookies.delete(name);
  }

  /**
   * Clear all cookies.
   */
  clear() {
    this.cookies.clear();
  }

  /**
   * Clone this cookie jar.
   * @returns {CookieJar}
   */
  clone() {
    const jar = new CookieJar();
    for (const [k, v] of this.cookies.entries()) {
      jar.cookies.set(k, { ...v });
    }
    return jar;
  }
}
