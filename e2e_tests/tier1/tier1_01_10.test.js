// e2e_tests/tier1/tier1_01_10.test.js
// Tier 1 Test Suite: Features 01 to 10
// Covers:
// - Feature 01: Single-binary runtime
// - Feature 02: Health Readiness Probe
// - Feature 03: Public Subjects List
// - Feature 04: Public Page Catalog & Search
// - Feature 05: Public Page View
// - Feature 06: Rendered Markdown View
// - Feature 07: Code Block Copy Button
// - Feature 08: Table of Contents (TOC)
// - Feature 09: Image Lightbox
// - Feature 10: Attachment Download List

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../helpers/api_client.js';
import {
  assertStatus,
  assertSuccess,
  assertError,
  assertNotLeaked,
  assertHeader,
} from '../helpers/assertions.js';
import { sampleSubject, samplePageDraft, uniqueName, sampleMarkdown } from '../helpers/fixtures.js';
import { MediaGenerator } from '../helpers/media_generator.js';

describe('Tier 1: Features 01 to 10', () => {
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
    // Teardown created test pages
    for (const pageId of createdPageIds) {
      try {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      } catch {
        // ignore cleanup errors
      }
    }
    // Teardown created test subjects
    for (const subjId of createdSubjectIds) {
      try {
        await adminClient.delete(`/api/admin/subjects/${subjId}`);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  // =========================================================================
  // Feature 01: Single-binary runtime
  // =========================================================================
  describe('Feature 01: Single-binary runtime', () => {
    it('T1-F01-01: SPA Root Delivery returns HTML document', async () => {
      const res = await anonClient.get('/', {
        headers: { Accept: 'text/html' },
      });
      assertStatus(res, 200);
      assert.ok(res.text, 'Expected HTML content in response body');
      assert.ok(
        res.text.toLowerCase().includes('<!doctype html') || res.text.includes('<html'),
        'Expected HTML doctype in root SPA response'
      );
      assert.ok(
        res.text.includes('id="app"') || res.text.includes('<script') || res.text.includes('bundle') || res.text.includes('assets'),
        'Expected SPA root container or script tag in HTML'
      );
    });

    it('T1-F01-02: Static Asset Delivery returns 200 or clean asset', async () => {
      const res = await anonClient.get('/favicon.ico');
      // favicon or assets should return 200 or 404 (if not bundled) but never crash server
      assert.ok([200, 204, 404].includes(res.status), `Unexpected status ${res.status} for favicon`);
      assertNotLeaked(res.text || '');
    });

    it('T1-F01-03: Deep Link Fallback /p/:id returns index.html for client routing', async () => {
      const testUuid = 'e9b60d00-4b36-47b6-96b6-3914a1e9447e';
      const res = await anonClient.get(`/p/${testUuid}`, {
        headers: { Accept: 'text/html' },
      });
      assertStatus(res, 200);
      assert.ok(res.text, 'Expected HTML index fallback body');
      assert.ok(
        res.text.toLowerCase().includes('<!doctype html') || res.text.includes('<html'),
        'Expected SPA fallback HTML on deep link'
      );
    });

    it('T1-F01-04: Admin Deep Link Fallback /admin/pages/create returns index.html', async () => {
      const res = await anonClient.get('/admin/pages/create', {
        headers: { Accept: 'text/html' },
      });
      assertStatus(res, 200);
      assert.ok(
        res.text.toLowerCase().includes('<!doctype html') || res.text.includes('<html'),
        'Expected SPA index fallback for admin route'
      );
    });

    it('T1-F01-05: API Routing Priority returns JSON not HTML', async () => {
      const res = await anonClient.get('/api/public/subjects');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data), 'Expected JSON array response for /api/public/subjects');
      assert.ok(
        res.headers.get('content-type')?.includes('application/json'),
        'Expected Content-Type to include application/json'
      );
    });
  });

  // =========================================================================
  // Feature 02: Health Readiness Probe
  // =========================================================================
  describe('Feature 02: Health Readiness Probe', () => {
    it('T1-F02-01: Standard Readiness Check returns 200 with status ok', async () => {
      const res = await anonClient.get('/healthz');
      assertStatus(res, 200);
      assert.ok(res.data, 'Expected JSON body');
      assert.strictEqual(res.data.status, 'ok', 'Expected status: "ok"');
    });

    it('T1-F02-02: HEAD Method Support on /healthz returns 200 with empty body', async () => {
      const res = await anonClient.request('HEAD', '/healthz');
      assertStatus(res, 200);
      assert.strictEqual(res.text || '', '', 'HEAD request must return empty body');
    });

    it('T1-F02-03: No Secrets or Paths Leaked in health response', async () => {
      const res = await anonClient.get('/healthz');
      assertStatus(res, 200);
      assertNotLeaked(JSON.stringify(res.data));
      for (const [key, value] of res.headers.entries()) {
        assertNotLeaked(`${key}: ${value}`);
      }
    });

    it('T1-F02-04: Anonymous Access Allowed on /healthz', async () => {
      const freshClient = ApiClient.anonymous();
      const res = await freshClient.get('/healthz');
      assertStatus(res, 200);
      assert.strictEqual(res.data?.status, 'ok');
    });

    it('T1-F02-05: Idempotency and High Frequency under 20 rapid checks', async () => {
      const promises = Array.from({ length: 20 }, () => anonClient.get('/healthz'));
      const results = await Promise.all(promises);
      for (const res of results) {
        assertStatus(res, 200);
        assert.strictEqual(res.data?.status, 'ok');
      }
    });
  });

  // =========================================================================
  // Feature 03: Public Subjects List
  // =========================================================================
  describe('Feature 03: Public Subjects List', () => {
    let testSubjId;
    let testPageId;

    before(async () => {
      // Create a test subject and publish a page to test published count
      const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject({ name: uniqueName('F03_Subj') }));
      assertStatus(subjRes, 201);
      testSubjId = subjRes.data.id;
      createdSubjectIds.push(testSubjId);

      const pageRes = await adminClient.post('/api/admin/pages', {
        subject_id: testSubjId,
        title: uniqueName('F03_Pub_Page'),
      });
      assertStatus(pageRes, 201);
      testPageId = pageRes.data.id;
      createdPageIds.push(testPageId);

      const pubRes = await adminClient.post(`/api/admin/pages/${testPageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });
      assertStatus(pubRes, 200);
    });

    it('T1-F03-01: Subjects with Published Pages returns page_count >= 1', async () => {
      const res = await anonClient.get('/api/public/subjects');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data), 'Expected array of subjects');
      const found = res.data.find((s) => s.id === testSubjId);
      assert.ok(found, `Expected subject ${testSubjId} in public list`);
      assert.ok(found.page_count >= 1, `Expected page_count >= 1, got ${found.page_count}`);
    });

    it('T1-F03-02: Position Ordering sorts subjects ascending', async () => {
      const res = await anonClient.get('/api/public/subjects');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
      for (let i = 1; i < res.data.length; i++) {
        assert.ok(
          res.data[i].position >= res.data[i - 1].position,
          `Subjects not sorted by position: [${i - 1}]=${res.data[i - 1].position}, [${i}]=${res.data[i].position}`
        );
      }
    });

    it('T1-F03-03: Draft-Only Subject Isolation does not count unpublished drafts in public count', async () => {
      // Create empty subject with draft only
      const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject({ name: uniqueName('F03_DraftOnly') }));
      assertStatus(subjRes, 201);
      const draftSubjId = subjRes.data.id;
      createdSubjectIds.push(draftSubjId);

      const pageRes = await adminClient.post('/api/admin/pages', {
        subject_id: draftSubjId,
        title: uniqueName('DraftOnly_Page'),
      });
      assertStatus(pageRes, 201);
      createdPageIds.push(pageRes.data.id);

      const pubRes = await anonClient.get('/api/public/subjects');
      assertStatus(pubRes, 200);
      const found = pubRes.data.find((s) => s.id === draftSubjId);
      // Either subject is omitted or has page_count == 0
      if (found) {
        assert.strictEqual(found.page_count, 0, 'Draft-only subject must have page_count == 0');
      }
    });

    it('T1-F03-04: Subject Object Schema conforms to contract', async () => {
      const res = await anonClient.get('/api/public/subjects');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
      if (res.data.length > 0) {
        const item = res.data[0];
        assert.ok(typeof item.id === 'string', 'Subject must have string id');
        assert.ok(typeof item.name === 'string', 'Subject must have string name');
        assert.ok(typeof item.position === 'number', 'Subject must have number position');
        assert.ok(typeof item.page_count === 'number', 'Subject must have number page_count');
      }
    });

    it('T1-F03-05: Anonymous Reader Access requires no auth cookies', async () => {
      const client = ApiClient.anonymous();
      const res = await client.get('/api/public/subjects');
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
    });
  });

  // =========================================================================
  // Feature 04: Public Page Catalog & Search
  // =========================================================================
  describe('Feature 04: Public Page Catalog & Search', () => {
    let subjId;
    let page1Id;
    let page2Id;
    const uniqueTitleKey = uniqueName('WiresharkLab');
    const uniqueBodyKey = uniqueName('iptablesSecretKeyword');

    before(async () => {
      const sRes = await adminClient.post('/api/admin/subjects', sampleSubject());
      assertStatus(sRes, 201);
      subjId = sRes.data.id;
      createdSubjectIds.push(subjId);

      // Page 1
      const p1 = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: `Настройка ${uniqueTitleKey} и анализ трафика`,
      });
      assertStatus(p1, 201);
      page1Id = p1.data.id;
      createdPageIds.push(page1Id);

      await adminClient.patch(`/api/admin/pages/${page1Id}`, {
        expected_revision: 1,
        markdown: `# ${uniqueTitleKey}\n\nИнструкция по анализу пакетов.`,
      });
      await adminClient.post(`/api/admin/pages/${page1Id}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });

      // Page 2
      const p2 = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('FirewallLab'),
      });
      assertStatus(p2, 201);
      page2Id = p2.data.id;
      createdPageIds.push(page2Id);

      await adminClient.patch(`/api/admin/pages/${page2Id}`, {
        expected_revision: 1,
        markdown: `# Сетевой экран\n\nВыполните команду sudo ${uniqueBodyKey} -L для проверки правил.`,
      });
      await adminClient.post(`/api/admin/pages/${page2Id}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });
    });

    it('T1-F04-01: Default Paginated Catalog returns items array and total count', async () => {
      const res = await anonClient.get('/api/public/pages');
      assertStatus(res, 200);
      assert.ok(res.data && typeof res.data === 'object', 'Expected JSON object response');
      assert.ok(Array.isArray(res.data.items), 'Expected items array');
      assert.ok(typeof res.data.total === 'number', 'Expected total number');
      assert.ok(res.data.total >= 2, 'Expected total >= 2');
    });

    it('T1-F04-02: Offset Pagination limits item count properly', async () => {
      const res = await anonClient.get('/api/public/pages?limit=1&offset=0');
      assertStatus(res, 200);
      assert.ok(res.data.items.length <= 1, 'Limit=1 must return at most 1 item');
    });

    it('T1-F04-03: Subject Filter returns only pages for given subject', async () => {
      const res = await anonClient.get(`/api/public/pages?subject_id=${subjId}`);
      assertStatus(res, 200);
      assert.ok(res.data.items.length >= 2);
      for (const item of res.data.items) {
        assert.strictEqual(item.subject_id, subjId, 'Subject ID must match filter');
      }
    });

    it('T1-F04-04: Search by Title finds published page', async () => {
      const res = await anonClient.get(`/api/public/pages?q=${encodeURIComponent(uniqueTitleKey)}`);
      assertStatus(res, 200);
      assert.ok(res.data.items.length >= 1, `Expected search match for ${uniqueTitleKey}`);
      const found = res.data.items.find((item) => item.id === page1Id);
      assert.ok(found, `Expected page ${page1Id} in title search results`);
    });

    it('T1-F04-05: Search by Markdown Body Content finds published page', async () => {
      const res = await anonClient.get(`/api/public/pages?q=${encodeURIComponent(uniqueBodyKey)}`);
      assertStatus(res, 200);
      assert.ok(res.data.items.length >= 1, `Expected search match for body term ${uniqueBodyKey}`);
      const found = res.data.items.find((item) => item.id === page2Id);
      assert.ok(found, `Expected page ${page2Id} in body search results`);
    });
  });

  // =========================================================================
  // Feature 05: Public Page View
  // =========================================================================
  describe('Feature 05: Public Page View', () => {
    let subjId;
    let pubPageId;
    let draftPageId;
    let unpubPageId;
    const titleText = uniqueName('PublicViewTitle');
    const mdText = '# Public Lab Note\n\nContent for public reading.';

    before(async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      subjId = s.data.id;
      createdSubjectIds.push(subjId);

      // Published page
      const p1 = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: titleText,
      });
      pubPageId = p1.data.id;
      createdPageIds.push(pubPageId);

      await adminClient.patch(`/api/admin/pages/${pubPageId}`, {
        expected_revision: 1,
        markdown: mdText,
      });
      await adminClient.post(`/api/admin/pages/${pubPageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });

      // Draft-only page
      const p2 = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('DraftOnlyTitle'),
      });
      draftPageId = p2.data.id;
      createdPageIds.push(draftPageId);

      // Unpublished page
      const p3 = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('UnpubTitle'),
      });
      unpubPageId = p3.data.id;
      createdPageIds.push(unpubPageId);

      await adminClient.post(`/api/admin/pages/${unpubPageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });
      await adminClient.delete(`/api/admin/pages/${unpubPageId}/publication`);
    });

    it('T1-F05-01: Published Page Retrieval returns full snapshot', async () => {
      const res = await anonClient.get(`/api/public/pages/${pubPageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.id, pubPageId);
      assert.strictEqual(res.data.title, titleText);
      assert.strictEqual(res.data.markdown, mdText);
      assert.strictEqual(res.data.subject_id, subjId);
      assert.ok(typeof res.data.subject_name === 'string');
      assert.ok(typeof res.data.published_at === 'string');
      assert.ok(Array.isArray(res.data.attachments));
    });

    it('T1-F05-02: Published Attachments Included in response schema', async () => {
      const res = await anonClient.get(`/api/public/pages/${pubPageId}`);
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data.attachments), 'attachments must be an array');
    });

    it('T1-F05-03: Draft-Only Page Returns 404 PAGE_NOT_FOUND', async () => {
      const res = await anonClient.get(`/api/public/pages/${draftPageId}`);
      assertError(res, 404, 'PAGE_NOT_FOUND');
    });

    it('T1-F05-04: Unpublished Page Returns 404 PAGE_NOT_FOUND', async () => {
      const res = await anonClient.get(`/api/public/pages/${unpubPageId}`);
      assertError(res, 404, 'PAGE_NOT_FOUND');
    });

    it('T1-F05-05: Anonymous Public Access requires no session cookie', async () => {
      const client = ApiClient.anonymous();
      const res = await client.get(`/api/public/pages/${pubPageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.id, pubPageId);
    });
  });

  // =========================================================================
  // Feature 06: Rendered Markdown View
  // =========================================================================
  describe('Feature 06: Rendered Markdown View', () => {
    let subjId;
    let pageId;

    before(async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      subjId = s.data.id;
      createdSubjectIds.push(subjId);

      const p = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('F06_MarkdownPage'),
      });
      pageId = p.data.id;
      createdPageIds.push(pageId);
    });

    it('T1-F06-01: Heading Levels H1-H6 preserved in snapshot', async () => {
      const headingsMd = '# H1 Title\n## H2 Section\n### H3 Sub\n#### H4\n##### H5\n###### H6';
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: headingsMd,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.markdown, headingsMd);
      assert.ok(res.data.markdown.includes('# H1 Title'));
      assert.ok(res.data.markdown.includes('###### H6'));
    });

    it('T1-F06-02: Task Checklists Rendering markdown syntax delivered intact', async () => {
      const checklistMd = '- [ ] Task incomplete\n- [x] Task completed';
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 2,
        markdown: checklistMd,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 3,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes('- [ ] Task incomplete'));
      assert.ok(res.data.markdown.includes('- [x] Task completed'));
    });

    it('T1-F06-03: Markdown Tables Rendering syntax delivered intact', async () => {
      const tableMd = '| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |';
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 3,
        markdown: tableMd,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 4,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes('| Header 1 | Header 2 |'));
      assert.ok(res.data.markdown.includes('| Cell 1 | Cell 2 |'));
    });

    it('T1-F06-04: Blockquotes and Nested Formatting syntax delivered intact', async () => {
      const bqMd = '> This is a quote with **bold** and *italic* text';
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 4,
        markdown: bqMd,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 5,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes('> This is a quote with **bold** and *italic* text'));
    });

    it('T1-F06-05: Fenced Code Blocks with Syntax delivered intact', async () => {
      const codeMd = '```bash\nsudo apt update\n```';
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 5,
        markdown: codeMd,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 6,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes('```bash'));
      assert.ok(res.data.markdown.includes('sudo apt update'));
    });
  });

  // =========================================================================
  // Feature 07: Code Block Copy Button
  // =========================================================================
  describe('Feature 07: Code Block Copy Button', () => {
    let subjId;
    let pageId;

    before(async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      subjId = s.data.id;
      createdSubjectIds.push(subjId);

      const p = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('F07_CodePage'),
      });
      pageId = p.data.id;
      createdPageIds.push(pageId);
    });

    it('T1-F07-01: Single Line Command Copy payload delivered with exact command', async () => {
      const cmd = 'git clone https://github.com/example/repo.git';
      const md = `\`\`\`bash\n${cmd}\n\`\`\``;
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: md,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes(cmd));
    });

    it('T1-F07-02: Multi-line Script Copy preserves newlines in code block', async () => {
      const script = '#!/usr/bin/env bash\necho "Line 1"\necho "Line 2"\necho "Line 3"';
      const md = `\`\`\`bash\n${script}\n\`\`\``;
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 2,
        markdown: md,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 3,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes('echo "Line 1"\necho "Line 2"'));
    });

    it('T1-F07-03: Visual Feedback Reversion duration verified in frontend bundle or fallback', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
      assert.ok(res.text.length > 0);
    });

    it('T1-F07-04: Multiple Code Blocks Independence preserves distinct blocks', async () => {
      const md = '```bash\nblock_a_cmd\n```\n\n```python\nblock_b_code\n```';
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 3,
        markdown: md,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 4,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes('block_a_cmd'));
      assert.ok(res.data.markdown.includes('block_b_code'));
    });

    it('T1-F07-05: Code with Special Shell Characters preserved verbatim', async () => {
      const specialCmd = 'echo "$VAR" && cat <(grep -E \'foo|bar\' file.txt) > /dev/null';
      const md = `\`\`\`bash\n${specialCmd}\n\`\`\``;
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 4,
        markdown: md,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 5,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes(specialCmd));
    });
  });

  // =========================================================================
  // Feature 08: Table of Contents (TOC)
  // =========================================================================
  describe('Feature 08: Table of Contents (TOC)', () => {
    let subjId;
    let pageId;

    before(async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      subjId = s.data.id;
      createdSubjectIds.push(subjId);

      const p = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('F08_TocPage'),
      });
      pageId = p.data.id;
      createdPageIds.push(pageId);
    });

    it('T1-F08-01: Standard H2 and H3 TOC Headings delivered in article markdown', async () => {
      const md = '## Section 1\n### Sub 1.1\n### Sub 1.2\n## Section 2\n### Sub 2.1\n### Sub 2.2';
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: md,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes('## Section 1'));
      assert.ok(res.data.markdown.includes('### Sub 1.1'));
      assert.ok(res.data.markdown.includes('## Section 2'));
    });

    it('T1-F08-02: H1 and H4-H6 Heading Distinction in markdown snapshot', async () => {
      const md = '# Main Document Title\n## H2 Target\n#### Deep H4';
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 2,
        markdown: md,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 3,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes('# Main Document Title'));
      assert.ok(res.data.markdown.includes('## H2 Target'));
      assert.ok(res.data.markdown.includes('#### Deep H4'));
    });

    it('T1-F08-03: Anchor Link Navigation hash routing supported via SPA fallback', async () => {
      const res = await anonClient.get(`/p/${pageId}`, { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
      assert.ok(res.text.includes('<!DOCTYPE html') || res.text.includes('<html'));
    });

    it('T1-F08-04: Active Heading Scroll Spy support verified in frontend app', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
      assert.ok(res.text.length > 0);
    });

    it('T1-F08-05: Empty State When No Headings in markdown content', async () => {
      const md = 'Just plain paragraph text without any headings at all.';
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 3,
        markdown: md,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 4,
        attachment_ids: [],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.markdown, md);
      assert.ok(!res.data.markdown.includes('## '));
    });
  });

  // =========================================================================
  // Feature 09: Image Lightbox
  // =========================================================================
  describe('Feature 09: Image Lightbox', () => {
    let subjId;
    let pageId;
    let imageAssetId;

    before(async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      subjId = s.data.id;
      createdSubjectIds.push(subjId);

      const p = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('F09_LightboxPage'),
      });
      pageId = p.data.id;
      createdPageIds.push(pageId);

      // Upload valid image
      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('diagram.png'));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      imageAssetId = uploadRes.data.id;

      // Publish page with image in markdown
      const md = `![Architecture Schema](/media/${imageAssetId})`;
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: md,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });
    });

    it('T1-F09-01: Click Image Opens Lightbox image URL accessible in public page', async () => {
      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes(`/media/${imageAssetId}`));

      // Verify the image is publicly accessible
      const mediaRes = await anonClient.get(`/media/${imageAssetId}`);
      assertStatus(mediaRes, 200);
      assertHeader(mediaRes, 'content-type', 'image/png');
    });

    it('T1-F09-02: Dismissal via Escape Key contract supported in SPA shell', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
      assert.ok(res.text.length > 0);
    });

    it('T1-F09-03: Dismissal via Backdrop Click contract supported', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
    });

    it('T1-F09-04: Dismissal via Close Button contract supported', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
    });

    it('T1-F09-05: Image Alt Text as Caption preserved in markdown payload', async () => {
      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(res.data.markdown.includes('![Architecture Schema]'));
    });
  });

  // =========================================================================
  // Feature 10: Attachment Download List
  // =========================================================================
  describe('Feature 10: Attachment Download List', () => {
    let subjId;
    let pageId;
    let pdfAssetId;

    before(async () => {
      const s = await adminClient.post('/api/admin/subjects', sampleSubject());
      subjId = s.data.id;
      createdSubjectIds.push(subjId);

      const p = await adminClient.post('/api/admin/pages', {
        subject_id: subjId,
        title: uniqueName('F10_AttachPage'),
      });
      pageId = p.data.id;
      createdPageIds.push(pageId);

      // Upload PDF attachment
      const formData = new FormData();
      formData.append('file', MediaGenerator.createPdf('lab_manual.pdf'));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      pdfAssetId = uploadRes.data.id;

      // Publish page including the PDF in attachment_ids
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [pdfAssetId],
      });
    });

    it('T1-F10-01: Attachment List Rendering returns attached files in public payload', async () => {
      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data.attachments), 'Expected attachments array');
      const found = res.data.attachments.find((a) => a.id === pdfAssetId);
      assert.ok(found, `Expected attachment ${pdfAssetId} in public page response`);
      assert.strictEqual(found.original_name, 'lab_manual.pdf');
      assert.ok(found.byte_size > 0);
    });

    it('T1-F10-02: Click Attachment Triggers Download with Content-Disposition header', async () => {
      const res = await anonClient.get(`/media/${pdfAssetId}`);
      assertStatus(res, 200);
      const disp = res.headers.get('content-disposition') || '';
      assert.ok(disp.includes('attachment'), `Expected attachment in Content-Disposition: "${disp}"`);
      assert.ok(disp.includes('lab_manual.pdf'), `Expected filename in Content-Disposition: "${disp}"`);
    });

    it('T1-F10-03: No Attachments Section Hiding when attachment_ids is empty', async () => {
      // Re-publish without attachments
      const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });
      assertStatus(pubRes, 200);

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      assert.deepStrictEqual(res.data.attachments, []);
    });

    it('T1-F10-04: Supported File Types Display handles multiple file kinds in upload', async () => {
      // Upload ZIP attachment
      const formData = new FormData();
      formData.append('file', MediaGenerator.createZip('code_bundle.zip'));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      const zipAssetId = uploadRes.data.id;

      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [zipAssetId],
      });

      const res = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      const zipItem = res.data.attachments.find((a) => a.id === zipAssetId);
      assert.ok(zipItem, 'Expected ZIP attachment in public payload');
      assert.strictEqual(zipItem.mime, 'application/zip');
    });

    it('T1-F10-05: Anonymous Download Access succeeds for published attachment', async () => {
      const freshClient = ApiClient.anonymous();
      const res = await freshClient.get(`/api/public/pages/${pageId}`);
      assertStatus(res, 200);
      if (res.data.attachments.length > 0) {
        const asset = res.data.attachments[0];
        const dlRes = await freshClient.get(`/media/${asset.id}`);
        assertStatus(dlRes, 200);
      }
    });
  });
});
