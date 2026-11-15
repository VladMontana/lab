// e2e_tests/sanity.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { config } from './config.js';
import { CookieJar } from './helpers/cookie_jar.js';
import { ApiClient } from './helpers/api_client.js';
import {
  assertStatus,
  assertSuccess,
  assertError,
  assertNotLeaked,
  assertNoXss,
  assertHeader,
  assertEnvelope,
} from './helpers/assertions.js';
import { MediaGenerator } from './helpers/media_generator.js';
import {
  uniqueName,
  sampleSubject,
  samplePageDraft,
  sampleMarkdown,
  xssMarkdownPayloads,
  sqlInjectionPayloads,
} from './helpers/fixtures.js';
import { waitForServer } from './helpers/wait_for_server.js';

describe('Sanity Test Suite: E2E Infrastructure Validation', () => {
  describe('1. Configuration (config.js)', () => {
    it('should export valid configuration parameters with sensible defaults', () => {
      assert.ok(typeof config.baseUrl === 'string' && config.baseUrl.length > 0, 'baseUrl must be string');
      assert.ok(typeof config.adminUsername === 'string' && config.adminUsername.length > 0, 'adminUsername must be string');
      assert.ok(typeof config.adminPassword === 'string' && config.adminPassword.length > 0, 'adminPassword must be string');
      assert.ok(typeof config.testTimeout === 'number' && config.testTimeout > 0, 'testTimeout must be positive number');
      assert.ok(typeof config.healthCheckTimeout === 'number' && config.healthCheckTimeout > 0, 'healthCheckTimeout must be positive number');
    });
  });

  describe('2. In-Memory Cookie Jar (cookie_jar.js)', () => {
    it('should parse single cookie and attributes correctly', () => {
      const jar = new CookieJar();
      jar.parseCookie('session_token=abc123xyz; Path=/; HttpOnly; SameSite=Lax');

      assert.strictEqual(jar.get('session_token'), 'abc123xyz');
      const details = jar.getDetails('session_token');
      assert.strictEqual(details.httpOnly, true);
      assert.strictEqual(details.path, '/');
      assert.strictEqual(details.sameSite, 'Lax');
      assert.strictEqual(jar.getCookieHeader(), 'session_token=abc123xyz');
    });

    it('should support multiple cookies and format Cookie header correctly', () => {
      const jar = new CookieJar();
      jar.set('theme', 'dark');
      jar.set('session', 'tok456');

      const header = jar.getCookieHeader();
      assert.ok(header.includes('theme=dark'));
      assert.ok(header.includes('session=tok456'));
    });

    it('should delete cookie on Max-Age=0 or expired date', () => {
      const jar = new CookieJar();
      jar.set('temp', 'value');
      assert.strictEqual(jar.get('temp'), 'value');

      jar.parseCookie('temp=; Max-Age=0; Path=/');
      assert.strictEqual(jar.get('temp'), undefined);
    });

    it('should support setFromHeaders with native Headers mock or object', () => {
      const jar = new CookieJar();
      const mockHeaders = {
        getSetCookie() {
          return [
            'c1=val1; Path=/; HttpOnly',
            'c2=val2; SameSite=Strict',
          ];
        },
      };

      jar.setFromHeaders(mockHeaders);
      assert.strictEqual(jar.get('c1'), 'val1');
      assert.strictEqual(jar.get('c2'), 'val2');
      assert.strictEqual(jar.getDetails('c1').httpOnly, true);
    });

    it('should support cloning and isolation', () => {
      const original = new CookieJar();
      original.set('token', 'original_token');

      const clone = original.clone();
      assert.strictEqual(clone.get('token'), 'original_token');

      clone.set('token', 'mutated_in_clone');
      assert.strictEqual(original.get('token'), 'original_token');
      assert.strictEqual(clone.get('token'), 'mutated_in_clone');

      clone.clear();
      assert.strictEqual(clone.get('token'), undefined);
      assert.strictEqual(original.get('token'), 'original_token');
    });
  });

  describe('3. Assertion Helpers (assertions.js)', () => {
    it('assertStatus should succeed on match and throw on mismatch', () => {
      const mockRes = { status: 200, data: { ok: true } };
      assert.doesNotThrow(() => assertStatus(mockRes, 200));
      assert.throws(() => assertStatus(mockRes, 404), /Expected HTTP 404 but received 200/);
    });

    it('assertSuccess should verify status and ok flag', () => {
      const goodRes = { status: 200, ok: true, data: { status: 'ok' } };
      assert.doesNotThrow(() => assertSuccess(goodRes, 200));

      const badRes = { status: 400, ok: false, data: {} };
      assert.throws(() => assertSuccess(badRes, 200));
    });

    it('assertError should validate standard JSON envelope and error codes', () => {
      const validErrorRes = {
        status: 400,
        ok: false,
        data: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Title must not be empty',
          },
        },
      };

      assert.doesNotThrow(() => assertError(validErrorRes, 400, 'VALIDATION_ERROR'));
      assert.throws(() => assertError(validErrorRes, 400, 'NOT_FOUND'), /Expected error\.code "NOT_FOUND"/);

      const invalidEnvelopeRes = {
        status: 500,
        ok: false,
        data: { message: 'Missing error object' },
      };
      assert.throws(() => assertError(invalidEnvelopeRes, 500), /Expected "error" envelope/);
    });

    it('assertNotLeaked should catch database/stack trace leaks', () => {
      assert.doesNotThrow(() => assertNotLeaked('Invalid input parameter'));
      assert.throws(() => assertNotLeaked('Error at SQLite3 syntax error: SELECT * FROM pages'), /Potential security\/information leak/);
      assert.throws(() => assertNotLeaked('Panicked at src/main.rs:42'), /Potential security\/information leak/);
      assert.throws(() => assertNotLeaked('argon2$v=19$m=4096 hash leaked'), /Potential security\/information leak/);
    });

    it('assertNoXss should allow clean HTML and reject all XSS vectors', () => {
      const cleanHtml = '<h1>Practical Work 1</h1><p>Welcome to <strong>LabNotes</strong>!</p><a href="/p/123">Link</a>';
      assert.doesNotThrow(() => assertNoXss(cleanHtml));

      assert.throws(() => assertNoXss('<script>alert("xss")</script>'), /Unsanitized <script> tag/);
      assert.throws(() => assertNoXss('<img src="x" onerror="alert(1)">'), /Unsanitized onerror/);
      assert.throws(() => assertNoXss('<a href="javascript:alert(1)">Click</a>'), /Unsanitized javascript: link/);
      assert.throws(() => assertNoXss('<iframe src="https://example.com"></iframe>'), /Unsanitized <iframe>/);
      assert.throws(() => assertNoXss('<svg onload="alert(1)">'), /Unsanitized onload/);
    });

    it('assertHeader should validate string values and regexes', () => {
      const res = {
        headers: new Headers({
          'content-type': 'application/json; charset=utf-8',
          'x-custom-tag': 'v1.0',
        }),
      };

      assert.doesNotThrow(() => assertHeader(res, 'x-custom-tag', 'v1.0'));
      assert.doesNotThrow(() => assertHeader(res, 'content-type', /application\/json/));
      assert.throws(() => assertHeader(res, 'x-custom-tag', 'v2.0'));
    });

    it('assertEnvelope should validate both success and error responses', () => {
      assert.doesNotThrow(() => assertEnvelope({ status: 200, data: { items: [] } }));
      assert.doesNotThrow(() => assertEnvelope({
        status: 404,
        data: { error: { code: 'NOT_FOUND', message: 'Item not found' } },
      }));
    });
  });

  describe('4. Binary Media & Attachment Generator (media_generator.js)', () => {
    it('createPng should produce valid PNG with 8-byte PNG magic signature', async () => {
      const file = MediaGenerator.createPng('avatar.png');
      assert.strictEqual(file.name, 'avatar.png');
      assert.strictEqual(file.type, 'image/png');
      assert.ok(file.size >= 70, `PNG size must be >= 70 bytes, got ${file.size}`);

      const arrayBuf = await file.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      assert.strictEqual(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    });

    it('createJpeg should produce valid JFIF JPEG with SOI and EOI markers', async () => {
      const file = MediaGenerator.createJpeg('photo.jpg');
      assert.strictEqual(file.name, 'photo.jpg');
      assert.strictEqual(file.type, 'image/jpeg');
      assert.ok(file.size >= 100, `JPEG size must be >= 100 bytes, got ${file.size}`);

      const arrayBuf = await file.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      assert.strictEqual(buf.subarray(0, 2).toString('hex'), 'ffd8');
      assert.strictEqual(buf.subarray(-2).toString('hex'), 'ffd9');
    });

    it('createWebp should produce valid WebP with RIFF and WEBP signatures', async () => {
      const file = MediaGenerator.createWebp('banner.webp');
      assert.strictEqual(file.name, 'banner.webp');
      assert.strictEqual(file.type, 'image/webp');

      const arrayBuf = await file.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      assert.strictEqual(buf.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.strictEqual(buf.subarray(8, 12).toString('ascii'), 'WEBP');
    });

    it('createSvg should produce valid SVG XML file', async () => {
      const file = MediaGenerator.createSvg('icon.svg');
      assert.strictEqual(file.name, 'icon.svg');
      assert.strictEqual(file.type, 'image/svg+xml');
      const text = await file.text();
      assert.ok(text.startsWith('<svg') && text.endsWith('</svg>'));
    });

    it('createCorruptedImage should produce invalid image bytes', async () => {
      const file = MediaGenerator.createCorruptedImage('bad.png');
      assert.strictEqual(file.type, 'image/png');
      const text = await file.text();
      assert.ok(text.includes('NOT_A_VALID_IMAGE'));
    });

    it('createOversizedImage should exceed 10 MiB limit', () => {
      const file = MediaGenerator.createOversizedImage('huge.png');
      assert.strictEqual(file.type, 'image/png');
      assert.strictEqual(file.size, 10 * 1024 * 1024 + 1024);
    });

    it('createZip should produce valid empty ZIP archive with EOCD signature', async () => {
      const file = MediaGenerator.createZip('files.zip');
      assert.strictEqual(file.type, 'application/zip');
      assert.strictEqual(file.size, 22);

      const arrayBuf = await file.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      assert.strictEqual(buf.subarray(0, 4).toString('hex'), '504b0506');
    });

    it('createPdf should produce valid PDF header and trailer', async () => {
      const file = MediaGenerator.createPdf('guide.pdf');
      assert.strictEqual(file.type, 'application/pdf');
      const text = await file.text();
      assert.ok(text.startsWith('%PDF-1.4'));
      assert.ok(text.includes('%%EOF'));
    });

    it('createText should produce valid markdown/text file', async () => {
      const file = MediaGenerator.createText('doc.md', '# Hello Markdown\n');
      assert.strictEqual(file.type, 'text/markdown');
      const text = await file.text();
      assert.strictEqual(text, '# Hello Markdown\n');
    });

    it('createOversizedAttachment should exceed 50 MiB limit', () => {
      const file = MediaGenerator.createOversizedAttachment('giant.zip');
      assert.strictEqual(file.type, 'application/zip');
      assert.strictEqual(file.size, 50 * 1024 * 1024 + 1024);
    });

    it('createPathTraversalFile should retain path traversal in filename', () => {
      const file = MediaGenerator.createPathTraversalFile('../../etc/passwd');
      assert.strictEqual(file.name, '../../etc/passwd');
    });
  });

  describe('5. Fixture Generators (fixtures.js)', () => {
    it('uniqueName should generate collision-resistant names with given prefix', () => {
      const name1 = uniqueName('item');
      const name2 = uniqueName('item');
      assert.ok(name1.startsWith('item_'));
      assert.ok(name2.startsWith('item_'));
      assert.notStrictEqual(name1, name2);
    });

    it('sampleSubject should return valid subject DTO', () => {
      const subj = sampleSubject({ position: 5 });
      assert.ok(subj.name.startsWith('subj_'));
      assert.strictEqual(subj.position, 5);
    });

    it('samplePageDraft should return valid draft DTO', () => {
      const draft = samplePageDraft('subj-123', { draft_title: 'Custom Title' });
      assert.strictEqual(draft.draft_subject_id, 'subj-123');
      assert.strictEqual(draft.draft_title, 'Custom Title');
      assert.ok(draft.draft_markdown.includes('Hello LabNotes'));
    });

    it('sampleMarkdown should return rich document covering all required syntax elements', () => {
      const md = sampleMarkdown('OS Lab 3');
      assert.ok(md.includes('# OS Lab 3'), 'Missing H1 title');
      assert.ok(md.includes('## Overview'), 'Missing H2 overview');
      assert.ok(md.includes('```bash'), 'Missing code block');
      assert.ok(md.includes('- [x] Node.js'), 'Missing checklist');
      assert.ok(md.includes('> **Important Note:**'), 'Missing blockquote');
      assert.ok(md.includes('| Metric | Target |'), 'Missing table');
      assert.ok(md.includes('![System Architecture Diagram]'), 'Missing image reference');
      assert.ok(md.includes('[Starter Kit]'), 'Missing attachment link');
    });

    it('xssMarkdownPayloads should contain at least 10 adversarial vectors', () => {
      assert.ok(Array.isArray(xssMarkdownPayloads));
      assert.ok(xssMarkdownPayloads.length >= 10, 'Must contain at least 10 XSS attack vectors');
      for (const payload of xssMarkdownPayloads) {
        assert.ok(typeof payload === 'string' && payload.length > 0);
      }
    });

    it('sqlInjectionPayloads should contain SQL injection probes', () => {
      assert.ok(Array.isArray(sqlInjectionPayloads));
      assert.ok(sqlInjectionPayloads.length >= 3);
    });
  });

  describe('6. High-Level HTTP Client (api_client.js)', () => {
    it('should initialize with default config and origin', () => {
      const client = new ApiClient();
      assert.strictEqual(client.baseUrl, config.baseUrl);
      assert.ok(client.cookieJar instanceof CookieJar);
      assert.strictEqual(client.csrfToken, null);
      assert.ok(client.origin.startsWith('http'));
    });

    it('should clone with isolated cookie jar', () => {
      const client = new ApiClient();
      client.cookieJar.set('auth', 'tok_original');
      client.csrfToken = 'csrf_secret_123';

      const cloned = client.clone();
      assert.strictEqual(cloned.cookieJar.get('auth'), 'tok_original');
      assert.strictEqual(cloned.csrfToken, 'csrf_secret_123');

      cloned.cookieJar.set('auth', 'tok_cloned');
      assert.strictEqual(client.cookieJar.get('auth'), 'tok_original');
      assert.strictEqual(cloned.cookieJar.get('auth'), 'tok_cloned');
    });

    it('ApiClient.anonymous should return fresh unauthenticated client', () => {
      const anon = ApiClient.anonymous('http://127.0.0.1:9999');
      assert.strictEqual(anon.baseUrl, 'http://127.0.0.1:9999');
      assert.strictEqual(anon.cookieJar.getCookieHeader(), '');
      assert.strictEqual(anon.csrfToken, null);
    });
  });

  describe('7. Server Health Poller (wait_for_server.js)', () => {
    it('should export waitForServer async function', () => {
      assert.strictEqual(typeof waitForServer, 'function');
    });

    it('should fail gracefully with clear diagnostic when port is closed', async () => {
      // Test against an unlikely closed port with a brief 200ms timeout
      await assert.rejects(
        async () => {
          await waitForServer('http://127.0.0.1:59999', 200, { intervalMs: 50, quiet: true });
        },
        /Server readiness timeout.*failed to respond with 200 OK/
      );
    });
  });
});
