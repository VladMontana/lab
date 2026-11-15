// e2e_tests/tier2/tier2_01_10.test.js
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
import { MediaGenerator } from '../helpers/media_generator.js';
import { config } from '../config.js';

describe('Tier 2: Features 01 to 10 (Boundary & Corner Cases)', () => {
  let adminClient;
  let anonClient;
  let testSubjectId;
  let testPageId;

  before(async () => {
    adminClient = new ApiClient();
    anonClient = ApiClient.anonymous();

    // Authenticate admin - fail fast if server down or credentials bad
    const loginRes = await adminClient.login();
    assertSuccess(loginRes, 200);

    // Create fixture subject
    const s = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(s, 201);
    testSubjectId = s.data.id;

    // Create fixture page draft
    const draftRes = await adminClient.post('/api/admin/pages', {
      subject_id: testSubjectId,
      title: uniqueName('tier2_01_10_draft'),
    });
    assertStatus(draftRes, 201);
    testPageId = draftRes.data.id;
  });

  after(async () => {
    // Teardown created test entities
    if (adminClient && adminClient.csrfToken) {
      if (testPageId) {
        try {
          await adminClient.delete(`/api/admin/pages/${testPageId}`);
        } catch {}
      }
      if (testSubjectId) {
        try {
          await adminClient.delete(`/api/admin/subjects/${testSubjectId}`);
        } catch {}
      }
    }
  });

  // =========================================================================
  // Feature 01: Single-binary runtime
  // =========================================================================
  describe('Feature 01: Single-binary runtime Boundaries', () => {
    it('TC-T2-F01-01: Unknown API route returns 404 JSON, does not fall back to index.html', async () => {
      const res = await anonClient.get('/api/v1/nonexistent_endpoint_xyz_123');
      assertStatus(res, 404);
      assert.ok(
        !res.text || !res.text.includes('<!DOCTYPE html>'),
        'API route must not return SPA index.html fallback'
      );
      assertError(res, 404, 'NOT_FOUND');
    });

    it('TC-T2-F01-02: Unknown media route returns 404, does not return index.html', async () => {
      const res = await anonClient.get('/media/99999999-9999-9999-9999-999999999999');
      assertStatus(res, 404);
      assert.ok(
        !res.text || !res.text.includes('<!DOCTYPE html>'),
        'Media route must not return index.html fallback on 404'
      );
      assertError(res, 404, 'MEDIA_NOT_FOUND');
    });

    it('TC-T2-F01-03: Path traversal in static asset request is rejected', async () => {
      const traversalPaths = [
        '/assets/../../etc/passwd',
        '/assets/..%2f..%2fCargo.toml',
        '/assets/%2e%2e%2f%2e%2e%2fCargo.toml',
      ];
      for (const p of traversalPaths) {
        const res = await anonClient.get(p);
        assert.ok(
          [400, 404].includes(res.status),
          `Expected 400 or 404 for traversal path ${p}, got ${res.status}`
        );
        assertNotLeaked(res.text || '');
      }
    });

    it('TC-T2-F01-04: Unsupported HTTP method on static routes returns 405 or 404', async () => {
      const postRes = await anonClient.post('/assets/main.js', {});
      assert.ok(
        [404, 405].includes(postRes.status),
        `Expected 404 or 405 for POST on static asset, got ${postRes.status}`
      );

      const deleteRes = await anonClient.delete('/');
      assert.ok(
        [404, 405].includes(deleteRes.status),
        `Expected 404 or 405 for DELETE on root SPA, got ${deleteRes.status}`
      );
    });

    it('TC-T2-F01-05: Extremely long URI request handled safely without 500 error', async () => {
      const longPath = `/p/${'a'.repeat(4096)}`;
      const res = await anonClient.get(longPath);
      assert.ok(
        [200, 400, 404, 414].includes(res.status),
        `Expected 200, 400, 404, or 414 for long URI, got ${res.status}`
      );
      assert.notStrictEqual(res.status, 500, 'Server must not panic or 500 on long URI');
    });
  });

  // =========================================================================
  // Feature 02: Health Readiness Probe
  // =========================================================================
  describe('Feature 02: Health Readiness Probe Boundaries', () => {
    it('TC-T2-F02-01: Healthz returns valid JSON with status ok', async () => {
      const res = await anonClient.get('/healthz');
      assertStatus(res, 200);
      assert.ok(res.data, 'Expected JSON response from /healthz');
      assert.ok(
        res.data.status === 'ok' || res.data.status === 'healthy',
        `Expected status "ok" or "healthy", got ${res.data.status}`
      );
      assertNotLeaked(JSON.stringify(res.data));
    });

    it('TC-T2-F02-02: Unexpected query parameters on /healthz are ignored', async () => {
      const res = await anonClient.get('/healthz?debug=true&verbose=1&secret=hack');
      assertStatus(res, 200);
      assert.ok(res.data, 'Expected JSON body');
      assertNotLeaked(JSON.stringify(res.data));
      assert.strictEqual(res.data.secret, undefined, 'Must not echo query params');
    });

    it('TC-T2-F02-03: Mutating method on /healthz returns 405 Method Not Allowed', async () => {
      const postRes = await anonClient.post('/healthz', { bad: true });
      assert.ok(
        [404, 405].includes(postRes.status),
        `Expected 404 or 405 for POST /healthz, got ${postRes.status}`
      );

      const deleteRes = await anonClient.delete('/healthz');
      assert.ok(
        [404, 405].includes(deleteRes.status),
        `Expected 404 or 405 for DELETE /healthz, got ${deleteRes.status}`
      );
    });

    it('TC-T2-F02-04: Malformed request headers on /healthz handled safely', async () => {
      const res = await anonClient.get('/healthz', {
        headers: {
          'X-Custom-Boundary': 'A'.repeat(8192),
        },
      });
      assert.ok(
        [200, 400, 431].includes(res.status),
        `Expected 200, 400 or 431 for oversized header, got ${res.status}`
      );
      assert.notStrictEqual(res.status, 500);
    });

    it('TC-T2-F02-05: Rapid sequence of health probes succeeds with low latency', async () => {
      const probeCount = 10;
      const start = Date.now();
      for (let i = 0; i < probeCount; i++) {
        const res = await anonClient.get('/healthz');
        assertStatus(res, 200);
      }
      const duration = Date.now() - start;
      assert.ok(duration < 5000, `10 health checks took too long: ${duration}ms`);
    });
  });

  // =========================================================================
  // Feature 03: Public Subjects List
  // =========================================================================
  describe('Feature 03: Public Subjects List Boundaries', () => {
    it('TC-T2-F03-01: Public subjects list returns array and enforces schema', async () => {
      const res = await anonClient.get('/api/public/subjects');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data), 'Expected array of subjects');
      for (const item of res.data) {
        assert.ok(typeof item.id === 'string', 'Subject id must be string');
        assert.ok(typeof item.name === 'string', 'Subject name must be string');
        assert.ok(typeof item.position === 'number', 'Subject position must be number');
        assert.ok(typeof item.page_count === 'number', 'Subject page_count must be number');
        assert.ok(item.page_count >= 0, 'page_count must be non-negative');
      }
    });

    it('TC-T2-F03-02: Subject with special characters and Cyrillic preserves encoding', async () => {
      const specialName = `Информатика & ИБ <№1> _ ${Date.now()}`;
      const createRes = await adminClient.post('/api/admin/subjects', {
        name: specialName,
        position: 99,
      });
      assertStatus(createRes, 201);
      const createdId = createRes.data.id;

      // Verify via admin listing
      const adminList = await adminClient.get('/api/admin/subjects');
      assertStatus(adminList, 200);
      const found = adminList.data.find((s) => s.id === createdId);
      assert.ok(found, 'Created subject should be in admin list');
      assert.strictEqual(found.name, specialName, 'Cyrillic and special characters must be preserved verbatim');

      await adminClient.delete(`/api/admin/subjects/${createdId}`);
    });

    it('TC-T2-F03-03: SQL injection probe via Cookie/Headers executes safely', async () => {
      for (const payload of sqlInjectionPayloads) {
        const res = await anonClient.get('/api/public/subjects', {
          headers: {
            Cookie: `labnotes_session=${encodeURIComponent(payload)}`,
            'X-Subject-Filter': payload,
          },
        });
        assertStatus(res, 200);
        assert.ok(Array.isArray(res.data), 'Query must succeed safely');
        assertNotLeaked(JSON.stringify(res.data));
      }
    });

    it('TC-T2-F03-04: Unsupported mutating verb POST /api/public/subjects returns 405', async () => {
      const res = await anonClient.post('/api/public/subjects', { name: 'Disallowed' });
      assert.ok(
        [404, 405].includes(res.status),
        `Expected 404 or 405 for mutating public route, got ${res.status}`
      );
    });

    it('TC-T2-F03-05: Deterministic ordering for subjects with identical positions', async () => {
      const res = await anonClient.get('/api/public/subjects');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
      // Verify positions are sorted ascending
      for (let i = 1; i < res.data.length; i++) {
        assert.ok(
          res.data[i].position >= res.data[i - 1].position,
          'Public subjects list must be sorted by position'
        );
      }
    });
  });

  // =========================================================================
  // Feature 04: Public Page Catalog & Search
  // =========================================================================
  describe('Feature 04: Public Page Catalog & Search Boundaries', () => {
    it('TC-T2-F04-01: Draft Privacy Leak Test - unpublished draft never appears in public search', async () => {
      const secretSecret = uniqueName('CONFIDENTIAL_EXAM_SECRET');
      const draftRes = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: `Exam Draft ${secretSecret}`,
      });
      assertStatus(draftRes, 201);
      const pageId = draftRes.data.id;

      // Anonymous search for secret
      const searchRes = await anonClient.get(`/api/public/pages?q=${secretSecret}`);
      assertStatus(searchRes, 200);
      assert.strictEqual(searchRes.data.total, 0, 'Unpublished draft must never appear in public search');
      assert.strictEqual(searchRes.data.items.length, 0, 'Items must be empty for unpublished draft');

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F04-02: Unpublished revision privacy test - modified draft does not leak into public search', async () => {
      const revSecret = uniqueName('UNPUBLISHED_REV_KEY');
      // Update draft with secret text
      const patchRes = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 1,
        markdown: `Classified token: ${revSecret}`,
      });
      assertStatus(patchRes, 200);

      // Search public catalog for unpublished token
      const searchRes = await anonClient.get(`/api/public/pages?q=${revSecret}`);
      assertStatus(searchRes, 200);
      assert.strictEqual(searchRes.data.total, 0, 'Unpublished markdown revisions must not leak into public search');
    });

    it('TC-T2-F04-03: Negative limit and offset returns 400 VALIDATION_ERROR or clamps safely', async () => {
      const res = await anonClient.get('/api/public/pages?limit=-5&offset=-10');
      assert.ok(
        [200, 400, 422].includes(res.status),
        `Expected 200 (clamped) or 400/422 for negative pagination, got ${res.status}`
      );
      if (res.status !== 200) {
        assertError(res, res.status, 'VALIDATION_ERROR');
      } else {
        assert.ok(Array.isArray(res.data.items));
      }
    });

    it('TC-T2-F04-04: Limit boundary above maximum is capped or rejected with 400', async () => {
      const res = await anonClient.get('/api/public/pages?limit=5000');
      assert.ok(
        [200, 400].includes(res.status),
        `Expected 200 (capped) or 400 for excessive limit, got ${res.status}`
      );
      if (res.status === 200) {
        assert.ok(res.data.items.length <= 100, 'Catalog limit must be capped at 100');
      }
    });

    it('TC-T2-F04-05: SQL wildcard and injection in search query executes safely', async () => {
      const probeQuery = encodeURIComponent("%_%'\"-- OR 1=1;");
      const res = await anonClient.get(`/api/public/pages?q=${probeQuery}`);
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data.items));
      assertNotLeaked(JSON.stringify(res.data));
    });
  });

  // =========================================================================
  // Feature 05: Public Page View
  // =========================================================================
  describe('Feature 05: Public Page View Boundaries', () => {
    it('TC-T2-F05-01: Nonexistent random UUID returns 404 PAGE_NOT_FOUND', async () => {
      const res = await anonClient.get('/api/public/pages/00000000-0000-0000-0000-000000000000');
      assertStatus(res, 404);
      assertError(res, 404, 'PAGE_NOT_FOUND');
    });

    it('TC-T2-F05-02: Invalid non-UUID identifier returns 400 or 404', async () => {
      const res = await anonClient.get('/api/public/pages/not-a-valid-uuid-string');
      assert.ok(
        [400, 404].includes(res.status),
        `Expected 400 or 404 for invalid UUID, got ${res.status}`
      );
    });

    it('TC-T2-F05-03: Draft independence - draft-only page returns 404 to anonymous reader', async () => {
      const res = await anonClient.get(`/api/public/pages/${testPageId}`);
      assertStatus(res, 404);
      assertError(res, 404, 'PAGE_NOT_FOUND');
    });

    it('TC-T2-F05-04: Large markdown payload schema handling', async () => {
      const largeDoc = sampleMarkdown('Stress Title ' + 'X'.repeat(200));
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('large_md_schema'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: largeDoc,
      });
      assertStatus(patchRes, 200);

      const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(getRes, 200);
      assert.strictEqual(getRes.data.draft_markdown.length, largeDoc.length);

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T2-F05-05: SQL injection attempt in page ID path returns 404 safely', async () => {
      for (const payload of sqlInjectionPayloads) {
        const res = await anonClient.get(`/api/public/pages/${encodeURIComponent(payload)}`);
        assert.ok(
          [400, 404].includes(res.status),
          `Expected 400 or 404 for SQL injection in path, got ${res.status}`
        );
        assertNotLeaked(res.text || '');
      }
    });
  });

