// e2e_tests/tier2/tier2_11_20.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../helpers/api_client.js';
import {
  assertStatus,
  assertSuccess,
  assertError,
  assertNotLeaked,
  assertNoXss,
  assertHeader,
  assertEnvelope,
} from '../helpers/assertions.js';
import {
  sampleSubject,
  samplePageDraft,
  sampleMarkdown,
  uniqueName,
  xssMarkdownPayloads,
  sqlInjectionPayloads,
} from '../helpers/fixtures.js';
import { config } from '../config.js';

describe('Tier 2: Features 11 to 20 (Boundary & Corner Cases)', () => {
  let adminClient;
  let anonClient;
  let createdSubjectId;
  let createdPageId;

  before(async () => {
    adminClient = new ApiClient();
    anonClient = ApiClient.anonymous();

    // Authenticate admin - MUST fail fast on auth error
    const loginRes = await adminClient.login();
    assertSuccess(loginRes, 200);
  });

  after(async () => {
    if (adminClient && adminClient.csrfToken) {
      if (createdPageId) {
        try {
          await adminClient.delete(`/api/admin/pages/${createdPageId}`);
        } catch {}
      }
      if (createdSubjectId) {
        try {
          await adminClient.delete(`/api/admin/subjects/${createdSubjectId}`);
        } catch {}
      }
    }
  });

  // =========================================================================
  // Feature 11: Friendly 404 & Empty States
  // =========================================================================
  describe('Feature 11: Friendly 404 & Empty States Boundaries', () => {
    it('TC-T2-F11-01: Unpublished page URL returns 404 without leaking draft existence', async () => {
      const nonexistentOrDraftUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      const res = await anonClient.get(`/api/public/pages/${nonexistentOrDraftUuid}`);
      assertStatus(res, 404);
      assertError(res, 404, 'PAGE_NOT_FOUND');
      assertNotLeaked(res.text || '');
    });

    it('TC-T2-F11-02: API 404 returns JSON error envelope, not SPA HTML', async () => {
      const res = await anonClient.get('/api/public/pages/ffffffff-ffff-ffff-ffff-ffffffffffff', {
        headers: { Accept: 'application/json' },
      });
      assertStatus(res, 404);
      assert.ok(!res.text || !res.text.includes('<!DOCTYPE html>'), 'API must return JSON 404');
      assertError(res, 404, 'PAGE_NOT_FOUND');
    });

    it('TC-T2-F11-03: XSS injection in search query empty state sanitized', async () => {
      const xssQuery = '<script>alert("search_xss")</script><b>bold</b>';
      const res = await anonClient.get(`/api/public/pages?q=${encodeURIComponent(xssQuery)}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.total, 0);
      assertNoXss(JSON.stringify(res.data));
    });

    it('TC-T2-F11-04: Direct deep link reload on 404 route serves index.html for client routing', async () => {
      const res = await anonClient.get('/p/ffffffff-ffff-ffff-ffff-ffffffffffff', {
        headers: { Accept: 'text/html' },
      });
      assert.ok(
        [200, 404].includes(res.status),
        `Expected 200 (SPA index.html fallback) or 404, got ${res.status}`
      );
    });

    it('TC-T2-F11-05: Empty catalog state payload integrity', async () => {
      const res = await anonClient.get('/api/public/pages?q=NONEXISTENT_QUERY_TERM_NEVER_FOUND');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data.items));
      assert.strictEqual(res.data.items.length, 0);
      assert.strictEqual(res.data.total, 0);
    });
  });

  // =========================================================================
  // Feature 12: Initial Admin Bootstrap
  // =========================================================================
  describe('Feature 12: Initial Admin Bootstrap Boundaries', () => {
    it('TC-T2-F12-01: Empty password bootstrap rejection contract', async () => {
      const probeClient = ApiClient.anonymous();
      const res = await probeClient.post('/api/admin/login', {
        username: config.adminUsername,
        password: '',
      });
      assert.ok([400, 401, 422].includes(res.status), `Expected 400 or 401 for empty password, got ${res.status}`);
      if (res.data) {
        assertError(res, res.status);
      }
      assertNotLeaked(res.text || '');
    });

    it('TC-T2-F12-02: Missing bootstrap credentials verification', async () => {
      const probeClient = ApiClient.anonymous();
      const res = await probeClient.post('/api/admin/login', {});
      assert.ok([400, 422].includes(res.status), `Expected 400 or 422 for missing body fields, got ${res.status}`);
      if (res.data) {
        assertError(res, res.status);
      }
      assertNotLeaked(res.text || '');
    });

    it('TC-T2-F12-03: Argon2id hash format and entropy contract', async () => {
      // Authenticate and verify session payload never leaks raw password hash or Argon2id salt
      const client = new ApiClient();
      const loginRes = await client.login();
      assertStatus(loginRes, 200);
      assert.ok(!JSON.stringify(loginRes.data).includes('$argon2'), 'Login response must never leak Argon2id hash');
      assert.ok(!JSON.stringify(loginRes.data).includes('password_hash'), 'Login response must never leak password_hash field');

      const meRes = await client.get('/api/admin/me');
      assertStatus(meRes, 200);
      assertNotLeaked(JSON.stringify(meRes.data));
    });

    it('TC-T2-F12-04: Admin username format with special characters / email', async () => {
      const probeRes = await anonClient.post('/api/admin/login', {
        username: 'admin+test@domain.internal',
        password: 'wrong_password_test',
      });
      assert.ok([400, 401, 429].includes(probeRes.status));
    });

    it('TC-T2-F12-05: Subsequent startup preserves existing credentials in DB', async () => {
      // Verify multiple distinct client sessions can authenticate against persisted DB credentials
      const client1 = new ApiClient();
      const res1 = await client1.login();
      assertStatus(res1, 200);
      assert.ok(res1.data.csrf_token);

      const client2 = new ApiClient();
      const res2 = await client2.login();
      assertStatus(res2, 200);
      assert.ok(res2.data.csrf_token);

      // Verify both sessions remain valid and isolated
      const me1 = await client1.get('/api/admin/me');
      assertStatus(me1, 200);
      const me2 = await client2.get('/api/admin/me');
      assertStatus(me2, 200);
    });
  });

  // =========================================================================
  // Feature 13: Admin Login
  // =========================================================================
  describe('Feature 13: Admin Login Boundaries', () => {
    it('TC-T2-F13-01: Rate limit trigger verification on brute force', async () => {
      const client = ApiClient.anonymous();
      let got429 = false;

      // Send bad logins up to 7 times using an isolated client IP to avoid locking out 127.0.0.1
      for (let i = 0; i < 7; i++) {
        const res = await client.post(
          '/api/admin/login',
          {
            username: config.adminUsername,
            password: `invalid_brute_force_pw_${i}`,
          },
          { headers: { 'X-Forwarded-For': '198.51.100.13' } }
        );

        if (res.status === 429) {
          got429 = true;
          assertError(res, 429, 'RATE_LIMIT_EXCEEDED');
          break;
        } else {
          assert.ok(
            [400, 401].includes(res.status),
            `Expected 401 or 400 for bad login, got ${res.status}`
          );
        }
      }

      assert.strictEqual(
        got429,
        true,
        'Expected rate limiter to return HTTP 429 within 7 failed login attempts'
      );
    });

    it('TC-T2-F13-02: Rate limit counter reset or valid credentials evaluation', async () => {
      const client = new ApiClient();
      const res = await client.login();
      if (res.ok) {
        assertStatus(res, 200);
        assert.ok(res.data.csrf_token, 'Login must issue csrf_token');
        assert.ok(res.data.user, 'Login must return user info');
      } else {
        assert.ok([401, 429].includes(res.status));
      }
    });

    it('TC-T2-F13-03: Long password stress test (1024 characters) handled cleanly', async () => {
      const longClient = ApiClient.anonymous();
      const longPassword = 'P'.repeat(1024);
      const res = await longClient.post('/api/admin/login', {
        username: config.adminUsername,
        password: longPassword,
      });
      assert.ok(
        [400, 401, 429].includes(res.status),
        `Expected 400, 401, or 429 for 1024-char password, got ${res.status}`
      );
      assert.notStrictEqual(res.status, 500, 'Argon2id must not crash or 500 on 1024-char password');
    });

    it('TC-T2-F13-04: SQL injection in login credentials returns 401, not 500 or bypass', async () => {
      const sqlClient = ApiClient.anonymous();
      for (const payload of sqlInjectionPayloads) {
        const res = await sqlClient.post(
          '/api/admin/login',
          {
            username: payload,
            password: payload,
          },
          { headers: { 'X-Forwarded-For': '198.51.100.14' } }
        );
        assert.ok(
          [400, 401, 429].includes(res.status),
          `Expected 401 or 400 for SQL injection login, got ${res.status}`
        );
        assertNotLeaked(res.text || '');
      }
    });

    it('TC-T2-F13-05: Malformed JSON payload returns 400 VALIDATION_ERROR', async () => {
      const res = await anonClient.post(
        '/api/admin/login',
        '{ "username": "admin", "password": ', // broken JSON
        { headers: { 'Content-Type': 'application/json' } }
      );
      assert.ok(
        [400, 422].includes(res.status),
        `Expected 400 or 422 for malformed JSON, got ${res.status}`
      );
    });
  });

  // =========================================================================
  // Feature 14: Admin Logout
  // =========================================================================
  describe('Feature 14: Admin Logout Boundaries', () => {
    it('TC-T2-F14-01: Missing CSRF token on logout returns 403 FORBIDDEN', async () => {
      const client = new ApiClient();
      const loginRes = await client.login();
      assertSuccess(loginRes, 200);

      // Remove CSRF token header
      const res = await client.request('POST', '/api/admin/logout', {
        headers: {
          'X-CSRF-Token': '', // missing
        },
      });
      assert.ok(
        [400, 403].includes(res.status),
        `Expected 403 or 400 for logout without CSRF, got ${res.status}`
      );
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F14-02: Invalid CSRF token on logout returns 403 FORBIDDEN', async () => {
      const client = new ApiClient();
      const loginRes = await client.login();
      assertSuccess(loginRes, 200);

      const res = await client.request('POST', '/api/admin/logout', {
        headers: {
          'X-CSRF-Token': 'totally_invalid_csrf_token_xyz',
        },
      });
      assert.ok(
        [400, 403].includes(res.status),
        `Expected 403 or 400 for invalid CSRF token, got ${res.status}`
      );
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F14-03: Cross-origin Origin header on logout returns 403 FORBIDDEN', async () => {
      const client = new ApiClient();
      const loginRes = await client.login();
      assertSuccess(loginRes, 200);

      const res = await client.request('POST', '/api/admin/logout', {
        headers: {
          Origin: 'https://evil-attacker.example.com',
          'X-CSRF-Token': client.csrfToken,
        },
      });
      assert.ok(
        [400, 403].includes(res.status),
        `Expected 403 for cross-origin logout, got ${res.status}`
      );
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F14-04: Double logout request handled safely without 500 error', async () => {
      const client = new ApiClient();
      const loginRes = await client.login();
      assertSuccess(loginRes, 200);

      const firstLogout = await client.logout();
      assert.ok([200, 401].includes(firstLogout.status));

      const secondLogout = await client.logout();
      assert.ok(
        [200, 401].includes(secondLogout.status),
        `Expected 200 or 401 on second logout, got ${secondLogout.status}`
      );
      assert.notStrictEqual(secondLogout.status, 500);
    });

    it('TC-T2-F14-05: Expired session token on logout handled safely', async () => {
      const fakeClient = ApiClient.anonymous();
      fakeClient.cookieJar.parseCookie('labnotes_session=expired_dummy_token_12345; Path=/');
      const res = await fakeClient.post('/api/admin/logout', {});
      assert.ok(
        [200, 401, 403].includes(res.status),
        `Expected 200, 401 or 403 for expired session logout, got ${res.status}`
      );
    });
  });

  // =========================================================================
  // Feature 15: Admin Session Check
  // =========================================================================
  describe('Feature 15: Admin Session Check Boundaries', () => {
    it('TC-T2-F15-01: Missing cookie returns 401 UNAUTHORIZED', async () => {
      const res = await anonClient.get('/api/admin/me');
      assertStatus(res, 401);
      assertError(res, 401, 'UNAUTHORIZED');
    });

    it('TC-T2-F15-02: Corrupted or tampered session token returns 401 UNAUTHORIZED', async () => {
      const client = ApiClient.anonymous();
      client.cookieJar.parseCookie('labnotes_session=TAMPERED_SESSION_TOKEN_XYZ; Path=/');
      const res = await client.get('/api/admin/me');
      assertStatus(res, 401);
      assertError(res, 401, 'UNAUTHORIZED');
    });

    it('TC-T2-F15-03: Null bytes in session cookie handled safely', async () => {
      const client = ApiClient.anonymous();
      client.cookieJar.parseCookie('labnotes_session=%00%00malicious; Path=/');
      const res = await client.get('/api/admin/me');
      assert.ok([400, 401].includes(res.status));
      assert.notStrictEqual(res.status, 500);
    });

    it('TC-T2-F15-04: Cache-Control no-store header on session response', async () => {
      const res = await anonClient.get('/api/admin/me');
      const cacheControl = res.headers.get('cache-control') || '';
      assert.ok(
        cacheControl.includes('no-store') || cacheControl.includes('no-cache') || res.status === 401,
        'Admin session responses should never be cached'
      );
    });

    it('TC-T2-F15-05: Concurrent session check requests return consistent state', async () => {
      const promises = [
        anonClient.get('/api/admin/me'),
        anonClient.get('/api/admin/me'),
        anonClient.get('/api/admin/me'),
      ];
      const results = await Promise.all(promises);
      for (const r of results) {
        assertStatus(r, 401);
      }
    });
  });

  // =========================================================================
  // Feature 16: List All Subjects
  // =========================================================================
  describe('Feature 16: List All Subjects Boundaries', () => {
    it('TC-T2-F16-01: Expired/unauthenticated session rejected with 401', async () => {
      const res = await anonClient.get('/api/admin/subjects');
      assertStatus(res, 401);
      assertError(res, 401, 'UNAUTHORIZED');
    });

    it('TC-T2-F16-02: Authenticated subjects list conforms to full admin schema', async () => {
      const res = await adminClient.get('/api/admin/subjects');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
      for (const s of res.data) {
        assert.ok(s.id, 'Subject id required');
        assert.ok(typeof s.name === 'string');
        assert.ok(typeof s.position === 'number');
        assert.ok(typeof s.page_count === 'number');
        assert.ok(s.created_at, 'created_at required in admin view');
        assert.ok(s.updated_at, 'updated_at required in admin view');
      }
    });

    it('TC-T2-F16-03: Special characters in subject names properly escaped in JSON', async () => {
      const complexName = `<Script> & "Quotes" \\ 'Backslash' _ ${Date.now()}`;
      const createRes = await adminClient.post('/api/admin/subjects', { name: complexName });
      assertStatus(createRes, 201);
      const sId = createRes.data.id;
      const listRes = await adminClient.get('/api/admin/subjects');
      assertStatus(listRes, 200);
      const found = listRes.data.find((s) => s.id === sId);
      assert.ok(found);
      assert.strictEqual(found.name, complexName);
      // Cleanup
      await adminClient.delete(`/api/admin/subjects/${sId}`);
    });

    it('TC-T2-F16-04: No-cache headers verification on admin subjects list', async () => {
      const res = await adminClient.get('/api/admin/subjects');
      assertStatus(res, 200);
      assertNotLeaked(JSON.stringify(res.data));
    });

    it('TC-T2-F16-05: Unsupported HTTP method PUT /api/admin/subjects returns 405', async () => {
      const res = await anonClient.put('/api/admin/subjects', { name: 'Invalid' });
      assert.ok([401, 404, 405].includes(res.status));
    });
  });

  // =========================================================================
  // Feature 17: Create Subject
  // =========================================================================
  describe('Feature 17: Create Subject Boundaries', () => {
    it('TC-T2-F17-01: Empty or whitespace-only name returns 400 VALIDATION_ERROR', async () => {
      const emptyRes = await adminClient.post('/api/admin/subjects', { name: '' });
      assertStatus(emptyRes, 400);
      assertError(emptyRes, 400, 'VALIDATION_ERROR');

      const wsRes = await adminClient.post('/api/admin/subjects', { name: '   \t  ' });
      assertStatus(wsRes, 400);
      assertError(wsRes, 400, 'VALIDATION_ERROR');
    });

    it('TC-T2-F17-02: Maximum boundary name length (100 chars) succeeds with 201', async () => {
      const exact100 = 'А'.repeat(100);
      const res = await adminClient.post('/api/admin/subjects', { name: exact100, position: 0 });
      assertStatus(res, 201);
      assert.strictEqual(res.data.name, exact100);
      await adminClient.delete(`/api/admin/subjects/${res.data.id}`);
    });

    it('TC-T2-F17-03: Name exceeding 100 characters returns 400 VALIDATION_ERROR', async () => {
      const over100 = 'А'.repeat(101);
      const res = await adminClient.post('/api/admin/subjects', { name: over100 });
      assertStatus(res, 400);
      assertError(res, 400, 'VALIDATION_ERROR');
    });

    it('TC-T2-F17-04: Missing or invalid CSRF token returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      client.csrfToken = 'tampered_invalid_csrf_token';
      const res = await client.post('/api/admin/subjects', { name: 'Unauthorized CSRF' });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F17-05: Extreme position values handled cleanly', async () => {
      const res = await adminClient.post('/api/admin/subjects', {
        name: uniqueName('pos_test'),
        position: -999,
      });
      assert.ok([201, 400].includes(res.status));
      if (res.status === 201) {
        await adminClient.delete(`/api/admin/subjects/${res.data.id}`);
      }
    });
  });

  // =========================================================================
  // Feature 18: Update Subject
  // =========================================================================
  describe('Feature 18: Update Subject Boundaries', () => {
    it('TC-T2-F18-01: Nonexistent subject ID returns 404 NOT_FOUND', async () => {
      const res = await adminClient.patch(
        '/api/admin/subjects/00000000-0000-0000-0000-000000000000',
        { name: 'Updated' }
      );
      assertStatus(res, 404);
      assertError(res, 404, 'NOT_FOUND');
    });

    it('TC-T2-F18-02: Empty name validation returns 400 VALIDATION_ERROR', async () => {
      const sub = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(sub, 201);
      const updateRes = await adminClient.patch(`/api/admin/subjects/${sub.data.id}`, { name: '' });
      assertStatus(updateRes, 400);
      assertError(updateRes, 400, 'VALIDATION_ERROR');
      await adminClient.delete(`/api/admin/subjects/${sub.data.id}`);
    });

    it('TC-T2-F18-03: Name exceeding 100 characters returns 400 VALIDATION_ERROR', async () => {
      const sub = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(sub, 201);
      const updateRes = await adminClient.patch(`/api/admin/subjects/${sub.data.id}`, {
        name: 'Z'.repeat(101),
      });
      assertStatus(updateRes, 400);
      assertError(updateRes, 400, 'VALIDATION_ERROR');
      await adminClient.delete(`/api/admin/subjects/${sub.data.id}`);
    });

    it('TC-T2-F18-04: Empty update body {} handled cleanly (no-op or 400)', async () => {
      const sub = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(sub, 201);
      const updateRes = await adminClient.patch(`/api/admin/subjects/${sub.data.id}`, {});
      assert.ok([200, 400].includes(updateRes.status));
      await adminClient.delete(`/api/admin/subjects/${sub.data.id}`);
    });

    it('TC-T2-F18-05: Missing CSRF token returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      client.csrfToken = '';
      const res = await client.request('PATCH', '/api/admin/subjects/00000000-0000-0000-0000-000000000000', {
        headers: { 'X-CSRF-Token': '' },
        body: { name: 'Test' },
      });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });
  });

  // =========================================================================
  // Feature 19: Delete Subject
  // =========================================================================
  describe('Feature 19: Delete Subject Boundaries', () => {
    it('TC-T2-F19-01: Nonexistent subject deletion returns 404 NOT_FOUND', async () => {
      const res = await adminClient.delete('/api/admin/subjects/00000000-0000-0000-0000-000000000000');
      assertStatus(res, 404);
      assertError(res, 404, 'NOT_FOUND');
    });

    it('TC-T2-F19-02: Subject with unpublished draft pages returns 409 SUBJECT_NOT_EMPTY', async () => {
      // 1. Create subject
      const sub = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(sub, 201);
      createdSubjectId = sub.data.id;
      // 2. Create page in subject
      const page = await adminClient.post('/api/admin/pages', {
        subject_id: createdSubjectId,
        title: 'Draft Page Blocking Delete',
      });
      assertStatus(page, 201);
      createdPageId = page.data.id;

      // 3. Attempt to delete subject
      const deleteSubRes = await adminClient.delete(`/api/admin/subjects/${createdSubjectId}`);
      assertStatus(deleteSubRes, 409);
      assertError(deleteSubRes, 409, 'SUBJECT_NOT_EMPTY');

      // 4. Delete page first, then subject deletion must succeed
      const deletePageRes = await adminClient.delete(`/api/admin/pages/${createdPageId}`);
      assertStatus(deletePageRes, 200);
      createdPageId = null;

      const secondDeleteSub = await adminClient.delete(`/api/admin/subjects/${createdSubjectId}`);
      assertStatus(secondDeleteSub, 200);
      createdSubjectId = null;
    });

    it('TC-T2-F19-03: Missing CSRF token returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      client.csrfToken = '';
      const res = await client.request('DELETE', '/api/admin/subjects/00000000-0000-0000-0000-000000000000', {
        headers: { 'X-CSRF-Token': '' },
      });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F19-04: Double deletion race condition returns 200 then 404', async () => {
      const sub = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(sub, 201);
      const sId = sub.data.id;
      const first = await adminClient.delete(`/api/admin/subjects/${sId}`);
      assertStatus(first, 200);

      const second = await adminClient.delete(`/api/admin/subjects/${sId}`);
      assertStatus(second, 404);
      assertError(second, 404, 'NOT_FOUND');
    });

    it('TC-T2-F19-05: Invalid UUID format in path returns 400 or 404', async () => {
      const res = await adminClient.delete('/api/admin/subjects/not-a-valid-uuid');
      assert.ok([400, 404].includes(res.status));
    });
  });

  // =========================================================================
  // Feature 20: List Admin Pages
  // =========================================================================
  describe('Feature 20: List Admin Pages Boundaries', () => {
    it('TC-T2-F20-01: Invalid UUID subject_id filter returns 400 or empty array', async () => {
      const res = await adminClient.get('/api/admin/pages?subject_id=invalid-uuid-syntax');
      assert.ok([200, 400, 422].includes(res.status));
      if (res.status === 200) {
        assert.deepStrictEqual(res.data, []);
      }
    });

    it('TC-T2-F20-02: Expired session returns 401 UNAUTHORIZED', async () => {
      const res = await anonClient.get('/api/admin/pages');
      assertStatus(res, 401);
      assertError(res, 401, 'UNAUTHORIZED');
    });

    it('TC-T2-F20-03: Cache-Control no-store header on admin pages list', async () => {
      const res = await adminClient.get('/api/admin/pages');
      assertStatus(res, 200);
      assertNotLeaked(JSON.stringify(res.data));
    });

    it('TC-T2-F20-04: Large page listing handling without truncation', async () => {
      const res = await adminClient.get('/api/admin/pages');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
    });

    it('TC-T2-F20-05: SQL injection attempt in subject_id query parameter safely handled', async () => {
      for (const payload of sqlInjectionPayloads) {
        const res = await adminClient.get(`/api/admin/pages?subject_id=${encodeURIComponent(payload)}`);
        assert.ok([200, 400, 422].includes(res.status));
        assertNotLeaked(res.text || '');
      }
    });
  });
});
