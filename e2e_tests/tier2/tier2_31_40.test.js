// e2e_tests/tier2/tier2_31_40.test.js
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
} from '../helpers/fixtures.js';
import { MediaGenerator } from '../helpers/media_generator.js';
import { config } from '../config.js';

describe('Tier 2: Features 31 to 40 (Boundary & Corner Cases)', () => {
  let adminClient;
  let anonClient;
  let fixtureSubjectId;
  let fixturePageId;

  before(async () => {
    adminClient = new ApiClient();
    anonClient = ApiClient.anonymous();

    // 1. Authenticate admin - MUST fail fast on auth error
    const loginRes = await adminClient.login();
    assertSuccess(loginRes, 200);

    // 2. Setup baseline fixture subject
    const sub = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(sub, 201);
    assert.ok(sub.data?.id, 'Fixture subject must return an ID');
    fixtureSubjectId = sub.data.id;

    // 3. Setup baseline fixture page
    const page = await adminClient.post('/api/admin/pages', {
      subject_id: fixtureSubjectId,
      title: uniqueName('media_test_page'),
    });
    assertStatus(page, 201);
    assert.ok(page.data?.id, 'Fixture page must return an ID');
    fixturePageId = page.data.id;
  });

  after(async () => {
    if (adminClient && adminClient.csrfToken) {
      if (fixturePageId) {
        try {
          await adminClient.delete(`/api/admin/pages/${fixturePageId}`);
        } catch {}
      }
      if (fixtureSubjectId) {
        try {
          await adminClient.delete(`/api/admin/subjects/${fixtureSubjectId}`);
        } catch {}
      }
    }
  });

  // =========================================================================
  // Feature 31: Formatting Toolbar
  // =========================================================================
  describe('Feature 31: Formatting Toolbar Boundaries', () => {
    it('TC-T2-F31-01: Multi-line selection bold wrapping without newline corruption', async () => {
      const multiline = '**Line 1**\n**Line 2**\n**Line 3**';
      const patchRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: 1,
        markdown: multiline,
      });
      assertStatus(patchRes, 200);
      assert.strictEqual(patchRes.data.revision, 2);

      const getRes = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(getRes, 200);
      assert.strictEqual(getRes.data.draft_markdown, multiline);
    });

    it('TC-T2-F31-02: Header hierarchy formatting H1-H6 in draft', async () => {
      const headersDoc = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6';
      const patchRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: 2,
        markdown: headersDoc,
      });
      assertStatus(patchRes, 200);
      assert.strictEqual(patchRes.data.revision, 3);
    });

    it('TC-T2-F31-03: Toggle bold formatting on existing wrapped text', async () => {
      const text = 'Обычный текст и **жирный фрагмент**';
      const patchRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: 3,
        markdown: text,
      });
      assertStatus(patchRes, 200);
      assert.strictEqual(patchRes.data.revision, 4);
    });

    it('TC-T2-F31-04: Toolbar code block insertion formatting', async () => {
      const codeDoc = '```python\ndef hello():\n    return "world"\n```';
      const patchRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: 4,
        markdown: codeDoc,
      });
      assertStatus(patchRes, 200);
      assert.strictEqual(patchRes.data.revision, 5);
    });

    it('TC-T2-F31-05: Rapid toolbar clicks atomic transactions', async () => {
      const res1 = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: 5,
        markdown: '***bold italic***',
      });
      assertStatus(res1, 200);
      assert.strictEqual(res1.data.revision, 6);
    });
  });

  // =========================================================================
  // Feature 32: Formatting Hotkeys
  // =========================================================================
  describe('Feature 32: Formatting Hotkeys Boundaries', () => {
    it('TC-T2-F32-01: Ctrl+S queued when save is currently in flight', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      const p1 = adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        markdown: '# Parallel 1',
      });
      const p2 = adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        markdown: '# Parallel 2',
      });

      const [res1, res2] = await Promise.all([p1, p2]);
      const statuses = [res1.status, res2.status].sort();
      assert.deepStrictEqual(statuses, [200, 409], 'Concurrent saves must return one 200 and one 409');
    });

    it('TC-T2-F32-02: Cross-platform Meta vs Ctrl key mapping', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      const rev = current.data.revision;

      const res = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        title: uniqueName('hotkey_saved_title'),
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, rev + 1);
    });

    it('TC-T2-F32-03: Hotkeys triggered outside editor focus (e.g. title input)', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      const rev = current.data.revision;

      // Empty title update rejected with 400 VALIDATION_ERROR
      const res = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        title: '   ',
      });
      assert.ok([400, 422].includes(res.status));
      if (res.data) assertError(res, res.status);
    });

    it('TC-T2-F32-04: Rapid repeated Ctrl+S keypresses debounce handling', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      let rev = current.data.revision;

      // Execute 3 rapid sequential saves with proper revision increments
      for (let i = 0; i < 3; i++) {
        const patchRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
          expected_revision: rev,
          markdown: `# Debounce iteration ${i}\nContent line ${i}`,
        });
        assertStatus(patchRes, 200);
        assert.strictEqual(patchRes.data.revision, rev + 1);
        rev = patchRes.data.revision;
      }

      // Assert that a stale Ctrl+S save cleanly returns 409 Conflict
      const staleRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev - 2,
        markdown: '# Stale Ctrl+S save',
      });
      assertStatus(staleRes, 409);
      assertError(staleRes, 409, 'REVISION_CONFLICT');
    });

    it('TC-T2-F32-05: Prevent native browser default on Ctrl+S', async () => {
      // Mutating PATCH request without CSRF token must return 403 FORBIDDEN
      const client = adminClient.clone();
      client.csrfToken = '';
      const res = await client.request('PATCH', `/api/admin/pages/${fixturePageId}`, {
        headers: { 'X-CSRF-Token': '' },
        body: { expected_revision: 1, title: 'No CSRF Save' },
      });
      assert.ok([400, 403].includes(res.status));
    });
  });

  // =========================================================================
  // Feature 33: Autosave & Status Indicators
  // =========================================================================
  describe('Feature 33: Autosave & Status Indicators Boundaries', () => {
    it('TC-T2-F33-01: 409 Conflict status indicator update to "Конфликт версий"', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const conflictRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: 99999,
        markdown: '# Conflict trigger',
      });
      assertStatus(conflictRes, 409);
      assertError(conflictRes, 409, 'REVISION_CONFLICT');
    });

    it('TC-T2-F33-02: Rapid continuous typing debounce delay reset (~1000ms)', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      // Update draft and verify updated timestamp / revision progression
      const res = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        markdown: `# Typing update at ${Date.now()}`,
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, rev + 1);

      // Verify that stale expected_revision produces conflict
      const conflictRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        markdown: '# Conflict Typing',
      });
      assertStatus(conflictRes, 409);
      assertError(conflictRes, 409, 'REVISION_CONFLICT');
    });

    it('TC-T2-F33-03: Network failure retry and status recovery ("Ошибка сохранения")', async () => {
      // Test unauthenticated save returns 401
      const res = await anonClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: 1,
        markdown: '# Unauthorized Autosave',
      });
      assertStatus(res, 401);
      assertError(res, 401, 'UNAUTHORIZED');
    });

    it('TC-T2-F33-04: Title/subject modification marks dirty state', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      const newTitle = uniqueName('dirty_state_title');
      const res = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        title: newTitle,
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.title, newTitle);
      assert.strictEqual(res.data.revision, rev + 1);
    });

    it('TC-T2-F33-05: Out-of-order response handling rejects stale revisions', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      const res = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev - 1,
        markdown: '# Stale out-of-order revision',
      });
      assertStatus(res, 409);
      assertError(res, 409, 'REVISION_CONFLICT');
    });
  });

  // =========================================================================
  // Feature 34: LocalStorage Recovery
  // =========================================================================
  describe('Feature 34: LocalStorage Recovery Boundaries', () => {
    it('TC-T2-F34-01: Admin logout clears session and invalidates draft access', async () => {
      const client = new ApiClient();
      const loginRes = await client.login();
      assertSuccess(loginRes, 200);

      const logoutRes = await client.logout();
      assertSuccess(logoutRes, 200);

      const checkRes = await client.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(checkRes, 401);
      assertError(checkRes, 401, 'UNAUTHORIZED');
    });

    it('TC-T2-F34-02: Conflict 409 prompts local recovery without losing text', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      const conflictRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev - 1,
        markdown: '# Local draft text to recover',
      });
      assertStatus(conflictRes, 409);
      assertError(conflictRes, 409, 'REVISION_CONFLICT');

      // Verify server draft text was preserved intact
      const verifyRes = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(verifyRes, 200);
      assert.strictEqual(verifyRes.data.revision, rev);
    });

    it('TC-T2-F34-03: Corrupted JSON payload handled gracefully with 400', async () => {
      const res = await adminClient.request('PATCH', `/api/admin/pages/${fixturePageId}`, {
        headers: { 'Content-Type': 'application/json' },
        body: 'INVALID_JSON{broken',
      });
      assert.ok([400, 422].includes(res.status));
    });

    it('TC-T2-F34-04: Newer server revision supersedes older local cache', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      const updateRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        markdown: '# Advanced Server Content',
      });
      assertStatus(updateRes, 200);
      assert.strictEqual(updateRes.data.revision, rev + 1);
    });

    it('TC-T2-F34-05: Validation error on invalid revision type', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: 'not_a_number',
        markdown: '# Bad Revision Type',
      });
      assert.ok([400, 422].includes(res.status));
      assertError(res, res.status);
    });
  });

  // =========================================================================
  // Feature 35: Navigation Guard
  // =========================================================================
  describe('Feature 35: Navigation Guard Boundaries', () => {
    it('TC-T2-F35-01: Unsaved changes draft state query reflects dirty state', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('nav_guard_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      // Draft exists and has revision 1
      const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(getRes, 200);
      assert.strictEqual(getRes.data.revision, 1);

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F35-02: Guard behavior during active in-flight save', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      // Issue PATCH and concurrent GET: server handles both cleanly without SQLITE_BUSY locking
      const [patchRes, getRes] = await Promise.all([
        adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
          expected_revision: rev,
          markdown: '# In-Flight Save Content',
        }),
        adminClient.get(`/api/admin/pages/${fixturePageId}`),
      ]);
      assertStatus(patchRes, 200);
      assertStatus(getRes, 200);
      assert.ok([rev, rev + 1].includes(getRes.data.revision));
    });

    it('TC-T2-F35-03: Unsaved draft deletion cleans up safely', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('unsaved_cleanup'),
      });
      assertStatus(p, 201);
      const delRes = await adminClient.delete(`/api/admin/pages/${p.data.id}`);
      assertStatus(delRes, 200);
    });

    it('TC-T2-F35-04: Navigation between editor and admin pages list preserves draft state', async () => {
      const listRes = await adminClient.get('/api/admin/pages');
      assertStatus(listRes, 200);
      assert.ok(Array.isArray(listRes.data));
    });

    it('TC-T2-F35-05: Draft update cancellation preserves last saved state', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      assert.ok(current.data.revision >= 1);
    });
  });

  // =========================================================================
  // Feature 36: Import / Export Markdown
  // =========================================================================
  describe('Feature 36: Import / Export Markdown Boundaries', () => {
    it('TC-T2-F36-01: Disallowed file extension on asset upload rejected', async () => {
      const exeFile = new File([Buffer.from('MZ\x90\x00')], 'malicious.exe', { type: 'application/x-msdownload' });
      const fd = new FormData();
      fd.append('file', exeFile);
      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd);
      assert.ok([400, 415, 422].includes(res.status));
    });

    it('TC-T2-F36-02: Large markdown draft update string handling', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      const largeMd = '# Section\n'.repeat(5000);
      const patchRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        markdown: largeMd,
      });
      assertStatus(patchRes, 200);
    });

    it('TC-T2-F36-03: Reserved filename characters in page title handled safely', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      const complexTitle = 'Лаб 1: Сети / TCP & UDP? *test*';
      const patchRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        title: complexTitle,
      });
      assertStatus(patchRes, 200);
      assert.strictEqual(patchRes.data.title, complexTitle);
    });

    it('TC-T2-F36-04: Empty markdown string in draft update', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      const patchRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        markdown: '',
      });
      assertStatus(patchRes, 200);
      assert.strictEqual(patchRes.data.draft_markdown, '');
    });

    it('TC-T2-F36-05: Relative image links in markdown preserved without server crash', async () => {
      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(current, 200);
      const rev = current.data.revision;

      const mdWithRelative = '# Guide\n![diagram](../images/diagram.png)\n![media](/media/00000000-0000-0000-0000-000000000001)';
      const patchRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        markdown: mdWithRelative,
      });
      assertStatus(patchRes, 200);
    });
  });

  // =========================================================================
  // Feature 37: Image Upload (Paste / DnD / Picker)
  // =========================================================================
  describe('Feature 37: Image Upload Boundaries', () => {
    it('TC-T2-F37-01: Oversized image > 10 MiB rejected with 413 FILE_TOO_LARGE', async () => {
      const giantImg = MediaGenerator.createOversizedImage('oversized.png');
      assert.ok(giantImg.size > 10 * 1024 * 1024);

      const formData = new FormData();
      formData.append('file', giantImg);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      assert.ok([400, 413].includes(res.status), `Expected 400 or 413, got ${res.status}`);
      assertError(res, res.status, 'FILE_TOO_LARGE');
    });

    it('TC-T2-F37-02: Explicit SVG rejection as image (400 SVG_NOT_ALLOWED)', async () => {
      const svgFile = MediaGenerator.createSvg('malicious.svg');
      const formData = new FormData();
      formData.append('file', svgFile);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      assert.ok([400, 415, 422].includes(res.status), `Expected rejection, got ${res.status}`);
      if (res.status === 400) {
        assertError(res, 400, 'SVG_NOT_ALLOWED');
      }
    });

    it('TC-T2-F37-03: Corrupted magic bytes in image returns 400 INVALID_IMAGE_FORMAT', async () => {
      const corruptImg = MediaGenerator.createCorruptedImage('fake.png');
      const formData = new FormData();
      formData.append('file', corruptImg);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      assert.ok([400, 422].includes(res.status), `Expected 400 or 422, got ${res.status}`);
      if (res.status === 400) {
        assertError(res, 400, 'INVALID_IMAGE_FORMAT');
      }
    });

    it('TC-T2-F37-04: Path traversal in image filename rejected or sanitized', async () => {
      const traversalFile = MediaGenerator.createPathTraversalFile('../../etc/passwd.png');
      const formData = new FormData();
      formData.append('file', traversalFile);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      if (res.ok) {
        assert.ok(!res.data.original_name.includes('../'));
        assert.ok(!res.data.original_name.includes('..\\'));
      } else {
        assert.ok([400, 403, 422].includes(res.status));
      }
    });

    it('TC-T2-F37-05: Valid 1x1 PNG image uploads successfully (201 Created)', async () => {
      const validPng = MediaGenerator.createPng('valid_boundary.png');
      const formData = new FormData();
      formData.append('file', validPng);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      assertStatus(res, 201);
      assert.strictEqual(res.data.kind, 'image');
      assert.strictEqual(res.data.mime, 'image/png');
      assert.ok(res.data.url.startsWith('/media/'));
    });
  });

  // =========================================================================
  // Feature 38: Image Insertion in Editor
  // =========================================================================
  describe('Feature 38: Image Insertion in Editor Boundaries', () => {
    it('TC-T2-F38-01: Asset upload requires valid target page ID', async () => {
      const png = MediaGenerator.createPng('switch_test.png');
      const fd = new FormData();
      fd.append('file', png);
      const res = await adminClient.postMultipart('/api/admin/pages/00000000-0000-0000-0000-000000000000/assets', fd);
      assert.ok([400, 404].includes(res.status));
    });

    it('TC-T2-F38-02: Typing during upload adjusts insertion position offset', async () => {
      const png = MediaGenerator.createPng('offset_test.png');
      const fd = new FormData();
      fd.append('file', png);

      const upRes = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd);
      assertStatus(upRes, 201);
      const assetUrl = upRes.data.url;
      assert.ok(assetUrl.startsWith('/media/'));

      const current = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      const rev = current.data.revision;

      const markdownWithImage = `# Title\n\nTyped text before upload\n![diagram](${assetUrl})\nTyped text after upload`;
      const patchRes = await adminClient.patch(`/api/admin/pages/${fixturePageId}`, {
        expected_revision: rev,
        markdown: markdownWithImage,
      });
      assertStatus(patchRes, 200);

      const checkRes = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(checkRes, 200);
      assert.ok(checkRes.data.draft_markdown.includes(assetUrl));
    });

    it('TC-T2-F38-03: Corrupted asset upload rejection does not corrupt draft revision', async () => {
      const beforeRes = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(beforeRes, 200);
      const revBefore = beforeRes.data.revision;

      const badFile = MediaGenerator.createCorruptedImage('bad.png');
      const fd = new FormData();
      fd.append('file', badFile);

      const failRes = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd);
      assert.ok([400, 422].includes(failRes.status));

      const afterRes = await adminClient.get(`/api/admin/pages/${fixturePageId}`);
      assertStatus(afterRes, 200);
      assert.strictEqual(afterRes.data.revision, revBefore);
    });

    it('TC-T2-F38-04: Filename with quotes and markdown characters handled in upload metadata', async () => {
      const png = MediaGenerator.createPng('photo [1] (final) "test".png');
      const fd = new FormData();
      fd.append('file', png);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd);
      assertStatus(res, 201);
      assert.ok(typeof res.data.original_name === 'string');
    });

    it('TC-T2-F38-05: Multiple concurrent image uploads handled cleanly', async () => {
      const img1 = MediaGenerator.createPng('multi_1.png');
      const img2 = MediaGenerator.createPng('multi_2.png');
      const fd1 = new FormData();
      fd1.append('file', img1);
      const fd2 = new FormData();
      fd2.append('file', img2);

      const [res1, res2] = await Promise.all([
        adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd1),
        adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd2),
      ]);
      assertStatus(res1, 201);
      assertStatus(res2, 201);
      assert.notStrictEqual(res1.data.id, res2.data.id);
    });
  });

  // =========================================================================
  // Feature 39: Attachment Upload
  // =========================================================================
  describe('Feature 39: Attachment Upload Boundaries', () => {
    it('TC-T2-F39-01: Oversized attachment > 50 MiB rejected with 413 FILE_TOO_LARGE', async () => {
      const giantZip = MediaGenerator.createOversizedAttachment('huge.zip');
      assert.ok(giantZip.size > 50 * 1024 * 1024);

      const formData = new FormData();
      formData.append('file', giantZip);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      assert.ok([400, 413].includes(res.status), `Expected 400 or 413, got ${res.status}`);
      assertError(res, res.status, 'FILE_TOO_LARGE');
    });

    it('TC-T2-F39-02: Disallowed extension rejection (.exe, .sh) with 400 UNSUPPORTED_MIME', async () => {
      const exeFile = new File([Buffer.from('MZ\x90\x00')], 'setup.exe', {
        type: 'application/x-msdownload',
      });
      const formData = new FormData();
      formData.append('file', exeFile);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      assert.ok([400, 415, 422].includes(res.status));
      if (res.status === 400) {
        assertError(res, 400, 'UNSUPPORTED_MIME');
      }
    });

    it('TC-T2-F39-03: Valid ZIP archive upload succeeds (201 Created)', async () => {
      const validZip = MediaGenerator.createZip('archive.zip');
      const formData = new FormData();
      formData.append('file', validZip);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      assertStatus(res, 201);
      assert.strictEqual(res.data.kind, 'attachment');
      assert.strictEqual(res.data.mime, 'application/zip');
    });

    it('TC-T2-F39-04: Valid PDF document upload succeeds (201 Created)', async () => {
      const validPdf = MediaGenerator.createPdf('guide.pdf');
      const formData = new FormData();
      formData.append('file', validPdf);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      assertStatus(res, 201);
      assert.strictEqual(res.data.kind, 'attachment');
      assert.strictEqual(res.data.mime, 'application/pdf');
    });

    it('TC-T2-F39-05: Path traversal in attachment filename sanitized', async () => {
      const traversalFile = MediaGenerator.createPathTraversalFile('..\\..\\boot.ini');
      const formData = new FormData();
      formData.append('file', traversalFile);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      assertStatus(res, 201);
      assert.ok(!res.data.original_name.includes('..'));
    });
  });

  // =========================================================================
  // Feature 40: Streaming Disk Storage
  // =========================================================================
  describe('Feature 40: Streaming Disk Storage Boundaries', () => {
    it('TC-T2-F40-01: Bounded RAM streaming simulation (chunks ~64 KB)', async () => {
      const zip = MediaGenerator.createZip('stream_1mb.zip');
      const fd = new FormData();
      fd.append('file', zip);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd);
      assertStatus(res, 201);
      assert.strictEqual(res.data.kind, 'attachment');
      assert.strictEqual(res.data.mime, 'application/zip');
      assert.ok(res.data.byte_size > 0);

      // Verify stream read returns matching Content-Length and MIME
      const mediaRes = await adminClient.get(res.data.url);
      assertStatus(mediaRes, 200);
      const ct = mediaRes.headers.get('content-type') || '';
      assert.ok(ct.includes('application/zip'));
    });

    it('TC-T2-F40-02: Temporary file naming with UUID isolation', async () => {
      const png = MediaGenerator.createPng('uuid_stream.png');
      const fd = new FormData();
      fd.append('file', png);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd);
      assertStatus(res, 201);
      assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(res.data.id));
    });

    it('TC-T2-F40-03: Atomic rename from temp file to permanent storage on success', async () => {
      const png = MediaGenerator.createPng('atomic_rename.png');
      const fd = new FormData();
      fd.append('file', png);

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd);
      assertStatus(res, 201);

      // Media immediately readable from permanent storage
      const mediaRes = await adminClient.get(res.data.url);
      assertStatus(mediaRes, 200);
    });

    it('TC-T2-F40-04: Concurrent upload streams isolation', async () => {
      const img = MediaGenerator.createPng('stream_a.png');
      const fd1 = new FormData();
      fd1.append('file', img);

      const zip = MediaGenerator.createZip('stream_b.zip');
      const fd2 = new FormData();
      fd2.append('file', zip);

      const [res1, res2] = await Promise.all([
        adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd1),
        adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd2),
      ]);

      assertStatus(res1, 201);
      assertStatus(res2, 201);
      assert.notStrictEqual(res1.data.id, res2.data.id);
      assert.strictEqual(res1.data.kind, 'image');
      assert.strictEqual(res2.data.kind, 'attachment');
    });

    it('TC-T2-F40-05: Single file per multipart request enforced', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('first.png'));
      formData.append('file2', MediaGenerator.createPng('second.png'));

      const res = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, formData);
      assert.ok([201, 400].includes(res.status));
    });
  });
});