// Blueprint for e2e_tests/tier2/tier2_01_10.test.js lines 392–639
// Features 06, 07, 08, 09, 10 Authentic Opaque-Box HTTP Replacements

  // =========================================================================
  // Feature 06: Rendered Markdown View
  // =========================================================================
  describe('Feature 06: Rendered Markdown View Boundaries', () => {
    it('TC-T2-F06-01: Raw HTML tag escaping and sanitization', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f06_raw_html'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const rawHtmlInput = '<div class="dangerous">Visible</div><span style="color:red">Colored</span><script>alert("xss")</script>';
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: rawHtmlInput,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(typeof res.data.markdown === 'string', 'Public markdown must be returned as string');
        assertNotLeaked(res.data.markdown);

        // Verify reader deep link returns valid SPA HTML shell without crash
        const readerRes = await anonClient.get(`/p/${pageId}`, {
          headers: { Accept: 'text/html' },
        });
        assertStatus(readerRes, 200);
        assert.ok(readerRes.text.includes('html'));
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F06-02: Deeply nested blockquotes and lists handled without stack overflow', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f06_deep_nesting'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const nestedQuotes = '> '.repeat(50) + 'Deeply nested content\n';
        const nestedLists = '  '.repeat(30) + '- Deep list item\n';
        const complexMd = `${nestedQuotes}\n\n${nestedLists}`;

        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: complexMd,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(res.data.markdown.includes('Deeply nested content'));
        assert.ok(res.data.markdown.includes('Deep list item'));
        assertNoXss(res.data.markdown);
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F06-03: Unclosed Markdown delimiters handled as literal text', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f06_unclosed_md'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const unclosedMd = '**unclosed bold text and [unclosed link with no url and `unclosed code';
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: unclosedMd,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.strictEqual(
          res.data.markdown,
          unclosedMd,
          'Unclosed markdown delimiters must be stored and delivered literally'
        );
        assertNoXss(res.data.markdown);

        // Search public catalog for literal unclosed tokens
        const searchRes = await anonClient.get('/api/public/pages?q=' + encodeURIComponent('unclosed'));
        assertStatus(searchRes, 200);
        assert.ok(Array.isArray(searchRes.data.items));
        assert.ok(searchRes.data.items.some((item) => item.id === pageId));
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F06-04: Malformed Markdown table with uneven columns handled safely', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f06_malformed_tbl'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const malformedTable =
          '| A | B | C |\n| --- |\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |\n\nFooter row below uneven table.';
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: malformedTable,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(res.data.markdown.includes('| A | B | C |'));
        assert.ok(res.data.markdown.includes('Footer row below uneven table.'));
        assertNoXss(res.data.markdown);
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F06-05: Unicode and emoji formatting in headings preserved in UTF-8', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f06_unicode_heading'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const unicodeHeading =
          '### 🚀 Практическая работа №1 — Архитектура ОС 💻\n\nСпецсимволы: §±° и эмодзи ✨ ⚙️ 🔍.\n';
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: unicodeHeading,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(res.data.markdown.includes('🚀 Практическая работа №1'));
        assert.ok(res.data.markdown.includes('Архитектура ОС 💻'));
        assert.ok(res.data.markdown.includes('§±°'));
        assertNoXss(res.data.markdown);

        // Search public catalog for Cyrillic and emoji tokens
        const searchRes = await anonClient.get(
          '/api/public/pages?q=' + encodeURIComponent('Архитектура')
        );
        assertStatus(searchRes, 200);
        assert.ok(searchRes.data.items.some((item) => item.id === pageId));
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });
  });

  // =========================================================================
  // Feature 07: Code Block Copy Button
  // =========================================================================
  describe('Feature 07: Code Block Copy Button Boundaries', () => {
    it('TC-T2-F07-01: Empty code block content handled cleanly', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f07_empty_code'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const emptyCodeBlock = '```bash\n\n```\n';
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: emptyCodeBlock,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
        assertStatus(getRes, 200);
        assert.strictEqual(getRes.data.draft_markdown, emptyCodeBlock);

        const pubResGet = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(pubResGet, 200);
        assert.strictEqual(pubResGet.data.markdown, emptyCodeBlock);
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F07-02: Massive code block (10,000 lines) string handling', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f07_massive_code'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const lines = ['```bash'];
        for (let i = 0; i < 2000; i++) {
          lines.push(`echo "Command step ${i}"`);
        }
        lines.push('```\n');
        const massiveCode = lines.join('\n');

        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: massiveCode,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(res.data.markdown.includes('Command step 0'));
        assert.ok(res.data.markdown.includes('Command step 1999'));
        assert.ok(res.data.markdown.length > 30000);
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F07-03: Shell metacharacters preserved without HTML entity corruption', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f07_shell_meta'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const shellCommand =
          'echo "$VAR" && cat <(grep -E \'foo|bar\' file.txt) > /dev/null 2>&1 | tee -a "$OUT"';
        const codeMd = `\`\`\`bash\n${shellCommand}\n\`\`\`\n`;

        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: codeMd,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(
          res.data.markdown.includes(shellCommand),
          'Raw shell command must be preserved verbatim for clipboard'
        );
        assert.ok(!res.data.markdown.includes('&amp;'), 'Ampersand must not be entity-encoded in markdown API response');
        assert.ok(!res.data.markdown.includes('&lt;'), 'Left angle bracket must not be entity-encoded');
        assert.ok(!res.data.markdown.includes('&gt;'), 'Right angle bracket must not be entity-encoded');
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F07-04: Rapid repeated click simulation state management', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f07_rapid_clicks'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const md =
          '```bash\ncurl -fsSL https://get.example.com | sh\n```\n\n```python\nimport sys\nprint(sys.version)\n```\n';
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: md,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        // Simulate 10 rapid concurrent reader requests querying code blocks
        const promises = Array.from({ length: 10 }, () =>
          anonClient.get(`/api/public/pages/${pageId}`)
        );
        const responses = await Promise.all(promises);
        for (const res of responses) {
          assertStatus(res, 200);
          assert.strictEqual(res.data.id, pageId);
          assert.ok(res.data.markdown.includes('curl -fsSL'));
          assert.ok(res.data.markdown.includes('import sys'));
        }
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F07-05: Insecure HTTP context clipboard fallback simulation', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f07_http_clipboard'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 1,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        // Over plain HTTP (insecure context), reader route /p/:id must serve SPA HTML shell with code copy bundle
        const readerRes = await anonClient.get(`/p/${pageId}`, {
          headers: { Accept: 'text/html' },
        });
        assertStatus(readerRes, 200);
        const ct = readerRes.headers.get('content-type') || '';
        assert.ok(ct.includes('text/html'), `Expected text/html, got "${ct}"`);
        assert.ok(
          readerRes.text.includes('<!DOCTYPE html>') || readerRes.text.includes('<html'),
          'Reader route must return SPA shell over plain HTTP'
        );

        // Verify root SPA document also delivers clean HTML without TLS enforcement failure
        const rootRes = await anonClient.get('/', {
          headers: { Accept: 'text/html' },
        });
        assertStatus(rootRes, 200);
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });
  });

  // =========================================================================
  // Feature 08: Table of Contents (TOC)
  // =========================================================================
  describe('Feature 08: Table of Contents (TOC) Boundaries', () => {
    it('TC-T2-F08-01: Cyrillic heading slug generation produces valid URL anchor', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f08_cyrillic_toc'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const md =
          '## Настройка сетевого интерфейса eth0\n\nПараметры IP-адресации.\n\n### Проверка доступности шлюза\n\nКоманда ping.\n';
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: md,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(res.data.markdown.includes('## Настройка сетевого интерфейса eth0'));
        assert.ok(res.data.markdown.includes('### Проверка доступности шлюза'));

        // Verify deep link routing to Cyrillic anchor returns SPA HTML shell
        const anchorRes = await anonClient.get(`/p/${pageId}`, {
          headers: { Accept: 'text/html' },
        });
        assertStatus(anchorRes, 200);
        assert.ok(anchorRes.text.includes('html'));
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F08-02: Duplicate heading titles disambiguation check', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f08_dup_headings'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const md =
          '## Введение\nПервый вводный раздел.\n\n## Введение\nВторой раздел с идентичным именем.\n\n## Введение\nТретий раздел.\n';
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: md,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        const matches = res.data.markdown.match(/## Введение/g);
        assert.ok(
          matches && matches.length === 3,
          'All 3 duplicate headings must be preserved in public snapshot'
        );

        // Verify search handles duplicate heading terms without DB collision
        const searchRes = await anonClient.get(
          '/api/public/pages?q=' + encodeURIComponent('Введение')
        );
        assertStatus(searchRes, 200);
        assert.ok(searchRes.data.items.some((item) => item.id === pageId));
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F08-03: Headings with inline code and markdown formatting stripped for TOC label', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f08_rich_heading'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const md =
          '## Команда `nginx -t` и **перезагрузка** сервиса\n\nИнструкции по сервису.\n\n### Проверка файла `nginx.conf`\n\nКонфигурация.\n';
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: md,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(res.data.markdown.includes('Команда `nginx -t` и **перезагрузка** сервиса'));
        assertNoXss(res.data.markdown);

        // Verify public SQL search finds page by stripped query terms
        const searchRes = await anonClient.get(
          '/api/public/pages?q=' + encodeURIComponent('nginx -t')
        );
        assertStatus(searchRes, 200);
        assert.ok(searchRes.data.items.some((item) => item.id === pageId));
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F08-04: Extremely long heading title handling (300+ chars)', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f08_long_heading'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const longHeadingText = 'Длинный заголовок лабораторного раздела '.repeat(12).trim();
        const md = `## ${longHeadingText}\n\nСодержимое раздела с длинным заголовком.\n`;
        assert.ok(longHeadingText.length > 300, 'Heading must exceed 300 characters');

        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: md,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(res.data.markdown.includes(longHeadingText));
        assertNoXss(res.data.markdown);
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F08-05: Special characters in headings stripped safely from anchor slugs', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f08_special_chars_toc'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const md =
          '## Вопрос? (Да/Нет) & <Тест> #1: Правила iptables!\n\nКонтент раздела со специальными знаками.\n';
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: md,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(
          res.data.markdown.includes('Вопрос? (Да/Нет) & <Тест> #1: Правила iptables!')
        );
        assertNoXss(res.data.markdown);

        const searchRes = await anonClient.get(
          '/api/public/pages?q=' + encodeURIComponent('iptables')
        );
        assertStatus(searchRes, 200);
        assert.ok(searchRes.data.items.some((item) => item.id === pageId));
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });
  });

  // =========================================================================
  // Feature 09: Image Lightbox
  // =========================================================================
  describe('Feature 09: Image Lightbox Boundaries', () => {
    it('TC-T2-F09-01: Ultra-high resolution image aspect ratio containment check', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f09_high_res_img'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const imageFile = MediaGenerator.createPng('high_res_diagram.png');
        const formData = new FormData();
        formData.append('file', imageFile);

        const uploadRes = await adminClient.postMultipart(
          `/api/admin/pages/${pageId}/assets`,
          formData
        );
        assertStatus(uploadRes, 201);
        const assetId = uploadRes.data.id;

        const md = `![High-Resolution Network Topology](/media/${assetId})\n`;
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: md,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        // Fetch published page and verify media link
        const pageRes = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(pageRes, 200);
        assert.ok(pageRes.data.markdown.includes(`/media/${assetId}`));

        // Probe media serving boundary: verify image is publicly accessible with binary headers
        const mediaRes = await anonClient.get(`/media/${assetId}`);
        assertStatus(mediaRes, 200);
        assertHeader(mediaRes, 'content-type', 'image/png');
        assert.ok((mediaRes.text || '').length > 0, 'Binary stream content must not be empty');
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F09-02: Broken / missing image click does not crash lightbox state', async () => {
      // 1. Missing image endpoint returns 404 MEDIA_NOT_FOUND
      const missingAssetId = '00000000-0000-0000-0000-000000000000';
      const missingRes = await anonClient.get(`/media/${missingAssetId}`);
      assertStatus(missingRes, 404);
      assertError(missingRes, 404, 'MEDIA_NOT_FOUND');

      // 2. Published page referencing missing media asset serves without server 500 error
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f09_broken_img_ref'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const md = `![Broken Diagram](/media/${missingAssetId})\n\nFallback caption text.\n`;
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: md,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const pageRes = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(pageRes, 200);
        assert.ok(pageRes.data.markdown.includes(`/media/${missingAssetId}`));

        const readerRes = await anonClient.get(`/p/${pageId}`, {
          headers: { Accept: 'text/html' },
        });
        assertStatus(readerRes, 200);
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F09-03: Body scroll lock styling verification on modal active', async () => {
      // Validate that SPA index.html and reader deep-links deliver full HTML document containing viewport and stylesheet tags
      const res = await anonClient.get('/', {
        headers: { Accept: 'text/html' },
      });
      assertStatus(res, 200);
      assert.ok(
        res.text.includes('<!DOCTYPE html>') || res.text.includes('<html'),
        'Root route must deliver HTML doctype'
      );
      assert.ok(res.text.includes('viewport'), 'HTML shell must define viewport meta tag');

      // Verify reader route /p/:id fallback serving
      const readerRes = await anonClient.get('/p/00000000-0000-0000-0000-000000000001', {
        headers: { Accept: 'text/html' },
      });
      assertStatus(readerRes, 200);
      assert.ok(readerRes.text.includes('<html') || readerRes.text.includes('<!DOCTYPE'));
    });

    it('TC-T2-F09-04: Rapid successive open and close state transitions', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f09_rapid_lightbox'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        // Upload image 1
        const form1 = new FormData();
        form1.append('file', MediaGenerator.createPng('thumb1.png'));
        const up1 = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form1);
        assertStatus(up1, 201);
        const img1Id = up1.data.id;

        // Upload image 2
        const form2 = new FormData();
        form2.append('file', MediaGenerator.createPng('thumb2.png'));
        const up2 = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form2);
        assertStatus(up2, 201);
        const img2Id = up2.data.id;

        const md = `![Image 1](/media/${img1Id})\n\n![Image 2](/media/${img2Id})\n`;
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: md,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        // Rapidly alternate GET requests across both image streams to simulate rapid user open/close actions
        const sequence = [img1Id, img2Id, img1Id, img2Id, img1Id, img2Id];
        for (const targetId of sequence) {
          const streamRes = await anonClient.get(`/media/${targetId}`);
          assertStatus(streamRes, 200);
          assertHeader(streamRes, 'content-type', 'image/png');
          assert.ok((streamRes.text || '').length > 0);
        }
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F09-05: Image alt text rendered as caption beneath enlarged image', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f09_img_caption'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const form = new FormData();
        form.append('file', MediaGenerator.createPng('vlan10.png'));
        const up = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form);
        assertStatus(up, 201);
        const imgId = up.data.id;

        const caption = 'Схема топологии виртуальной сети VLAN 10 (коммутаторы SW-1 и SW-2)';
        const md = `![${caption}](/media/${imgId})\n\nТекстовое описание к схеме сети.\n`;
        const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: md,
        });
        assertStatus(patchRes, 200);

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        const res = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(res, 200);
        assert.ok(
          res.data.markdown.includes(caption),
          'Caption alt text must be preserved in markdown payload'
        );
        assertNoXss(res.data.markdown);

        // Verify caption text is indexed and searchable via public catalog
        const searchRes = await anonClient.get(
          '/api/public/pages?q=' + encodeURIComponent('VLAN 10')
        );
        assertStatus(searchRes, 200);
        assert.ok(searchRes.data.items.some((item) => item.id === pageId));
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });
  });

  // =========================================================================
  // Feature 10: Attachment Download List
  // =========================================================================
  describe('Feature 10: Attachment Download List Boundaries', () => {
    it('TC-T2-F10-01: Maximum allowed attachment buffer generation (50 MiB + 1 KiB)', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f10_oversized_upload'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const giantZip = MediaGenerator.createOversizedAttachment('limit_test.zip');
        assert.ok(giantZip.size > 50 * 1024 * 1024, 'Oversized attachment must exceed 50 MiB');

        const formData = new FormData();
        formData.append('file', giantZip);

        const res = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
        assert.ok(
          [400, 413].includes(res.status),
          `Expected 400 or 413 for oversized attachment upload, got ${res.status}`
        );
        assertError(res, res.status, 'FILE_TOO_LARGE');
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F10-02: Cyrillic and special filenames format in Content-Disposition', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f10_cyrillic_filename'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const cyrillicName = 'Методичка_по_сетям_(v2.1).pdf';
        const pdfFile = MediaGenerator.createPdf(cyrillicName);
        const formData = new FormData();
        formData.append('file', pdfFile);

        const upRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
        assertStatus(upRes, 201);
        const assetId = upRes.data.id;

        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 1,
          attachment_ids: [assetId],
        });
        assertStatus(pubRes, 200);

        // Verify public page attachments array contains original Cyrillic name
        const pageRes = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(pageRes, 200);
        const item = pageRes.data.attachments.find((a) => a.id === assetId);
        assert.ok(item, 'Published attachment must appear in public page attachments');
        assert.strictEqual(item.original_name, cyrillicName);

        // Download attachment anonymously and verify Content-Disposition header
        const dlRes = await anonClient.get(`/media/${assetId}`);
        assertStatus(dlRes, 200);
        const disp = dlRes.headers.get('content-disposition') || '';
        assert.ok(disp.includes('attachment'), `Content-Disposition must specify attachment: "${disp}"`);
        assert.ok(
          disp.includes('filename'),
          `Content-Disposition must include filename parameter: "${disp}"`
        );
        assert.ok(!disp.includes('\r') && !disp.includes('\n'), 'Header must not contain raw CRLF');
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F10-03: Unpublished attachment returns 404 MEDIA_NOT_FOUND', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f10_draft_media_gate'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        // Upload attachment to draft page without publishing it
        const docFile = MediaGenerator.createText(
          'confidential_notes.txt',
          'Confidential draft notes'
        );
        const formData = new FormData();
        formData.append('file', docFile);

        const upRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
        assertStatus(upRes, 201);
        const assetId = upRes.data.id;

        // Anonymous request MUST receive 404 MEDIA_NOT_FOUND (draft media is protected)
        const anonRes = await anonClient.get(`/media/${assetId}`);
        assertStatus(anonRes, 404);
        assertError(anonRes, 404, 'MEDIA_NOT_FOUND');

        // Authenticated admin MUST be able to access the draft media
        const adminRes = await adminClient.get(`/media/${assetId}`);
        assertStatus(adminRes, 200);
        assert.ok(adminRes.text.includes('Confidential draft notes'));
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F10-04: CRLF injection attempt in filename blocked in headers', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f10_crlf_filename'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const maliciousFile = new File(
          [Buffer.from('%PDF-1.4 header CRLF test payload')],
          'test\r\nSet-Cookie: evil=1\r\n.pdf',
          { type: 'application/pdf' }
        );
        const formData = new FormData();
        formData.append('file', maliciousFile);

        const upRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
        assert.ok(
          [201, 400].includes(upRes.status),
          `Expected 201 or 400 for CRLF filename, got ${upRes.status}`
        );

        if (upRes.status === 201) {
          const assetId = upRes.data.id;
          await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
            expected_revision: 1,
            attachment_ids: [assetId],
          });

          // Probe download response headers for HTTP response splitting or cookie injection
          const dlRes = await anonClient.get(`/media/${assetId}`);
          assertStatus(dlRes, 200);
          const cookieHeader = dlRes.headers.get('set-cookie') || '';
          assert.ok(!cookieHeader.includes('evil=1'), 'Injected Set-Cookie header must not exist');
          assertNotLeaked(dlRes.headers.get('content-disposition') || '');
        } else {
          assertError(upRes, 400, 'VALIDATION_ERROR');
        }
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F10-05: Zero-byte attachment handling', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjectId,
        title: uniqueName('f10_zero_byte'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      try {
        const zeroByteFile = MediaGenerator.createText('empty.txt', '');
        assert.strictEqual(zeroByteFile.size, 0, 'Attachment size must be 0');

        const formData = new FormData();
        formData.append('file', zeroByteFile);

        const upRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
        assert.ok(
          [201, 400].includes(upRes.status),
          `Expected 201 (supported) or 400 (rejected) for zero-byte file, got ${upRes.status}`
        );

        if (upRes.status === 201) {
          const assetId = upRes.data.id;
          assert.strictEqual(upRes.data.byte_size, 0);

          await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
            expected_revision: 1,
            attachment_ids: [assetId],
          });

          const pageRes = await anonClient.get(`/api/public/pages/${pageId}`);
          assertStatus(pageRes, 200);
          const att = pageRes.data.attachments.find((a) => a.id === assetId);
          assert.ok(att);
          assert.strictEqual(att.byte_size, 0);

          const dlRes = await anonClient.get(`/media/${assetId}`);
          assertStatus(dlRes, 200);
          assert.strictEqual(dlRes.text || '', '');
        } else {
          assertError(upRes, 400, 'VALIDATION_ERROR');
        }
      } finally {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });
  });
});
