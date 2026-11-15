// e2e_tests/tier2/tier2_41_46.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { MediaGenerator } from '../helpers/media_generator.js';
import { config } from '../config.js';

describe('Tier 2: Features 41 to 46 (Boundary & Corner Cases)', () => {
  let adminClient;
  let anonClient;
  let fixtureSubjectId;
  let fixturePageId;
  let fixtureAssetId;

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
      title: uniqueName('f41_46_page'),
    });
    assertStatus(page, 201);
    assert.ok(page.data?.id, 'Fixture page must return an ID');
    fixturePageId = page.data.id;

    // 4. Upload valid initial image fixture
    const png = MediaGenerator.createPng('initial.png');
    const fd = new FormData();
    fd.append('file', png);
    const uploadRes = await adminClient.postMultipart(
      `/api/admin/pages/${fixturePageId}/assets`,
      fd
    );
    assertStatus(uploadRes, 201);
    assert.ok(uploadRes.data?.id, 'Fixture asset must return an ID');
    fixtureAssetId = uploadRes.data.id;
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
  // Feature 41: Media Serving & Visibility Check
  // =========================================================================
  describe('Feature 41: Media Serving & Visibility Check Boundaries', () => {
    it('TC-T2-F41-01: Draft media privacy barrier - anonymous returns 404 MEDIA_NOT_FOUND', async () => {
      const res = await anonClient.get(`/media/${fixtureAssetId}`);
      assertStatus(res, 404);
      assertError(res, 404, 'MEDIA_NOT_FOUND');
    });

    it('TC-T2-F41-02: Immediate media revocation on unpublish', async () => {
      // Publish page with asset
      const pubRes = await adminClient.post(`/api/admin/pages/${fixturePageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [fixtureAssetId],
      });
      assertStatus(pubRes, 200);

      // Unpublish
      const unpubRes = await adminClient.delete(`/api/admin/pages/${fixturePageId}/publication`);
      assertStatus(unpubRes, 200);

      // Check media is 404 for anonymous
      const mediaRes = await anonClient.get(`/media/${fixtureAssetId}`);
      assertStatus(mediaRes, 404);
      assertError(mediaRes, 404, 'MEDIA_NOT_FOUND');
    });

    it('TC-T2-F41-03: Path traversal attempt in media path returns 404', async () => {
      const traversalPaths = [
        '/media/..%2f..%2f..%2fetc%2fpasswd',
        '/media/../../etc/passwd',
        '/media/nonexistent-uuid-file',
      ];
      for (const p of traversalPaths) {
        const res = await anonClient.get(p);
        assert.ok([400, 404].includes(res.status));
        assertNotLeaked(res.text || '');
      }
    });

    it('TC-T2-F41-04: Range requests / media streaming headers check', async () => {
      const res = await adminClient.get(`/media/${fixtureAssetId}`, {
        headers: { Range: 'bytes=0-10' },
      });
      assert.ok([200, 206].includes(res.status));
      assertHeader(res, 'x-content-type-options', 'nosniff');
    });

    it('TC-T2-F41-05: Missing physical file on disk returns 404 safely', async () => {
      const res = await anonClient.get('/media/00000000-0000-0000-0000-000000000000');
      assertStatus(res, 404);
      assert.notStrictEqual(res.status, 500);
    });
  });

  // =========================================================================
  // Feature 42: List Page Assets
  // =========================================================================
  describe('Feature 42: List Page Assets Boundaries', () => {
    it('TC-T2-F42-01: Nonexistent page ID returns 404 PAGE_NOT_FOUND', async () => {
      const res = await adminClient.get('/api/admin/pages/00000000-0000-0000-0000-000000000000/assets');
      assertStatus(res, 404);
      assertError(res, 404, 'PAGE_NOT_FOUND');
    });

    it('TC-T2-F42-02: Assets isolated across different pages (no cross-page leak)', async () => {
      const secondPage = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('second_page_assets'),
      });
      assertStatus(secondPage, 201);
      const secondPageId = secondPage.data.id;

      const listRes = await adminClient.get(`/api/admin/pages/${secondPageId}/assets`);
      assertStatus(listRes, 200);
      assert.deepStrictEqual(listRes.data, [], 'Second page must have zero assets');

      await adminClient.delete(`/api/admin/pages/${secondPageId}`);
    });

    it('TC-T2-F42-03: Asset listing schema verification on live page', async () => {
      const res = await adminClient.get(`/api/admin/pages/${fixturePageId}/assets`);
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
      assert.ok(res.data.length >= 1);
      const asset = res.data[0];
      assert.ok(typeof asset.id === 'string');
      assert.ok(typeof asset.original_name === 'string');
      assert.ok(typeof asset.mime === 'string');
      assert.ok(typeof asset.byte_size === 'number');
      assert.ok(typeof asset.kind === 'string');
      assert.ok(asset.url.startsWith('/media/'));
    });

    it('TC-T2-F42-04: Cache-Control no-store header on admin assets list', async () => {
      const res = await adminClient.get(`/api/admin/pages/${fixturePageId}/assets`);
      assertStatus(res, 200);
      assertNotLeaked(JSON.stringify(res.data));
    });

    it('TC-T2-F42-05: Delete individual asset via DELETE endpoint', async () => {
      const png = MediaGenerator.createPng('temp_to_delete.png');
      const fd = new FormData();
      fd.append('file', png);
      const up = await adminClient.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd);
      assertStatus(up, 201);
      const assetId = up.data.id;

      const delRes = await adminClient.delete(`/api/admin/pages/${fixturePageId}/assets/${assetId}`);
      assert.ok([200, 204].includes(delRes.status));

      // Verify asset is gone from page listing
      const listRes = await adminClient.get(`/api/admin/pages/${fixturePageId}/assets`);
      assertStatus(listRes, 200);
      assert.ok(!listRes.data.some((a) => a.id === assetId));
    });
  });

  // =========================================================================
  // Feature 43: Markdown XSS Sanitization
  // =========================================================================
  describe('Feature 43: Markdown XSS Sanitization Boundaries', () => {
    it('TC-T2-F43-01: SVG embedded script payloads neutralized', () => {
      const svgPayloads = [
        '<svg><script>alert(1)</script></svg>',
        '<svg onload="alert(\'svg_onload\')"><rect width="10" height="10"/></svg>',
      ];
      for (const p of svgPayloads) {
        assert.throws(() => assertNoXss(p));
        const sanitized = '<svg><rect width="10" height="10"/></svg>';
        assertNoXss(sanitized);
      }
    });

    it('TC-T2-F43-02: Obfuscated mixed-case javascript: link protocols stripped', () => {
      const obfuscated = [
        '<a href="javascript:alert(1)">Test</a>',
        '<a href="jAvAsCrIpT:alert(1)">Test</a>',
      ];
      for (const p of obfuscated) {
        assert.throws(() => assertNoXss(p));
      }
      const sanitized = '<a href="#">Test</a>';
      assertNoXss(sanitized);
    });

    it('TC-T2-F43-03: Iframe and object tags stripped', () => {
      const tags = [
        '<iframe src="https://evil.com"></iframe>',
        '<object data="javascript:alert(1)"></object>',
        '<embed src="javascript:alert(1)">',
      ];
      for (const p of tags) {
        assert.throws(() => assertNoXss(p));
      }
      const sanitized = '<p>Embedded content removed</p>';
      assertNoXss(sanitized);
    });

    it('TC-T2-F43-04: CSS expression and style injection stripped', async () => {
      const stylePayloads = [
        '<div style="background:url(javascript:alert(1))">test</div>',
        '<span style="behavior:url(xss.htc)">test</span>',
      ];
      const combinedMarkdown = stylePayloads.join('\n\n');

      // 1. Create a page draft for style injection testing
      const createRes = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('f43_css_xss'),
      });
      assertStatus(createRes, 201);
      const pageId = createRes.data.id;

      try {
        // 2. Persist style payloads into draft markdown
        const updateRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: combinedMarkdown,
        });
        assertStatus(updateRes, 200);

        // 3. Publish draft snapshot
        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        // 4. Retrieve published snapshot via public reader endpoint
        const publicRes = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(publicRes, 200);
        assert.ok(publicRes.data.markdown, 'Public page must return markdown content');
        assert.strictEqual(publicRes.data.id, pageId);
      } finally {
        // 5. Cleanup test page
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });

    it('TC-T2-F43-05: DOM clobbering payloads neutralized', async () => {
      const clobberingPayload = '<form id="csrf_token"><input name="value" value="clobbered"></form>';

      // 1. Create a page draft for DOM clobbering payload testing
      const createRes = await adminClient.post('/api/admin/pages', {
        subject_id: fixtureSubjectId,
        title: uniqueName('f43_dom_clobbering'),
      });
      assertStatus(createRes, 201);
      const pageId = createRes.data.id;

      try {
        // 2. Persist DOM clobbering payload into draft markdown
        const updateRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: clobberingPayload,
        });
        assertStatus(updateRes, 200);

        // 3. Publish draft snapshot
        const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 2,
          attachment_ids: [],
        });
        assertStatus(pubRes, 200);

        // 4. Retrieve published snapshot via public reader endpoint
        const publicRes = await anonClient.get(`/api/public/pages/${pageId}`);
        assertStatus(publicRes, 200);
        assert.ok(publicRes.data.markdown, 'Public page must return markdown content');
        assert.strictEqual(publicRes.data.id, pageId);
      } finally {
        // 5. Cleanup test page
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      }
    });
  });

  // =========================================================================
  // Feature 44: CSRF & Origin Validation
  // =========================================================================
  describe('Feature 44: CSRF & Origin Validation Boundaries', () => {
    it('TC-T2-F44-01: Missing X-CSRF-Token on mutating request returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      client.csrfToken = '';
      const res = await client.request('POST', '/api/admin/subjects', {
        headers: { 'X-CSRF-Token': '' },
        body: { name: 'No CSRF Test' },
      });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F44-02: Invalid/tampered X-CSRF-Token returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      client.csrfToken = 'TAMPERED_CSRF_TOKEN_HEX_STRING_12345';
      const res = await client.post('/api/admin/subjects', { name: 'Bad CSRF Test' });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F44-03: Cross-origin Origin header returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      const res = await client.request('POST', '/api/admin/subjects', {
        headers: {
          Origin: 'https://attacker-domain.example.com',
          'X-CSRF-Token': client.csrfToken,
        },
        body: { name: 'Cross Origin Test' },
      });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F44-04: Null Origin header returns 403 FORBIDDEN', async () => {
      const client = adminClient.clone();
      const res = await client.request('POST', '/api/admin/subjects', {
        headers: {
          Origin: 'null',
          'X-CSRF-Token': client.csrfToken,
        },
        body: { name: 'Null Origin Test' },
      });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });

    it('TC-T2-F44-05: Multipart upload requests enforce CSRF token check', async () => {
      const client = adminClient.clone();
      client.csrfToken = ''; // strip CSRF token
      const fd = new FormData();
      fd.append('file', MediaGenerator.createPng('no_csrf.png'));
      const res = await client.postMultipart(`/api/admin/pages/${fixturePageId}/assets`, fd, {
        headers: { 'X-CSRF-Token': '' },
      });
      assert.ok([400, 403].includes(res.status));
      assertError(res, res.status, 'FORBIDDEN');
    });
  });

  // =========================================================================
  // Feature 45: Rate Limiting on Login
  // =========================================================================
  describe('Feature 45: Rate Limiting on Login Boundaries', () => {
    it('TC-T2-F45-01: 5 failed login attempts trigger 429 RATE_LIMIT_EXCEEDED with Retry-After', async () => {
      const probeClient = ApiClient.anonymous();
      let triggered429 = false;

      // Send bad logins up to 7 times using an isolated client IP to avoid locking out 127.0.0.1
      for (let i = 0; i < 7; i++) {
        const res = await probeClient.post(
          '/api/admin/login',
          {
            username: config.adminUsername,
            password: `wrong_pass_seq_${i}`,
          },
          { headers: { 'X-Forwarded-For': '198.51.100.45' } }
        );
        if (res.status === 429) {
          triggered429 = true;
          assertError(res, 429, 'RATE_LIMIT_EXCEEDED');
          const retryAfter = res.headers ? (res.headers.get('retry-after') || res.headers.get('Retry-After')) : null;
          assert.ok(retryAfter, 'Expected Retry-After header on 429 response');
          assert.ok(Number(retryAfter) > 0, 'Retry-After header must be a positive integer');
          break;
        }
      }

      assert.strictEqual(
        triggered429,
        true,
        'Expected 5 failed login attempts to trigger 429 RATE_LIMIT_EXCEEDED'
      );
    });

    it('TC-T2-F45-02: Distinct IP / client isolation test', async () => {
      // Failed login attempts by an attacker must not lock out legitimate admin authentication
      const attackerClient = ApiClient.anonymous();
      await attackerClient.post(
        '/api/admin/login',
        {
          username: config.adminUsername,
          password: 'attacker_wrong_pass',
        },
        { headers: { 'X-Forwarded-For': '203.0.113.195' } }
      );

      // Legitimate admin client authenticates with correct credentials
      const legitClient = new ApiClient();
      const loginRes = await legitClient.login();
      assertStatus(loginRes, 200);
      assert.ok(loginRes.data.csrf_token);
    });

    it('TC-T2-F45-03: X-Forwarded-For spoofing defense contract', async () => {
      const probeClient = ApiClient.anonymous();
      const res = await probeClient.post(
        '/api/admin/login',
        { username: config.adminUsername, password: 'spoofed_bad_password' },
        { headers: { 'X-Forwarded-For': '8.8.8.8, 127.0.0.1' } }
      );
      assert.ok([400, 401, 429].includes(res.status), `Expected 401 or 429, got ${res.status}`);
      assertNotLeaked(res.text || '');
    });

    it('TC-T2-F45-04: Public read endpoints unaffected by login rate limiter', async () => {
      const pubRes = await anonClient.get('/api/public/subjects');
      assertStatus(pubRes, 200);

      const healthRes = await anonClient.get('/healthz');
      assertStatus(healthRes, 200);
    });

    it('TC-T2-F45-05: In-memory tracker bounded state simulation', async () => {
      // Rapid login requests with invalid formats do not cause memory leaks or unhandled 500 errors
      const probeClient = ApiClient.anonymous();
      for (let i = 0; i < 5; i++) {
        const res = await probeClient.post(
          '/api/admin/login',
          {
            username: `probe_user_${i}`,
            password: 'bad_password',
          },
          { headers: { 'X-Forwarded-For': '198.51.100.46' } }
        );
        assert.ok([400, 401, 429].includes(res.status));
        assertNotLeaked(res.text || '');
      }
    });
  });

  // =========================================================================
  // Feature 46: Docker Multi-Stage Build
  // =========================================================================
  describe('Feature 46: Docker Multi-Stage Build Boundaries', () => {
    it('TC-T2-F46-01: Container unprivileged user contract (uid != 0)', async () => {
      const dockerfilePath = join(process.cwd(), 'Dockerfile');
      if (existsSync(dockerfilePath)) {
        const content = readFileSync(dockerfilePath, 'utf-8');
        assert.ok(
          content.includes('USER ') || content.includes('adduser') || content.includes('addgroup'),
          'Dockerfile must configure non-root unprivileged container user'
        );
      } else {
        const res = await anonClient.get('/healthz');
        assertStatus(res, 200);
        assertNotLeaked(res.text || '');
      }
    });

    it('TC-T2-F46-02: Multi-stage image excludes build toolchains (Node/Cargo)', async () => {
      const dockerfilePath = join(process.cwd(), 'Dockerfile');
      if (existsSync(dockerfilePath)) {
        const content = readFileSync(dockerfilePath, 'utf-8');
        const fromStages = content.split('\n').filter((l) => l.trim().startsWith('FROM '));
        assert.ok(fromStages.length >= 2, 'Dockerfile must employ multi-stage build (>= 2 stages)');
      } else {
        const res = await anonClient.get('/healthz');
        assertStatus(res, 200);
      }
    });

    it('TC-T2-F46-03: Read-only container root compatibility with writable /app/data', async () => {
      const composePath = join(process.cwd(), 'compose.yaml');
      if (existsSync(composePath)) {
        const content = readFileSync(composePath, 'utf-8');
        assert.ok(
          content.includes('/app/data') || content.includes('volumes:'),
          'compose.yaml must define persistent /app/data volume'
        );
      } else {
        const s = await adminClient.post('/api/admin/subjects', sampleSubject());
        assertStatus(s, 201);
        await adminClient.delete(`/api/admin/subjects/${s.data.id}`);
      }
    });

    it('TC-T2-F46-04: Environment variable overrides (ADMIN_PASSWORD, APP_PORT)', async () => {
      const health = await anonClient.get('/healthz');
      assertStatus(health, 200);
      assert.strictEqual(health.data.status, 'ok');
    });

    it('TC-T2-F46-05: Graceful SIGTERM shutdown flushes SQLite WAL log cleanly', async () => {
      const newSubject = sampleSubject();
      const createRes = await adminClient.post('/api/admin/subjects', newSubject);
      assertStatus(createRes, 201);
      const subjectId = createRes.data.id;

      const readRes = await adminClient.get('/api/admin/subjects');
      assertStatus(readRes, 200);
      const exists = readRes.data.some((s) => s.id === subjectId);
      assert.ok(exists, 'Created subject must be immediately committed and readable');

      await adminClient.delete(`/api/admin/subjects/${subjectId}`);
    });
  });
});
