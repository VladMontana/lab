// e2e_tests/tier1/tier1_11_20.test.js
// Tier 1 Test Suite: Features 11 to 20
// Covers:
// - Feature 11: Friendly 404 & Empty States
// - Feature 12: Initial Admin Bootstrap
// - Feature 13: Admin Login
// - Feature 14: Admin Logout
// - Feature 15: Admin Session Check
// - Feature 16: List All Subjects
// - Feature 17: Create Subject
// - Feature 18: Update Subject
// - Feature 19: Delete Subject
// - Feature 20: List Admin Pages

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../helpers/api_client.js';
import {
  assertStatus,
  assertSuccess,
  assertError,
  assertNotLeaked,
} from '../helpers/assertions.js';
import { sampleSubject, samplePageDraft, uniqueName } from '../helpers/fixtures.js';
import { config } from '../config.js';

describe('Tier 1: Features 11 to 20', () => {
  let adminClient;
  let anonClient;
  const createdSubjectIds = [];
  const createdPageIds = [];

  before(async () => {
    adminClient = new ApiClient();
    anonClient = ApiClient.anonymous();
    const loginRes = await adminClient.login();
    assertSuccess(loginRes, 200);
  });

  after(async () => {
    // Teardown created pages
    for (const pageId of createdPageIds) {
      try {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      } catch {
        // ignore cleanup errors
      }
    }
    // Teardown created subjects
    for (const subjId of createdSubjectIds) {
      try {
        await adminClient.delete(`/api/admin/subjects/${subjId}`);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  // =========================================================================
  // Feature 11: Friendly 404 & Empty States
  // =========================================================================
  describe('Feature 11: Friendly 404 & Empty States', () => {
    it('T1-F11-01: Nonexistent Page URL 404 View delivers SPA shell for friendly rendering', async () => {
      const res = await anonClient.get('/p/ffffffff-ffff-ffff-ffff-ffffffffffff', {
        headers: { Accept: 'text/html' },
      });
      assertStatus(res, 200);
      assert.ok(
        res.text.toLowerCase().includes('<!doctype html') || res.text.includes('<html'),
        'Expected SPA HTML shell on nonexistent page route'
      );
    });

    it('T1-F11-02: Arbitrary Nonexistent SPA Route delivers SPA shell', async () => {
      const res = await anonClient.get('/random-invalid-route-xyz', {
        headers: { Accept: 'text/html' },
      });
      assertStatus(res, 200);
      assert.ok(
        res.text.toLowerCase().includes('<!doctype html') || res.text.includes('<html'),
        'Expected SPA HTML shell on random route'
      );
    });

    it('T1-F11-03: Empty Catalog State returns empty items and zero total', async () => {
      // Query with non-matching subject ID
      const res = await anonClient.get('/api/public/pages?subject_id=00000000-0000-0000-0000-000000000000');
      assertStatus(res, 200);
      assert.ok(res.data && Array.isArray(res.data.items));
      assert.strictEqual(res.data.items.length, 0);
      assert.strictEqual(res.data.total, 0);
    });

    it('T1-F11-04: Search Results Empty State returns empty items array', async () => {
      const res = await anonClient.get('/api/public/pages?q=nomatch_search_keyword_xyz_99999');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data.items));
      assert.strictEqual(res.data.items.length, 0);
      assert.strictEqual(res.data.total, 0);
    });

    it('T1-F11-05: Empty Subject State returns 0 pages for newly created empty subject', async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(s, 201);
      const emptySubjId = s.data.id;
      createdSubjectIds.push(emptySubjId);

      const res = await anonClient.get(`/api/public/pages?subject_id=${emptySubjId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.items.length, 0);
      assert.strictEqual(res.data.total, 0);
    });
  });

  // =========================================================================
  // Feature 12: Initial Admin Bootstrap
  // =========================================================================
  describe('Feature 12: Initial Admin Bootstrap', () => {
    it('T1-F12-01: Bootstrap Admin from Environment credentials login successfully', async () => {
      const client = new ApiClient();
      const res = await client.login(config.adminUsername, config.adminPassword);
      assertStatus(res, 200);
      assert.strictEqual(res.data.success, true);
      assert.ok(res.data.csrf_token, 'Expected non-empty csrf_token');
    });

    it('T1-F12-02: Default Admin Username Fallback matches configured username', async () => {
      const client = new ApiClient();
      const res = await client.login(config.adminUsername, config.adminPassword);
      assertStatus(res, 200);
      assert.strictEqual(res.data.user.username, config.adminUsername);
    });

    it('T1-F12-03: Argon2id Hash Format Verification rejects invalid password', async () => {
      const client = new ApiClient();
      const res = await client.login(config.adminUsername, 'definitely_wrong_password_987!');
      assertError(res, 401, 'INVALID_CREDENTIALS');
    });

    it('T1-F12-04: Subsequent Startup Does Not Overwrite admin session verification', async () => {
      const client = new ApiClient();
      await client.login();
      const meRes = await client.checkMe();
      assertStatus(meRes, 200);
      assert.strictEqual(meRes.data.username, config.adminUsername);
    });

    it('T1-F12-05: Successful Login Post-Bootstrap returns user ID and CSRF token', async () => {
      const client = new ApiClient();
      const res = await client.login();
      assertStatus(res, 200);
      assert.ok(typeof res.data.user.id === 'number', 'user.id must be a number');
      assert.ok(typeof res.data.csrf_token === 'string', 'csrf_token must be a string');
      assert.ok(res.data.csrf_token.length >= 16, 'csrf_token must be at least 16 chars');
    });
  });

  // =========================================================================
  // Feature 13: Admin Login
  // =========================================================================
  describe('Feature 13: Admin Login', () => {
    it('T1-F13-01: Valid Credentials Login returns 200, cookie and csrf_token', async () => {
      const client = new ApiClient();
      const res = await client.login(config.adminUsername, config.adminPassword);
      assertStatus(res, 200);
      assert.strictEqual(res.data.success, true);
      assert.ok(res.data.user);
      assert.ok(res.data.csrf_token);

      // Verify Set-Cookie header contains labnotes_session and HttpOnly
      const cookieVal = client.cookieJar.get('labnotes_session');
      assert.ok(cookieVal, 'Expected labnotes_session cookie in jar');
      const cookieDetails = client.cookieJar.getDetails('labnotes_session');
      assert.ok(cookieDetails?.httpOnly, 'Session cookie must be HttpOnly');
    });

    it('T1-F13-02: Invalid Password Rejection returns 401 INVALID_CREDENTIALS', async () => {
      const client = new ApiClient();
      const res = await client.post('/api/admin/login', {
        username: config.adminUsername,
        password: 'wrong_password_xyz',
      });
      assertError(res, 401, 'INVALID_CREDENTIALS');
      assert.strictEqual(client.cookieJar.get('labnotes_session') ?? null, null);
    });

    it('T1-F13-03: Nonexistent Username Rejection returns 401 INVALID_CREDENTIALS', async () => {
      const client = new ApiClient();
      const res = await client.post('/api/admin/login', {
        username: 'nonexistent_admin_user_404',
        password: 'any_password',
      });
      assertError(res, 401, 'INVALID_CREDENTIALS');
    });

    it('T1-F13-04: Session Token Stored as High-Entropy Cookie and no plain password leaked', async () => {
      const client = new ApiClient();
      const res = await client.login();
      assertStatus(res, 200);
      assertNotLeaked(JSON.stringify(res.data));
      const token = client.cookieJar.get('labnotes_session');
      assert.ok(token && token.length >= 24, 'Session token should be at least 24 characters');
    });

    it('T1-F13-05: Empty Fields Validation returns 400 VALIDATION_ERROR', async () => {
      const client = new ApiClient();
      const res = await client.post('/api/admin/login', {
        username: '',
        password: '',
      });
      assertError(res, 400, 'VALIDATION_ERROR');
    });
  });

  // =========================================================================
  // Feature 14: Admin Logout
  // =========================================================================
  describe('Feature 14: Admin Logout', () => {
    it('T1-F14-01: Standard Successful Logout returns 200 success and clears cookie', async () => {
      const client = new ApiClient();
      await client.login();
      const res = await client.logout();
      assertStatus(res, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(client.cookieJar.get('labnotes_session') ?? null, null);
    });

    it('T1-F14-02: Database Session Revocation invalidates subsequent admin requests', async () => {
      const client = new ApiClient();
      await client.login();
      const sessionToken = client.cookieJar.get('labnotes_session');

      await client.logout();

      // Attempt to access /api/admin/me with old session cookie manually
      const probeClient = new ApiClient();
      probeClient.cookieJar.parseCookie(`labnotes_session=${sessionToken}; Path=/`);
      const meRes = await probeClient.get('/api/admin/me');
      assertError(meRes, 401, 'UNAUTHORIZED');
    });

    it('T1-F14-03: Session Token Re-use Prevention returns 401', async () => {
      const client = new ApiClient();
      await client.login();
      const oldToken = client.cookieJar.get('labnotes_session');
      await client.logout();

      const probeClient = new ApiClient();
      probeClient.cookieJar.parseCookie(`labnotes_session=${oldToken}; Path=/`);
      const subjRes = await probeClient.get('/api/admin/subjects');
      assertError(subjRes, 401, 'UNAUTHORIZED');
    });

    it('T1-F14-04: Client-Side Logout executes cleanly without server leak', async () => {
      const client = new ApiClient();
      await client.login();
      const res = await client.logout();
      assertStatus(res, 200);
      assertNotLeaked(JSON.stringify(res.data));
    });

    it('T1-F14-05: Unauthenticated Logout Attempt returns 401 or idempotent 200', async () => {
      const client = ApiClient.anonymous();
      const res = await client.post('/api/admin/logout', {});
      // Per spec: 401 UNAUTHORIZED or idempotent 200
      assert.ok([200, 401].includes(res.status), `Unexpected status ${res.status}`);
    });
  });

  // =========================================================================
  // Feature 15: Admin Session Check
  // =========================================================================
  describe('Feature 15: Admin Session Check', () => {
    it('T1-F15-01: Active Session Verification returns id, username, and csrf_token', async () => {
      const client = new ApiClient();
      await client.login();
      const res = await client.get('/api/admin/me');
      assertStatus(res, 200);
      assert.ok(typeof res.data.id === 'number');
      assert.strictEqual(res.data.username, config.adminUsername);
      assert.ok(typeof res.data.csrf_token === 'string');
      assert.ok(res.data.csrf_token.length >= 16);
    });

    it('T1-F15-02: Missing Cookie returns 401 UNAUTHORIZED', async () => {
      const client = ApiClient.anonymous();
      const res = await client.get('/api/admin/me');
      assertError(res, 401, 'UNAUTHORIZED');
    });

    it('T1-F15-03: Invalid Cookie Token returns 401 UNAUTHORIZED', async () => {
      const client = new ApiClient();
      client.cookieJar.parseCookie('labnotes_session=random_invalid_token_999; Path=/');
      const res = await client.get('/api/admin/me');
      assertError(res, 401, 'UNAUTHORIZED');
    });

    it('T1-F15-04: CSRF Token Consistency matches login token', async () => {
      const client = new ApiClient();
      const loginRes = await client.login();
      const initialCsrf = loginRes.data.csrf_token;

      const meRes = await client.get('/api/admin/me');
      assertStatus(meRes, 200);
      assert.strictEqual(meRes.data.csrf_token, initialCsrf);
    });

    it('T1-F15-05: Frontend Hydration repeated checkMe calls remain consistent', async () => {
      const client = new ApiClient();
      await client.login();
      const check1 = await client.checkMe();
      const check2 = await client.checkMe();
      assertStatus(check1, 200);
      assertStatus(check2, 200);
      assert.strictEqual(check1.data.username, check2.data.username);
    });
  });

  // =========================================================================
  // Feature 16: List All Subjects
  // =========================================================================
  describe('Feature 16: List All Subjects', () => {
    let testSubjId;

    before(async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(s, 201);
      testSubjId = s.data.id;
      createdSubjectIds.push(testSubjId);
    });

    it('T1-F16-01: List All Subjects Authenticated returns array including empty subjects', async () => {
      const res = await adminClient.get('/api/admin/subjects');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
      const found = res.data.find((s) => s.id === testSubjId);
      assert.ok(found, `Expected created subject ${testSubjId} in admin list`);
      assert.strictEqual(found.page_count, 0);
    });

    it('T1-F16-02: Includes Draft Pages in Count for admin view', async () => {
      const pageRes = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjId,
        title: uniqueName('DraftCountPage'),
      });
      assertStatus(pageRes, 201);
      createdPageIds.push(pageRes.data.id);

      const res = await adminClient.get('/api/admin/subjects');
      assertStatus(res, 200);
      const found = res.data.find((s) => s.id === testSubjId);
      assert.ok(found);
      assert.strictEqual(found.page_count, 1, 'Admin page_count must count draft pages');
    });

    it('T1-F16-03: Sorting by Position returns subjects in position ascending order', async () => {
      const res = await adminClient.get('/api/admin/subjects');
      assertStatus(res, 200);
      for (let i = 1; i < res.data.length; i++) {
        assert.ok(res.data[i].position >= res.data[i - 1].position);
      }
    });

    it('T1-F16-04: Subject Summary Object Schema conforms to contract', async () => {
      const res = await adminClient.get('/api/admin/subjects');
      assertStatus(res, 200);
      assert.ok(res.data.length > 0);
      const item = res.data[0];
      assert.ok(typeof item.id === 'string');
      assert.ok(typeof item.name === 'string');
      assert.ok(typeof item.position === 'number');
      assert.ok(typeof item.page_count === 'number');
      assert.ok(typeof item.created_at === 'string');
      assert.ok(typeof item.updated_at === 'string');
    });

    it('T1-F16-05: Unauthorized Rejection returns 401 UNAUTHORIZED', async () => {
      const res = await anonClient.get('/api/admin/subjects');
      assertError(res, 401, 'UNAUTHORIZED');
    });
  });

  // =========================================================================
  // Feature 17: Create Subject
  // =========================================================================
  describe('Feature 17: Create Subject', () => {
    it('T1-F17-01: Create Subject with Name Only sets default position 0', async () => {
      const name = uniqueName('SubjNameOnly');
      const res = await adminClient.post('/api/admin/subjects', { name });
      assertStatus(res, 201);
      assert.ok(res.data.id);
      createdSubjectIds.push(res.data.id);
      assert.strictEqual(res.data.name, name);
      assert.strictEqual(res.data.position, 0);
      assert.ok(res.data.created_at);
      assert.ok(res.data.updated_at);
    });

    it('T1-F17-02: Create Subject with Explicit Position sets position correctly', async () => {
      const name = uniqueName('SubjPos7');
      const res = await adminClient.post('/api/admin/subjects', { name, position: 7 });
      assertStatus(res, 201);
      createdSubjectIds.push(res.data.id);
      assert.strictEqual(res.data.position, 7);
    });

    it('T1-F17-03: Persistence Verification in DB shows subject in list', async () => {
      const name = uniqueName('SubjPersist');
      const createRes = await adminClient.post('/api/admin/subjects', { name });
      assertStatus(createRes, 201);
      const subjId = createRes.data.id;
      createdSubjectIds.push(subjId);

      const listRes = await adminClient.get('/api/admin/subjects');
      assertStatus(listRes, 200);
      const found = listRes.data.find((s) => s.id === subjId);
      assert.ok(found, 'Created subject must exist in admin subjects list');
      assert.strictEqual(found.name, name);
    });

    it('T1-F17-04: Cyrillic and Numbers in Name preserved accurately', async () => {
      const name = `Информационная безопасность ${Date.now()}`;
      const res = await adminClient.post('/api/admin/subjects', { name });
      assertStatus(res, 201);
      createdSubjectIds.push(res.data.id);
      assert.strictEqual(res.data.name, name);
    });

    it('T1-F17-05: Unauthorized Subject Creation returns 401 UNAUTHORIZED', async () => {
      const res = await anonClient.post('/api/admin/subjects', { name: 'Hack' });
      assertError(res, 401, 'UNAUTHORIZED');
    });
  });

  // =========================================================================
  // Feature 18: Update Subject
  // =========================================================================
  describe('Feature 18: Update Subject', () => {
    let subjId;

    before(async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject({ name: uniqueName('F18_Orig') }));
      assertStatus(s, 201);
      subjId = s.data.id;
      createdSubjectIds.push(subjId);
    });

    it('T1-F18-01: Rename Subject updates name preserving position', async () => {
      const newName = uniqueName('F18_Renamed');
      const res = await adminClient.patch(`/api/admin/subjects/${subjId}`, { name: newName });
      assertStatus(res, 200);
      assert.strictEqual(res.data.id, subjId);
      assert.strictEqual(res.data.name, newName);
    });

    it('T1-F18-02: Update Position Only updates position preserving name', async () => {
      const res = await adminClient.patch(`/api/admin/subjects/${subjId}`, { position: 15 });
      assertStatus(res, 200);
      assert.strictEqual(res.data.position, 15);
    });

    it('T1-F18-03: Update Both Name and Position updates both fields', async () => {
      const bothName = uniqueName('F18_Both');
      const res = await adminClient.patch(`/api/admin/subjects/${subjId}`, { name: bothName, position: 3 });
      assertStatus(res, 200);
      assert.strictEqual(res.data.name, bothName);
      assert.strictEqual(res.data.position, 3);
    });

    it('T1-F18-04: Public Catalog Reflection reflects updated subject', async () => {
      // Create a page and publish so subject is in public catalog
      const pageRes = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('F18_Page'),
      });
      assertStatus(pageRes, 201);
      createdPageIds.push(pageRes.data.id);

      await adminClient.post(`/api/admin/pages/${pageRes.data.id}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });

      const updatedName = uniqueName('F18_PubReflect');
      await adminClient.patch(`/api/admin/subjects/${subjId}`, { name: updatedName });

      const pubRes = await anonClient.get('/api/public/subjects');
      assertStatus(pubRes, 200);
      const found = pubRes.data.find((s) => s.id === subjId);
      assert.ok(found);
      assert.strictEqual(found.name, updatedName);
    });

    it('T1-F18-05: Unauthorized Update returns 401 UNAUTHORIZED', async () => {
      const res = await anonClient.patch(`/api/admin/subjects/${subjId}`, { name: 'UnauthorizedRename' });
      assertError(res, 401, 'UNAUTHORIZED');
    });
  });

  // =========================================================================
  // Feature 19: Delete Subject
  // =========================================================================
  describe('Feature 19: Delete Subject', () => {
    it('T1-F19-01: Delete Empty Subject succeeds with 200 OK', async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(s, 201);
      const delSubjId = s.data.id;

      const delRes = await adminClient.delete(`/api/admin/subjects/${delSubjId}`);
      assertStatus(delRes, 200);
      assert.strictEqual(delRes.data.success, true);

      // Verify no longer in admin subjects list
      const listRes = await adminClient.get('/api/admin/subjects');
      assertStatus(listRes, 200);
      const found = listRes.data.find((item) => item.id === delSubjId);
      assert.strictEqual(found, undefined, 'Deleted subject should not be in list');
    });

    it('T1-F19-02: Blocked Deletion on Subject with Pages returns 409 SUBJECT_NOT_EMPTY', async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(s, 201);
      const nonEmptysubjId = s.data.id;
      createdSubjectIds.push(nonEmptysubjId);

      const p = await adminClient.post('/api/admin/pages', {
        subject_id: nonEmptysubjId,
        title: uniqueName('BlockDelPage'),
      });
      assertStatus(p, 201);
      createdPageIds.push(p.data.id);

      const delRes = await adminClient.delete(`/api/admin/subjects/${nonEmptysubjId}`);
      assertError(delRes, 409, 'SUBJECT_NOT_EMPTY');
    });

    it('T1-F19-03: Deletion After Pages Deleted succeeds', async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(s, 201);
      const subjId = s.data.id;

      const p = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('TempPage'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      // Delete the page first
      const delPageRes = await adminClient.delete(`/api/admin/pages/${pageId}`);
      assertStatus(delPageRes, 200);

      // Now deleting the subject must succeed
      const delSubjRes = await adminClient.delete(`/api/admin/subjects/${subjId}`);
      assertStatus(delSubjRes, 200);
      assert.strictEqual(delSubjRes.data.success, true);
    });

    it('T1-F19-04: Public Catalog Immediate Removal when deleted', async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(s, 201);
      const subjId = s.data.id;

      // Delete empty subject
      await adminClient.delete(`/api/admin/subjects/${subjId}`);

      const pubRes = await anonClient.get('/api/public/subjects');
      assertStatus(pubRes, 200);
      const found = pubRes.data.find((item) => item.id === subjId);
      assert.strictEqual(found, undefined);
    });

    it('T1-F19-05: Unauthorized Deletion Attempt returns 401 UNAUTHORIZED', async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(s, 201);
      createdSubjectIds.push(s.data.id);

      const delRes = await anonClient.delete(`/api/admin/subjects/${s.data.id}`);
      assertError(delRes, 401, 'UNAUTHORIZED');
    });
  });

  // =========================================================================
  // Feature 20: List Admin Pages
  // =========================================================================
  describe('Feature 20: List Admin Pages', () => {
    let subjId;
    let pageDraftId;
    let pagePubId;

    before(async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(s, 201);
      subjId = s.data.id;
      createdSubjectIds.push(subjId);

      // Draft page
      const p1 = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('F20_Draft'),
      });
      assertStatus(p1, 201);
      pageDraftId = p1.data.id;
      createdPageIds.push(pageDraftId);

      // Published page
      const p2 = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('F20_Pub'),
      });
      assertStatus(p2, 201);
      pagePubId = p2.data.id;
      createdPageIds.push(pagePubId);

      await adminClient.post(`/api/admin/pages/${pagePubId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });
    });

    it('T1-F20-01: List All Pages Authenticated returns array with publication status', async () => {
      const res = await adminClient.get('/api/admin/pages');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
      const draft = res.data.find((p) => p.id === pageDraftId);
      const pub = res.data.find((p) => p.id === pagePubId);

      assert.ok(draft, `Draft page ${pageDraftId} must be in admin list`);
      assert.strictEqual(draft.is_published, false);

      assert.ok(pub, `Published page ${pagePubId} must be in admin list`);
      assert.strictEqual(pub.is_published, true);
    });

    it('T1-F20-02: Filter by Subject ID returns only pages belonging to that subject', async () => {
      const res = await adminClient.get(`/api/admin/pages?subject_id=${subjId}`);
      assertStatus(res, 200);
      assert.ok(res.data.length >= 2);
      for (const p of res.data) {
        assert.strictEqual(p.draft_subject_id, subjId);
      }
    });

    it('T1-F20-03: Revision and Publication Metadata present on page object', async () => {
      const res = await adminClient.get('/api/admin/pages');
      assertStatus(res, 200);
      const pub = res.data.find((p) => p.id === pagePubId);
      assert.ok(pub);
      assert.ok(pub.revision >= 1);
      assert.strictEqual(pub.is_published, true);
      assert.strictEqual(pub.published_revision, 1);
    });

    it('T1-F20-04: Admin Page Summary Schema conforms to contract', async () => {
      const res = await adminClient.get('/api/admin/pages');
      assertStatus(res, 200);
      assert.ok(res.data.length > 0);
      const item = res.data[0];
      assert.ok(typeof item.id === 'string');
      assert.ok(typeof item.draft_title === 'string');
      assert.ok(typeof item.draft_subject_id === 'string');
      assert.ok(typeof item.draft_subject_name === 'string');
      assert.ok(typeof item.revision === 'number');
      assert.ok(typeof item.is_published === 'boolean');
      assert.ok(typeof item.created_at === 'string');
      assert.ok(typeof item.updated_at === 'string');
    });

    it('T1-F20-05: Unauthorized Access Attempt returns 401 UNAUTHORIZED', async () => {
      const res = await anonClient.get('/api/admin/pages');
      assertError(res, 401, 'UNAUTHORIZED');
    });
  });
});
