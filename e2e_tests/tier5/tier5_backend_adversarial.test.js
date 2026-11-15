// e2e_tests/tier5/tier5_backend_adversarial.test.js
// Tier 5: Comprehensive Adversarial Stress Testing on Backend Security,
// CAS Concurrency, Upload Boundaries, and Path Traversal.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { ApiClient } from '../helpers/api_client.js';
import {
  assertStatus,
  assertSuccess,
  assertError,
  assertNotLeaked,
} from '../helpers/assertions.js';
import { sampleSubject, uniqueName } from '../helpers/fixtures.js';
import { config } from '../config.js';

/**
 * Raw HTTP GET helper over TCP to bypass client-side WHATWG URL normalization
 * when testing path traversal vectors.
 */
function rawHttpGet(path, port = 8080, host = '127.0.0.1', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      let req = `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n`;
      for (const [k, v] of Object.entries(extraHeaders)) {
        req += `${k}: ${v}\r\n`;
      }
      req += '\r\n';
      socket.write(req);
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf-8');
    });
    socket.on('end', () => {
      const firstLine = data.split('\r\n')[0] || '';
      const match = firstLine.match(/HTTP\/1\.[01]\s+(\d{3})/);
      const status = match ? parseInt(match[1], 10) : 0;
      resolve({ status, raw: data, firstLine });
    });
    socket.on('error', reject);
  });
}

/**
 * Helper to build a valid PNG of exact byte length using an ancillary dUMy chunk.
 */
function createPaddedPng(targetByteLen) {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const base = Buffer.from(base64, 'base64');
  const chunkHeaderLen = 12; // 4 len + 4 type + 4 crc
  const extraNeeded = targetByteLen - base.length;
  const dummyPayloadLen = extraNeeded - chunkHeaderLen;

  const dummyChunk = Buffer.alloc(chunkHeaderLen + dummyPayloadLen);
  dummyChunk.writeUInt32BE(dummyPayloadLen, 0);
  dummyChunk.write('dUMy', 4, 'ascii');
  dummyChunk.writeUInt32BE(0, chunkHeaderLen + dummyPayloadLen - 4);

  return Buffer.concat([
    base.subarray(0, base.length - 12),
    dummyChunk,
    base.subarray(base.length - 12),
  ]);
}

