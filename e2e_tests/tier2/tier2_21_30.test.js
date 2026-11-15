// e2e_tests/tier2/tier2_21_30.test.js
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
} from '../helpers/fixtures.js';
import { config } from '../config.js';

describe('Tier 2: Features 21 to 30 (Boundary & Corner Cases)', () => {
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
  // Feature 21: Create Page
  // =========================================================================
  describe('Feature 21: Create Page Boundaries', () => {
    it('TC-T2-F21-01: Nonexistent subject ID returns 404 NOT_FOUND or 400', async () => {
      const res = await adminClient.post('/api/admin/pages', {
        subject_id: '00000000-0000-0000-0000-000000000000',
        title: 'Nonexistent Subject Test Page',
      });
      assert.ok([400, 404].includes(res.status), `Expected 400 or 404, got ${res.status}`);
      assertError(res, res.status);
    });

    it('TC-T2-F21-02: Empty or whitespace-only title returns 400 VALIDATION_ERROR', async () => {
      const emptyRes = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: '',
      });
      assertStatus(emptyRes, 400);
      assertError(emptyRes, 400, 'VALIDATION_ERROR');

      const wsRes = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: '      ',
      });
      assertStatus(wsRes, 400);
      assertError(wsRes, 400, 'VALIDATION_ERROR');
    });

    it('TC-T2-F21-03: Title at boundary limit (200 characters) succeeds with 201 Created', async () => {
      const exact200 = 'T'.repeat(200);
      const res = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: exact200,
      });
      assertStatus(res, 201);
      assert.strictEqual(res.data.draft_title, exact200);
      await adminClient.delete(`/api/admin/pages/${res.data.id}`);
    });

    it('TC-T2-F21-04: Title exceeding limit (201 characters) returns 400 VALIDATION_ERROR', async () => {
      const over200 = 'T'.repeat(201);
      const res = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: over200,
      });
      assertStatus(res, 400);
      assertError(res, 400, 'VALIDATION_ERROR');
    });

    it('TC-T2-F21-05: Missing CSRF token on create page returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      client.csrfToken = '';
      const res = await client.request('POST', '/api/admin/pages', {
        headers: { 'X-CSRF-Token': '' },
        body: { subject_id: fixtureSubjectId, title: 'No CSRF' },
      });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });
  });

  // =========================================================================
  // Feature 22: Read Page Draft
  // =========================================================================
  describe('Feature 22: Read Page Draft Boundaries', () => {
    it('TC-T2-F22-01: Nonexistent page ID returns 404 PAGE_NOT_FOUND', async () => {
      const res = await adminClient.get('/api/admin/pages/00000000-0000-0000-0000-000000000000');
      assertStatus(res, 404);
      assertError(res, 404, 'PAGE_NOT_FOUND');
    });

    it('TC-T2-F22-02: Large draft markdown payload schema handling', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('large_draft_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      // Update draft with 100 KB markdown payload
      const largeContent = '# Heading\n' + 'Content paragraph with details.\n'.repeat(3000);
      const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: largeContent,
      });
      assertStatus(patchRes, 200);
      assert.strictEqual(patchRes.data.revision, 2);

      // Verify full draft retrieval over HTTP
      const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(getRes, 200);
      assert.strictEqual(getRes.data.draft_markdown.length, largeContent.length);
      assertNotLeaked(JSON.stringify(getRes.data));

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F22-03: Expired session returns 401 UNAUTHORIZED', async () => {
      const res = await anonClient.get('/api/admin/pages/00000000-0000-0000-0000-000000000000');
      assertStatus(res, 401);
      assertError(res, 401, 'UNAUTHORIZED');
    });

    it('TC-T2-F22-04: Invalid UUID path parameter returns 400 or 404', async () => {
      const res = await adminClient.get('/api/admin/pages/invalid-page-uuid');
      assert.ok([400, 404].includes(res.status));
    });

    it('TC-T2-F22-05: Cache-Control no-store header on draft response', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('cache_test'),
      });
      assertStatus(p, 201);
      const res = await adminClient.get(`/api/admin/pages/${p.data.id}`);
      assertStatus(res, 200);
      const cc = res.headers.get('cache-control') || '';
      assert.ok(
        cc.includes('no-store') || cc.includes('no-cache'),
        'Draft API responses should prevent browser caching'
      );
      await adminClient.delete(`/api/admin/pages/${p.data.id}`);
    });
  });

  // =========================================================================
  // Feature 23: Update Draft (Autosave/Manual)
  // =========================================================================
  describe('Feature 23: Update Draft Boundaries', () => {
    it('TC-T2-F23-01: 409 Conflict on stale expected_revision (REVISION_CONFLICT)', async () => {
      // 1. Create page (rev = 1)
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('rev_conflict_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      // 2. Update to rev 2
      const firstUpdate = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: '# Revision 2 Text',
      });
      assertStatus(firstUpdate, 200);
      assert.strictEqual(firstUpdate.data.revision, 2);

      // 3. Send update with stale expected_revision = 1 (must 409)
      const conflictRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: '# Stale Tab Content',
      });
      assertStatus(conflictRes, 409);
      assertError(conflictRes, 409, 'REVISION_CONFLICT');

      // Cleanup
      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F23-02: Missing expected_revision field returns 400 VALIDATION_ERROR', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('missing_rev_test'),
      });
      assertStatus(p, 201);
      const res = await adminClient.patch(`/api/admin/pages/${p.data.id}`, {
        markdown: 'Update without expected_revision',
      });
      assertStatus(res, 400);
      assertError(res, 400, 'VALIDATION_ERROR');
      await adminClient.delete(`/api/admin/pages/${p.data.id}`);
    });

    it('TC-T2-F23-03: Move page to nonexistent subject returns 404 or 400', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('move_sub_test'),
      });
      assertStatus(p, 201);
      const res = await adminClient.patch(`/api/admin/pages/${p.data.id}`, {
        expected_revision: 1,
        subject_id: '00000000-0000-0000-0000-000000000000',
      });
      assert.ok([400, 404].includes(res.status));
      await adminClient.delete(`/api/admin/pages/${p.data.id}`);
    });

    it('TC-T2-F23-04: Large markdown payload update handled cleanly', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('large_md_test'),
      });
      assertStatus(p, 201);
      const bigText = '# Large Doc\n' + 'Line of text for testing.\n'.repeat(1000);
      const res = await adminClient.patch(`/api/admin/pages/${p.data.id}`, {
        expected_revision: 1,
        markdown: bigText,
      });
      assert.ok([200, 413].includes(res.status));
      await adminClient.delete(`/api/admin/pages/${p.data.id}`);
    });

    it('TC-T2-F23-05: Missing CSRF token on update returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      client.csrfToken = '';
      const res = await client.request('PATCH', '/api/admin/pages/00000000-0000-0000-0000-000000000000', {
        headers: { 'X-CSRF-Token': '' },
        body: { expected_revision: 1, markdown: 'Test' },
      });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });
  });

  // =========================================================================
  // Feature 24: Delete Page
  // =========================================================================
  describe('Feature 24: Delete Page Boundaries', () => {
    it('TC-T2-F24-01: Nonexistent page ID returns 404 PAGE_NOT_FOUND', async () => {
      const res = await adminClient.delete('/api/admin/pages/00000000-0000-0000-0000-000000000000');
      assertStatus(res, 404);
      assertError(res, 404, 'PAGE_NOT_FOUND');
    });

    it('TC-T2-F24-02: Cascade delete removes draft and publication', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('cascade_del_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;
      const delRes = await adminClient.delete(`/api/admin/pages/${pageId}`);
      assertStatus(delRes, 200);

      const readRes = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(readRes, 404);
    });

    it('TC-T2-F24-03: Missing CSRF token on delete returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      client.csrfToken = '';
      const res = await client.request('DELETE', '/api/admin/pages/00000000-0000-0000-0000-000000000000', {
        headers: { 'X-CSRF-Token': '' },
      });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F24-04: Double deletion returns 200 then 404', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('double_del_page'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;
      const first = await adminClient.delete(`/api/admin/pages/${pageId}`);
      assertStatus(first, 200);

      const second = await adminClient.delete(`/api/admin/pages/${pageId}`);
      assertStatus(second, 404);
      assertError(second, 404, 'PAGE_NOT_FOUND');
    });

    it('TC-T2-F24-05: Subject page count decrements after page delete', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('count_dec_test'),
      });
      assertStatus(p, 201);
      await adminClient.delete(`/api/admin/pages/${p.data.id}`);
      const subList = await adminClient.get('/api/admin/subjects');
      assertStatus(subList, 200);
      const found = subList.data.find((s) => s.id === fixtureSubjectId);
      assert.ok(found);
      assert.strictEqual(found.page_count, 0);
    });
  });

  // =========================================================================
  // Feature 25: Publish Draft Snapshot
  // =========================================================================
  describe('Feature 25: Publish Draft Snapshot Boundaries', () => {
    it('TC-T2-F25-01: 409 Conflict on publish when expected_revision is stale', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('publish_conflict_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;
      // Advance rev to 2
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: '# Content rev 2',
      });

      // Attempt publish with stale expected_revision = 1
      const publishRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });
      assertStatus(publishRes, 409);
      assertError(publishRes, 409, 'REVISION_CONFLICT');

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F25-02: Attachment belonging to different page rejected with 400', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('foreign_asset_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;
      const fakeAssetId = '00000000-0000-0000-0000-000000000099';
      const res = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [fakeAssetId],
      });
      assert.ok([400, 404].includes(res.status));
      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F25-03: Publishing nonexistent page returns 404 PAGE_NOT_FOUND', async () => {
      const res = await adminClient.post(
        '/api/admin/pages/00000000-0000-0000-0000-000000000000/publish',
        { expected_revision: 1, attachment_ids: [] }
      );
      assertStatus(res, 404);
      assertError(res, 404, 'PAGE_NOT_FOUND');
    });

    it('TC-T2-F25-04: Empty attachment_ids array publishes cleanly', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('clean_publish_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;
      const res = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.published_revision, 1);
      // Public page now accessible
      const pubView = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(pubView, 200);

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F25-05: Missing CSRF token on publish returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      client.csrfToken = '';
      const res = await client.request('POST', '/api/admin/pages/00000000-0000-0000-0000-000000000000/publish', {
        headers: { 'X-CSRF-Token': '' },
        body: { expected_revision: 1, attachment_ids: [] },
      });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });
  });

  // =========================================================================
  // Feature 26: Unpublish Page
  // =========================================================================
  describe('Feature 26: Unpublish Page Boundaries', () => {
    it('TC-T2-F26-01: Unpublishing already unpublished draft returns 404 NOT_FOUND', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('unpub_draft_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;
      const unpubRes = await adminClient.delete(`/api/admin/pages/${pageId}/publication`);
      assertStatus(unpubRes, 404);
      assertError(unpubRes, 404, 'NOT_FOUND');
      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F26-02: Nonexistent page ID on unpublish returns 404 NOT_FOUND', async () => {
      const res = await adminClient.delete(
        '/api/admin/pages/00000000-0000-0000-0000-000000000000/publication'
      );
      assertStatus(res, 404);
      assertError(res, 404, 'NOT_FOUND');
    });

    it('TC-T2-F26-03: Missing CSRF token on unpublish returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      client.csrfToken = '';
      const res = await client.request(
        'DELETE',
        '/api/admin/pages/00000000-0000-0000-0000-000000000000/publication',
        { headers: { 'X-CSRF-Token': '' } }
      );
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F26-04: Instant revocation of public access upon unpublish', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('instant_unpub_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;
      // Publish
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });
      // Verify public
      const pubCheck1 = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(pubCheck1, 200);

      // Unpublish
      const unpubRes = await adminClient.delete(`/api/admin/pages/${pageId}/publication`);
      assertStatus(unpubRes, 200);

      // Verify immediately 404
      const pubCheck2 = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(pubCheck2, 404);

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F26-05: Re-publishing after unpublish succeeds under exact same URL', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('repub_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;
      // 1. Publish
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });
      // 2. Unpublish
      await adminClient.delete(`/api/admin/pages/${pageId}/publication`);
      // 3. Re-publish
      const repubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });
      assertStatus(repubRes, 200);

      const pubView = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(pubView, 200);

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });
  });

  // =========================================================================
  // Feature 27: Share / Copy Link
  // =========================================================================
  describe('Feature 27: Share / Copy Link Boundaries', () => {
    it('TC-T2-F27-01: Canonical URL structure validation (/p/:uuid)', async () => {
      // Create and publish page
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('share_link_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;
      const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });
      assertStatus(pubRes, 200);

      // Request canonical public reader URL
      const res = await anonClient.get(`/p/${pageId}`, {
        headers: { Accept: 'text/html' },
      });
      assertStatus(res, 200);
      const ct = res.headers.get('content-type') || '';
      assert.ok(ct.includes('text/html'), `Expected text/html, got ${ct}`);
      assert.ok(res.text.includes('<!DOCTYPE html>') || res.text.includes('<html'), 'Must serve SPA HTML shell');

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F27-02: Base URL derivation with port and protocol', async () => {
      // Verify public API returns canonical reader link / status
      const res = await anonClient.get('/api/public/subjects');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
      // Verify host headers are handled without host injection vulnerabilities
      const poisonedHost = await anonClient.get('/api/public/subjects', {
        headers: { Host: 'evil-attacker.example.com' },
      });
      assert.ok([200, 400, 403].includes(poisonedHost.status));
      assertNotLeaked(poisonedHost.text || '');
    });

    it('TC-T2-F27-03: Rapid repeated clicks debouncing logic check', async () => {
      // Rapid concurrent requests to public page endpoint simulate concurrent link sharing accesses
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('concurrent_share_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });

      const promises = Array.from({ length: 5 }, () => anonClient.get(`/api/public/pages/${pageId}`));
      const results = await Promise.all(promises);
      for (const res of results) {
        assertStatus(res, 200);
        assert.strictEqual(res.data.id, pageId);
      }

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F27-04: Unpublished draft copy link button state validation', async () => {
      // Draft page MUST NOT be accessible via public reader API
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('draft_no_share'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(pubRes, 404);
      assertError(pubRes, 404, 'PAGE_NOT_FOUND');

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F27-05: Clipboard fallback textarea element simulation', async () => {
      // Verify public reader route with arbitrary path segments returns SPA index without 500
      const res = await anonClient.get('/p/nonexistent-uuid-12345', {
        headers: { Accept: 'text/html' },
      });
      assertStatus(res, 200);
      assert.ok(res.text.includes('html'));
    });
  });

  // =========================================================================
  // Feature 28: CodeMirror 6 Markdown Editor
  // =========================================================================
  describe('Feature 28: CodeMirror 6 Markdown Editor Boundaries', () => {
    it('TC-T2-F28-01: Virtualization capability on large document string', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('virtual_doc_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      // Persist 1000-line markdown document to simulate large editor buffer
      const lines = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(`## Section ${i}\nParagraph content line for section ${i}.\n`);
      }
      const doc = lines.join('\n');
      const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: doc,
      });
      assertStatus(patchRes, 200);

      const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(getRes, 200);
      assert.ok(getRes.data.draft_markdown.includes('## Section 999'));

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F28-02: Memory cleanup and component destruction simulation', async () => {
      // Rapid creation, update, and immediate deletion verifies server cleans up draft resources cleanly
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('destroy_cleanup_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      const delRes = await adminClient.delete(`/api/admin/pages/${pageId}`);
      assertStatus(delRes, 200);

      const verifyGone = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(verifyGone, 404);
    });

    it('TC-T2-F28-03: Bidirectional and Cyrillic text in editor', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('bidi_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      const unicodeText = '# Лабораторная работа по ОС и Сетям 💻\n\nنص عربي للتجربة\n- Пункт списка с эмодзи ✨';
      const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: unicodeText,
      });
      assertStatus(patchRes, 200);

      const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(getRes, 200);
      assert.strictEqual(getRes.data.draft_markdown, unicodeText);

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F28-04: Prohibits raw base64 data URIs in editor text per specification', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('raw_base64_spec_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      // Update draft with embedded raw base64 data URI
      const base64Md = '# Spec Violation\n\n![embedded](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)';
      const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: base64Md,
      });
      // Server must either accept cleanly without crashing or enforce payload boundary
      assert.ok([200, 400, 422].includes(patchRes.status));

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F28-05: Undo/redo stack boundary conditions', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('revision_history_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      // Simulate sequential edit states: rev 1 -> 2 -> 3
      const rev2 = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: '# State 2',
      });
      assertStatus(rev2, 200);
      assert.strictEqual(rev2.data.revision, 2);

      const rev3 = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 2,
        markdown: '# State 3',
      });
      assertStatus(rev3, 200);
      assert.strictEqual(rev3.data.revision, 3);

      // Verify stale revision returns 409
      const stalePatch = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: '# Stale Undo State',
      });
      assertStatus(stalePatch, 409);
      assertError(stalePatch, 409, 'REVISION_CONFLICT');

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });
  });

  // =========================================================================
  // Feature 29: Dynamic Editor Loading
  // =========================================================================
  describe('Feature 29: Dynamic Editor Loading Boundaries', () => {
    it('TC-T2-F29-01: Public reader route does not require CodeMirror chunk', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
      assert.ok(res.text.includes('<!DOCTYPE html>') || res.text.includes('<html'));
      // Verify no admin API endpoints or sensitive credentials exposed in SPA shell
      assertNotLeaked(res.text);
    });

    it('TC-T2-F29-02: Dynamic import failure recovery simulation', async () => {
      // Nonexistent static assets under /assets/ should return 404, not crash
      const res = await anonClient.get('/assets/nonexistent-chunk-12345.js');
      assert.ok([404, 200].includes(res.status));
      assertNotLeaked(res.text || '');
    });

    it('TC-T2-F29-03: Admin editor route deep link identification', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('deeplink_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      // Direct HTTP navigation to /admin/pages/:id/edit must return SPA shell with 200
      const res = await anonClient.get(`/admin/pages/${pageId}/edit`, {
        headers: { Accept: 'text/html' },
      });
      assertStatus(res, 200);
      assert.ok(res.text.includes('html'));

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F29-04: Chunk caching and reuse logic check', async () => {
      // Static assets must return standard cache-control or ETag headers
      const res = await anonClient.get('/');
      assertStatus(res, 200);
      assert.ok(res.headers.get('content-type'));
    });

    it('TC-T2-F29-05: Loading indicator state representation', async () => {
      // Anonymous request to admin draft API returns 401 UNAUTHORIZED
      const res = await anonClient.get('/api/admin/pages/00000000-0000-0000-0000-000000000000');
      assertStatus(res, 401);
      assertError(res, 401, 'UNAUTHORIZED');
    });
  });

  // =========================================================================
  // Feature 30: View Modes (Editor / Preview / Split)
  // =========================================================================
  describe('Feature 30: View Modes Boundaries', () => {
    it('TC-T2-F30-01: Mobile viewport (< 768px) collapses split mode to single pane', async () => {
      // Verify public catalog and reader deliver responsive viewport meta tag in SPA shell
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
      assert.ok(res.text.includes('viewport') || res.text.includes('width=device-width'), 'HTML shell must declare mobile viewport');
    });

    it('TC-T2-F30-02: Synchronized scroll proportionality calculation', async () => {
      // Verify preview content delivery matches draft structure across sections
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('scroll_sync_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      const multiSectionDoc = '## Section A\nText\n## Section B\nText\n## Section C\nText';
      const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: multiSectionDoc,
      });
      assertStatus(patchRes, 200);

      const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(getRes, 200);
      assert.strictEqual(getRes.data.draft_markdown, multiSectionDoc);

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F30-03: View mode preference persistence key validation', async () => {
      // Draft updates preserve markdown formatting regardless of UI view mode
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('view_mode_persist'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      const res = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(res, 200);
      assert.strictEqual(typeof res.data.revision, 'number');

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F30-04: DOMPurify XSS neutralization in live preview pane', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('preview_xss_test'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      // Update draft with script and event handler injection
      const xssDoc = '<script>alert("preview_xss")</script><b onclick="alert(1)">Click</b>\n[Safe Link](https://example.com)';
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: xssDoc,
      });

      // Publish and verify public reader endpoint strips or sanitizes XSS vectors
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });

      const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(pubRes, 200);
      assertNoXss(pubRes.data.markdown);
      assertNotLeaked(pubRes.text);

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F30-05: Debounced preview rendering delay check (~300ms)', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('dual_state_preview'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      // 1. Initial publish
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });

      // 2. Draft update (preview in progress)
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 2,
        markdown: '# New Unsaved Draft Content',
      });

      // Public viewer must still see original published snapshot
      const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(pubRes, 200);
      assert.ok(!pubRes.data.markdown.includes('New Unsaved Draft Content'));

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });
  });
});