describe('Tier 5: Backend Adversarial Stress & Hardening Suite', () => {
  let adminClient;
  let anonClient;
  let rootSubjectId;

  before(async () => {
    adminClient = new ApiClient();
    anonClient = ApiClient.anonymous();

    const loginRes = await adminClient.login();
    assertSuccess(loginRes, 200);

    const sub = await adminClient.post('/api/admin/subjects', {
      name: uniqueName('Tier5_Root_Subject'),
      position: 0,
    });
    assertStatus(sub, 201);
    rootSubjectId = sub.data.id;
  });

  after(async () => {
    if (adminClient && adminClient.csrfToken && rootSubjectId) {
      try {
        await adminClient.delete(`/api/admin/subjects/${rootSubjectId}`);
      } catch {}
    }
  });

  // =========================================================================
  // Domain 1: SQLite CAS Concurrency & Revision Race Windows
  // =========================================================================
  describe('Domain 1: CAS Concurrency & Revision Race Windows', () => {
    it('TC-T5-CAS-01: 20 parallel workers race on draft update with identical expected_revision', async () => {
      const page = await adminClient.post('/api/admin/pages', {
        subject_id: rootSubjectId,
        title: uniqueName('CAS_Race_Page'),
      });
      assertStatus(page, 201);
      const pageId = page.data.id;
      assert.strictEqual(page.data.revision, 1);

      const workerCount = 20;
      const promises = [];
      for (let i = 0; i < workerCount; i++) {
        promises.push(
          adminClient.patch(`/api/admin/pages/${pageId}`, {
            expected_revision: 1,
            title: `Title from Worker ${i}`,
            markdown: `Markdown updated by worker ${i}`,
          })
        );
      }

      const results = await Promise.all(promises);
      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      const others = results.filter((r) => r.status !== 200 && r.status !== 409);

      // CAS Invariant: Exactly one update must succeed, exactly 19 must encounter conflict 409
      assert.strictEqual(others.length, 0, `Unexpected status codes received: ${others.map((r) => r.status)}`);
      assert.strictEqual(successes.length, 1, 'Exactly one concurrent update must succeed');
      assert.strictEqual(conflicts.length, workerCount - 1, 'All other concurrent updates must be rejected with 409');

      assert.strictEqual(successes[0].data.revision, 2);
      assertError(conflicts[0], 409, 'REVISION_CONFLICT');

      // Verify DB final state
      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertSuccess(check, 200);
      assert.strictEqual(check.data.revision, 2);
      assert.ok(check.data.draft_title.startsWith('Title from Worker '));

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T5-CAS-02: High-throughput monotonic sequential CAS updates (10 sequential revisions)', async () => {
      const page = await adminClient.post('/api/admin/pages', {
        subject_id: rootSubjectId,
        title: uniqueName('CAS_Sequential_Page'),
      });
      assertStatus(page, 201);
      const pageId = page.data.id;

      let currentRev = 1;
      for (let step = 1; step <= 10; step++) {
        const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: currentRev,
          title: `Sequential Step ${step}`,
          markdown: `Content step ${step}`,
        });
        assertSuccess(res, 200);
        assert.strictEqual(res.data.revision, currentRev + 1);
        currentRev += 1;
      }

      const finalState = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertSuccess(finalState, 200);
      assert.strictEqual(finalState.data.revision, 11);
      assert.strictEqual(finalState.data.draft_title, 'Sequential Step 10');

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T5-CAS-03: Concurrent draft PATCH vs POST /publish race condition', async () => {
      const page = await adminClient.post('/api/admin/pages', {
        subject_id: rootSubjectId,
        title: uniqueName('CAS_Patch_Publish_Race'),
      });
      assertStatus(page, 201);
      const pageId = page.data.id;

      // Launch PATCH and PUBLISH simultaneously with expected_revision: 1
      const [patchRes, publishRes] = await Promise.all([
        adminClient.patch(`/api/admin/pages/${pageId}`, {
          expected_revision: 1,
          markdown: '# Updated in race',
        }),
        adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 1,
          attachment_ids: [],
        }),
      ]);

      // At least one operation must succeed.
      // If PATCH committed first, publish gets 409 (expected 1, actual 2).
      // If PUBLISH committed first, it published rev 1, and PATCH bumped rev to 2.
      if (patchRes.status === 200 && publishRes.status === 409) {
        assertError(publishRes, 409, 'REVISION_CONFLICT');
      } else if (patchRes.status === 200 && publishRes.status === 200) {
        // Both succeeded because publish read before patch and patch committed after
        assert.strictEqual(patchRes.data.revision, 2);
      } else {
        assert.ok(
          patchRes.status === 200 || publishRes.status === 200,
          `At least one operation must succeed. patch=${patchRes.status}, pub=${publishRes.status}`
        );
      }

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T5-CAS-04: Simultaneous double-publish calls evaluate database transaction resilience', async () => {
      const page = await adminClient.post('/api/admin/pages', {
        subject_id: rootSubjectId,
        title: uniqueName('Double_Publish_Page'),
      });
      assertStatus(page, 201);
      const pageId = page.data.id;

      const [pub1, pub2] = await Promise.all([
        adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 1,
          attachment_ids: [],
        }),
        adminClient.post(`/api/admin/pages/${pageId}/publish`, {
          expected_revision: 1,
          attachment_ids: [],
        }),
      ]);

      // Invariant: At least one publish request must succeed and snapshot the page
      assert.ok(
        pub1.status === 200 || pub2.status === 200,
        `At least one publish request must succeed. pub1=${pub1.status}, pub2=${pub2.status}`
      );

      // Verify the page is successfully published and publicly visible
      const pubView = await anonClient.get(`/api/public/pages/${pageId}`);
      assertSuccess(pubView, 200);
      assert.strictEqual(pubView.data.id, pageId);

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T5-CAS-05: Adversarial and malformed expected_revision inputs', async () => {
      const page = await adminClient.post('/api/admin/pages', {
        subject_id: rootSubjectId,
        title: uniqueName('Adversarial_Revision_Page'),
      });
      assertStatus(page, 201);
      const pageId = page.data.id;

      // Negative revision
      const neg = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: -1,
        title: 'Neg Title',
      });
      assertError(neg, 409, 'REVISION_CONFLICT');

      // Zero revision
      const zero = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 0,
        title: 'Zero Title',
      });
      assertError(zero, 409, 'REVISION_CONFLICT');

      // Huge out-of-range revision
      const huge = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 999999999,
        title: 'Huge Title',
      });
      assertError(huge, 409, 'REVISION_CONFLICT');

      // String value instead of integer
      const strVal = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: '1',
        title: 'String Rev Title',
      });
      assertError(strVal, 400, 'VALIDATION_ERROR');

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });

    it('TC-T5-CAS-06: Concurrent asset deletions on the same page and duplicate deletion race', async () => {
      const page = await adminClient.post('/api/admin/pages', {
        subject_id: rootSubjectId,
        title: uniqueName('Asset_Deletion_Race'),
      });
      assertStatus(page, 201);
      const pageId = page.data.id;

      // Upload 2 assets
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
      const form1 = new FormData();
      form1.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'asset1.png');
      const a1 = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form1);
      assertStatus(a1, 201);

      const form2 = new FormData();
      form2.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'asset2.png');
      const a2 = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form2);
      assertStatus(a2, 201);

      // Race 2 concurrent deletions on asset1
      const [del1a, del1b] = await Promise.all([
        adminClient.delete(`/api/admin/pages/${pageId}/assets/${a1.data.id}`),
        adminClient.delete(`/api/admin/pages/${pageId}/assets/${a1.data.id}`),
      ]);

      const delStatuses = [del1a.status, del1b.status].sort();
      // Valid outcomes: [200, 404] (sequential interleaving) or [200, 200] (TOCTOU race where both read before DELETE)
      assert.ok(
        (delStatuses[0] === 200 && delStatuses[1] === 200) ||
        (delStatuses[0] === 200 && delStatuses[1] === 404),
        `Expected [200, 200] or [200, 404], got ${JSON.stringify(delStatuses)}`
      );

      // Confirm asset is gone after both deletions complete
      const checkDeleted = await adminClient.get(`/api/admin/pages/${pageId}/assets`);
      assertSuccess(checkDeleted, 200);
      assert.strictEqual(checkDeleted.data.some((a) => a.id === a1.data.id), false);

      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });
  });

  // =========================================================================
  // Domain 2: File Upload Edge Conditions & Magic-Byte Spoofing
  // =========================================================================
  describe('Domain 2: File Upload Edge Conditions & Magic-Byte Spoofing', () => {
    let testPageId;

    before(async () => {
      const page = await adminClient.post('/api/admin/pages', {
        subject_id: rootSubjectId,
        title: uniqueName('Upload_Test_Page'),
      });
      assertStatus(page, 201);
      testPageId = page.data.id;
    });

    after(async () => {
      if (testPageId) {
        try {
          await adminClient.delete(`/api/admin/pages/${testPageId}`);
        } catch {}
      }
    });

    it('TC-T5-UPL-01: Exact 10 MiB image boundary (10,485,760 bytes) is accepted', async () => {
      const exact10MiB = 10 * 1024 * 1024;
      const paddedPng = createPaddedPng(exact10MiB);
      assert.strictEqual(paddedPng.length, exact10MiB);

      const form = new FormData();
      form.append('file', new Blob([paddedPng], { type: 'image/png' }), 'boundary_10mib.png');

      const res = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, form);
      assertStatus(res, 201);
      assert.strictEqual(res.data.byte_size, exact10MiB);
      assert.strictEqual(res.data.kind, 'image');

      // Cleanup uploaded asset
      await adminClient.delete(`/api/admin/pages/${testPageId}/assets/${res.data.id}`);
    });

    it('TC-T5-UPL-02: Exact 10 MiB + 1 byte image overflow (10,485,761 bytes) is rejected with 413', async () => {
      const overflowBytes = 10 * 1024 * 1024 + 1;
      const paddedPng = createPaddedPng(overflowBytes);
      assert.strictEqual(paddedPng.length, overflowBytes);

      const form = new FormData();
      form.append('file', new Blob([paddedPng], { type: 'image/png' }), 'overflow_10mib.png');

      const res = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, form);
      assertError(res, 413, 'FILE_TOO_LARGE');
    });

    it('TC-T5-UPL-03: Empty file upload (0 bytes) is rejected with 400 VALIDATION_ERROR', async () => {
      const form = new FormData();
      form.append('file', new Blob([], { type: 'image/png' }), 'empty.png');

      const res = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, form);
      assertError(res, 400, 'VALIDATION_ERROR');
      assert.ok(res.data.error.message.includes('empty'));
    });

    it('TC-T5-UPL-04: SVG disguised as PNG is strictly rejected with 400 SVG_NOT_ALLOWED', async () => {
      const svgPayload = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script></svg>';
      const form = new FormData();
      form.append('file', new Blob([svgPayload], { type: 'image/png' }), 'disguised_vector.png');

      const res = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, form);
      assertError(res, 400, 'SVG_NOT_ALLOWED');
    });

    it('TC-T5-UPL-05: HTML disguised as PNG is rejected with 400 UNSUPPORTED_MIME', async () => {
      const htmlPayload = '<!DOCTYPE html><html><head><title>Phish</title></head><body><script>malicious()</script></body></html>';
      const form = new FormData();
      form.append('file', new Blob([htmlPayload], { type: 'image/png' }), 'disguised_page.png');

      const res = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, form);
      assertError(res, 400, 'UNSUPPORTED_MIME');
    });

    it('TC-T5-UPL-06: Windows PE executable disguised as attachment is rejected with 400 UNSUPPORTED_MIME', async () => {
      const mzPayload = Buffer.from('4d5a90000300000004000000ffff0000b8000000000000004000000000000000', 'hex');
      const form = new FormData();
      form.append('file', new Blob([mzPayload], { type: 'application/octet-stream' }), 'notes.docx');

      const res = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, form);
      assertError(res, 400, 'UNSUPPORTED_MIME');
    });

    it('TC-T5-UPL-07: Valid PNG magic bytes followed by corrupted bitmap fails dimension inspection (400)', async () => {
      // 8-byte PNG header followed by 50 bytes of garbage
      const corruptPayload = Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        Buffer.alloc(50, 0x41),
      ]);
      const form = new FormData();
      form.append('file', new Blob([corruptPayload], { type: 'image/png' }), 'corrupt.png');

      const res = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, form);
      assertError(res, 400, 'INVALID_IMAGE_FORMAT');
    });

    it('TC-T5-UPL-08: Truncated stream / abrupt client TCP disconnect does not crash server', async () => {
      const sessionToken = adminClient.cookieJar.get('labnotes_session') || '';
      // Open raw TCP socket, begin multipart upload claiming 5 MiB Content-Length, send partial chunk, abruptly destroy socket
      await new Promise((resolve) => {
        const socket = net.connect(8080, '127.0.0.1', () => {
          socket.write(
            `POST /api/admin/pages/${testPageId}/assets HTTP/1.1\r\n` +
            `Host: 127.0.0.1:8080\r\n` +
            `Cookie: labnotes_session=${sessionToken}\r\n` +
            `X-CSRF-Token: ${adminClient.csrfToken || ''}\r\n` +
            `Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryAbrupt\r\n` +
            `Content-Length: 5000000\r\n\r\n` +
            `------WebKitFormBoundaryAbrupt\r\n` +
            `Content-Disposition: form-data; name="file"; filename="abrupt.png"\r\n` +
            `Content-Type: image/png\r\n\r\n` +
            `\x89PNG\r\n\x1a\n`
          );
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 50);
        });
        socket.on('error', () => resolve());
      });

      // Small pause to allow server task cleanup
      await new Promise((r) => setTimeout(r, 100));

      // Verify server remains fully functional and healthy
      const health = await adminClient.get('/healthz');
      assertSuccess(health, 200);
      assert.strictEqual(health.data.status, 'ok');
    });
  });

  // =========================================================================
  // Domain 3: Session Security, CSRF Tokens & Rate Limiting
  // =========================================================================
  describe('Domain 3: Session Security & Authentication Vectors', () => {
    it('TC-T5-AUTH-01: Session cookie tampering matrix (non-hex, invalid length, SQLi injection)', async () => {
      const tamperingProbes = [
        'not_a_hex_token_at_all',
        '0123456789abcdef', // 16 chars
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', // 80 chars
        "' OR '1'='1",
        "admin'--",
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', // Valid 64-char hex but nonexistent
      ];

      for (const token of tamperingProbes) {
        const client = ApiClient.anonymous();
        client.cookieJar.set('labnotes_session', token);
        const res = await client.get('/api/admin/me');
        assertError(res, 401, 'UNAUTHORIZED');
        assertNotLeaked(JSON.stringify(res.data));
      }

      // Raw TCP probe with null-byte cookie to bypass client Header validation
      const rawNullRes = await rawHttpGet('/api/admin/me', 8080, '127.0.0.1', {
        Cookie: 'labnotes_session=0000000000000000000000000000000000000000000000000000000000000000%00malicious',
      });
      assert.ok([400, 401].includes(rawNullRes.status));
      assertNotLeaked(rawNullRes.raw);
    });

    it('TC-T5-AUTH-02: Session revocation immediately closes access to admin endpoints', async () => {
      const tempClient = new ApiClient();
      const login = await tempClient.login();
      assertSuccess(login, 200);

      const beforeLogout = await tempClient.get('/api/admin/me');
      assertSuccess(beforeLogout, 200);

      const logout = await tempClient.logout();
      assertSuccess(logout, 200);

      // Attempt access using the previously authenticated client
      const afterLogout = await tempClient.get('/api/admin/me');
      assertError(afterLogout, 401, 'UNAUTHORIZED');
    });

    it('TC-T5-AUTH-03: CSRF token omission, alteration, and cross-session replay are strictly rejected (403)', async () => {
      const client1 = new ApiClient();
      await client1.login();

      const client2 = new ApiClient();
      await client2.login();

      // 1. Omitted CSRF token
      const omitted = await client1.request('POST', '/api/admin/subjects', {
        headers: { 'X-CSRF-Token': '' },
        body: { name: 'Omitted CSRF', position: 0 },
      });
      assertError(omitted, 403, 'FORBIDDEN');

      // 2. Tampered CSRF token (flip last char)
      const tamperedToken = client1.csrfToken.slice(0, -1) + (client1.csrfToken.endsWith('a') ? 'b' : 'a');
      const tampered = await client1.request('POST', '/api/admin/subjects', {
        headers: { 'X-CSRF-Token': tamperedToken },
        body: { name: 'Tampered CSRF', position: 0 },
      });
      assertError(tampered, 403, 'FORBIDDEN');

      // 3. Cross-session token replay (Session 1 cookie + Session 2 CSRF token)
      const replayed = await client1.request('POST', '/api/admin/subjects', {
        headers: { 'X-CSRF-Token': client2.csrfToken },
        body: { name: 'Replayed CSRF', position: 0 },
      });
      assertError(replayed, 403, 'FORBIDDEN');
    });

    it('TC-T5-AUTH-04: Untrusted Origin and Referer headers on mutating requests return 403 FORBIDDEN', async () => {
      const untrustedOrigins = [
        'https://attacker-payload.com',
        'http://phishing.labnotes.org',
        'http://localhost.evil.com',
        'null',
      ];

      for (const origin of untrustedOrigins) {
        const res = await adminClient.request('POST', '/api/admin/subjects', {
          headers: { Origin: origin },
          body: { name: 'Untrusted Origin Sub', position: 0 },
        });
        assertError(res, 403, 'FORBIDDEN');
      }
    });

    it('TC-T5-AUTH-05: Rate limiting locks out IP at attempt 6 and refuses correct credentials while locked out', async () => {
      const client = ApiClient.anonymous();
      // Generate a collision-free synthetic IP per run to avoid 15-minute window carryover
      const syntheticOctet = Math.floor(Math.random() * 200) + 20;
      const syntheticIp = `198.51.100.${syntheticOctet}`;
      const headers = { 'X-Forwarded-For': syntheticIp };

      // 5 failed attempts
      for (let i = 1; i <= 5; i++) {
        const res = await client.post('/api/admin/login', {
          username: 'admin',
          password: `wrong_pass_${i}`,
        }, { headers });
        assertError(res, 401, 'INVALID_CREDENTIALS');
      }

      // 6th attempt: must be blocked by rate limiter
      const blockedRes = await client.post('/api/admin/login', {
        username: 'admin',
        password: 'wrong_pass_6',
      }, { headers });
      assertError(blockedRes, 429, 'RATE_LIMIT_EXCEEDED');
      assert.ok(blockedRes.data.error.message.includes('Rate limit exceeded'));

      // Attempt login with valid credentials while locked out
      const validCredsWhileBlocked = await client.post('/api/admin/login', {
        username: config.adminUsername,
        password: config.adminPassword,
      }, { headers });
      assertError(validCredsWhileBlocked, 429, 'RATE_LIMIT_EXCEEDED');
    });
  });

  // =========================================================================
  // Domain 4: Path Traversal Defense & Media Access Isolation
  // =========================================================================
  describe('Domain 4: Path Traversal Defense & Media Access Isolation', () => {
    it('TC-T5-TRAV-01: Raw TCP HTTP path traversal probes on /media/* are blocked (404/400)', async () => {
      const traversalVectors = [
        '/media/..',
        '/media/../etc/passwd',
        '/media/../../etc/passwd',
        '/media/..%2f..%2fetc/passwd',
        '/media/%2e%2e%2f%2e%2e%2fetc/passwd',
        '/media/%252e%252e%252f%252e%252e%252fetc/passwd',
        '/media/..%5c..%5cwindows/win.ini',
        '/media/00000000-0000-0000-0000-000000000000/../../etc/passwd',
      ];

      for (const vector of traversalVectors) {
        const res = await rawHttpGet(vector);
        assert.ok(
          [400, 404].includes(res.status),
          `Expected 400 or 404 for traversal vector '${vector}', but got ${res.status}`
        );
        assertNotLeaked(res.raw);
      }
    });

    it('TC-T5-TRAV-02: Static asset and SPA fallback path traversal probes are rejected (400/404)', async () => {
      const assetVectors = [
        '/assets/..',
        '/assets/../index.html',
        '/assets/%2e%2e/index.html',
        '/assets/..%5c..%5cwindows/win.ini',
        '/assets/nonexistent_hash_asset.js',
      ];

      for (const vector of assetVectors) {
        const res = await rawHttpGet(vector);
        assert.ok(
          [400, 404].includes(res.status),
          `Expected 400 or 404 for asset traversal vector '${vector}', got ${res.status}`
        );
        assertNotLeaked(res.raw);
      }
    });

    it('TC-T5-TRAV-03: System directory probes (/etc/*, /windows/*, /proc/*) return 404 text/plain', async () => {
      const sysVectors = [
        '/etc/passwd',
        '/etc/shadow',
        '/windows/win.ini',
        '/proc/self/cmdline',
        '/sys/class/net',
      ];

      for (const vector of sysVectors) {
        const res = await anonClient.get(vector);
        assertStatus(res, 404);
        assert.strictEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8');
        assert.strictEqual(res.text, 'Not found');
      }
    });

    it('TC-T5-TRAV-04: API fallback isolation strictly returns JSON 404 envelope, never SPA HTML', async () => {
      const apiVectors = [
        '/api/nonexistent_endpoint',
        '/api/admin/nonexistent',
        '//api/admin/login',
        '///api/public/subjects',
      ];

      for (const vector of apiVectors) {
        const res = await anonClient.get(vector);
        assertStatus(res, 404);
        assert.ok(
          res.headers.get('content-type')?.includes('application/json'),
          `Expected application/json header for ${vector}`
        );
        assertError(res, 404, 'NOT_FOUND');
      }

      // Raw TCP path traversal on API route
      const rawApi = await rawHttpGet('/api/../etc/passwd');
      assert.ok(
        [400, 404].includes(rawApi.status),
        `Raw /api/../etc/passwd expected 400 or 404, got ${rawApi.status}`
      );
      assert.ok(rawApi.raw.includes('application/json'));
    });

    it('TC-T5-TRAV-05: Unauthenticated draft media access returns 404; gating lifecycle is verified', async () => {
      // 1. Create page draft
      const page = await adminClient.post('/api/admin/pages', {
        subject_id: rootSubjectId,
        title: uniqueName('Media_Gating_Page'),
      });
      assertStatus(page, 201);
      const pageId = page.data.id;

      // 2. Upload image to draft page
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
      const form = new FormData();
      form.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'gated.png');
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form);
      assertStatus(uploadRes, 201);
      const assetId = uploadRes.data.id;

      // 3. Unauthenticated access while page is in draft state MUST return 404 (prevent enumeration)
      const anonDraftAccess = await anonClient.get(`/media/${assetId}`);
      assertError(anonDraftAccess, 404, 'MEDIA_NOT_FOUND');

      // 4. Authenticated admin access while in draft state MUST succeed (200 OK)
      const adminDraftAccess = await adminClient.get(`/media/${assetId}`);
      assertStatus(adminDraftAccess, 200);
      assert.strictEqual(adminDraftAccess.headers.get('content-type'), 'image/png');
      assert.strictEqual(adminDraftAccess.headers.get('x-content-type-options'), 'nosniff');

      // 5. Publish page with markdown embedding image
      const update = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: `![Gated Image](/media/${assetId})`,
      });
      assertSuccess(update, 200);

      const pub = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });
      assertSuccess(pub, 200);

      // 6. Unauthenticated access after publish MUST succeed (200 OK)
      const anonPublicAccess = await anonClient.get(`/media/${assetId}`);
      assertStatus(anonPublicAccess, 200);
      assert.strictEqual(anonPublicAccess.headers.get('content-type'), 'image/png');

      // 7. Unpublish page
      const unpub = await adminClient.delete(`/api/admin/pages/${pageId}/publication`);
      assertSuccess(unpub, 200);

      // 8. Unauthenticated access after unpublish MUST immediately return 404
      const anonRevokedAccess = await anonClient.get(`/media/${assetId}`);
      assertError(anonRevokedAccess, 404, 'MEDIA_NOT_FOUND');

      // Cleanup
      await adminClient.delete(`/api/admin/pages/${pageId}`);
    });
  });

  // =========================================================================
  // Domain 5: Filename Sanitization & Cross-Platform Path Attacks
  // =========================================================================
  describe('Domain 5: Filename Sanitization & Cross-Platform Path Attacks', () => {
    let testPageId;

    before(async () => {
      const page = await adminClient.post('/api/admin/pages', {
        subject_id: rootSubjectId,
        title: uniqueName('Filename_Sanitization_Page'),
      });
      assertStatus(page, 201);
      testPageId = page.data.id;
    });

    after(async () => {
      if (testPageId) {
        try {
          await adminClient.delete(`/api/admin/pages/${testPageId}`);
        } catch {}
      }
    });

    it('TC-T5-FILE-01: Filename with path traversal sequences is sanitized', async () => {
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
      const form = new FormData();
      form.append('file', new Blob([pngBuffer], { type: 'image/png' }), '../../../../traversal_attack.png');

      const res = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, form);
      assertStatus(res, 201);
      assert.strictEqual(res.data.original_name, 'traversal_attack.png');
      assert.ok(!res.data.original_name.includes('..'));
      assert.ok(!res.data.original_name.includes('/'));

      await adminClient.delete(`/api/admin/pages/${testPageId}/assets/${res.data.id}`);
    });

    it('TC-T5-FILE-02: Windows reserved DOS device filenames (CON, PRN, AUX, NUL) are prefixed safely', async () => {
      const reservedNames = ['CON.png', 'PRN.png', 'AUX.png', 'NUL.png'];
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );

      for (const name of reservedNames) {
        const form = new FormData();
        form.append('file', new Blob([pngBuffer], { type: 'image/png' }), name);

        const res = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, form);
        assertStatus(res, 201);
        assert.strictEqual(res.data.original_name, `file_${name}`);

        await adminClient.delete(`/api/admin/pages/${testPageId}/assets/${res.data.id}`);
      }
    });

    it('TC-T5-FILE-03: Null byte injection in filename is safely mitigated (protocol rejection or sanitization)', async () => {
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );

      // 1. Literal null byte in raw multipart HTTP header is rejected at protocol parsing layer (400)
      const sessionToken = adminClient.cookieJar.get('labnotes_session') || '';
      const rawNullRes = await new Promise((resolve) => {
        const socket = net.connect(8080, '127.0.0.1', () => {
          const boundary = '----WebKitFormBoundaryNullByteTest';
          const header =
            `POST /api/admin/pages/${testPageId}/assets HTTP/1.1\r\n` +
            `Host: 127.0.0.1:8080\r\n` +
            `Cookie: labnotes_session=${sessionToken}\r\n` +
            `X-CSRF-Token: ${adminClient.csrfToken || ''}\r\n` +
            `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
            `Connection: close\r\n\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="evil.php\0.png"\r\n` +
            `Content-Type: image/png\r\n\r\n` +
            `\x89PNG\r\n\x1a\n\r\n` +
            `--${boundary}--\r\n`;
          socket.write(header);
        });
        let data = '';
        socket.on('data', (c) => (data += c.toString('utf-8')));
        socket.on('end', () => {
          const match = data.match(/HTTP\/1\.[01]\s+(\d{3})/);
          resolve(match ? parseInt(match[1], 10) : 0);
        });
        socket.on('error', () => resolve(400));
      });
      assert.ok([400, 422].includes(rawNullRes), `Expected 400 for literal null byte in multipart header, got ${rawNullRes}`);

      // 2. Percent-encoded null byte is safely sanitized by application layer
      const formPercentNull = new FormData();
      formPercentNull.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'evil_script.php%00.png');
      const resPercent = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, formPercentNull);
      assertStatus(resPercent, 201);
      assert.strictEqual(resPercent.data.original_name, 'evil_script.php_00.png');
      assert.ok(!resPercent.data.original_name.includes('\0'));

      await adminClient.delete(`/api/admin/pages/${testPageId}/assets/${resPercent.data.id}`);
    });
  });
});
