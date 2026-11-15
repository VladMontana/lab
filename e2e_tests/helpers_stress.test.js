// e2e_tests/helpers_stress.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { MediaGenerator } from './helpers/media_generator.js';
import { CookieJar } from './helpers/cookie_jar.js';
import {
  assertEnvelope,
  assertError,
  assertStatus,
  assertSuccess,
  assertNotLeaked,
  assertNoXss,
  assertHeader,
} from './helpers/assertions.js';
import { xssMarkdownPayloads, sqlInjectionPayloads, uniqueName, sampleSubject, samplePageDraft, sampleMarkdown } from './helpers/fixtures.js';
import { ApiClient } from './helpers/api_client.js';

describe('Adversarial Stress Test: E2E Test Infrastructure', () => {
  describe('1. MediaGenerator Empirical Verification', () => {
    it('MediaGenerator.createPng() returns valid 8-byte PNG signature (89504e470d0a1a0a)', async () => {
      const file = MediaGenerator.createPng('stress.png');
      assert.ok(file instanceof File);
      assert.strictEqual(file.name, 'stress.png');
      assert.strictEqual(file.type, 'image/png');
      const ab = await file.arrayBuffer();
      const buf = Buffer.from(ab);
      const magicHex = buf.subarray(0, 8).toString('hex');
      assert.strictEqual(magicHex, '89504e470d0a1a0a');
    });

    it('MediaGenerator.createJpeg() starts with SOI marker ffd8 and ends with EOI ffd9', async () => {
      const file = MediaGenerator.createJpeg('stress.jpg');
      assert.ok(file instanceof File);
      assert.strictEqual(file.name, 'stress.jpg');
      assert.strictEqual(file.type, 'image/jpeg');
      const ab = await file.arrayBuffer();
      const buf = Buffer.from(ab);
      const soi = buf.subarray(0, 2).toString('hex');
      const eoi = buf.subarray(-2).toString('hex');
      assert.strictEqual(soi, 'ffd8');
      assert.strictEqual(eoi, 'ffd9');
    });

    it('MediaGenerator.createZip() starts with 504b magic signature', async () => {
      const file = MediaGenerator.createZip('stress.zip');
      assert.ok(file instanceof File);
      assert.strictEqual(file.name, 'stress.zip');
      assert.strictEqual(file.type, 'application/zip');
      const ab = await file.arrayBuffer();
      const buf = Buffer.from(ab);
      const magic = buf.subarray(0, 2).toString('hex');
      assert.strictEqual(magic, '504b');
      // Full signature for empty zip EOCD is 504b0506
      assert.strictEqual(buf.subarray(0, 4).toString('hex'), '504b0506');
    });

    it('Check whether generatePng / generateJpeg / generateZip method names exist vs create*', () => {
      // The dispatch mission requested testing generatePng, generateJpeg, generateZip.
      // We empirically record that create* methods are the implemented ones.
      assert.strictEqual(typeof MediaGenerator.createPng, 'function');
      assert.strictEqual(typeof MediaGenerator.createJpeg, 'function');
      assert.strictEqual(typeof MediaGenerator.createZip, 'function');
      assert.strictEqual(typeof MediaGenerator.generatePng, 'undefined');
      assert.strictEqual(typeof MediaGenerator.generateJpeg, 'undefined');
      assert.strictEqual(typeof MediaGenerator.generateZip, 'undefined');
    });

    it('MediaGenerator oversized image exceeds 10 MiB with valid PNG header', async () => {
      const file = MediaGenerator.createOversizedImage('oversized.png');
      assert.strictEqual(file.type, 'image/png');
      assert.strictEqual(file.size, 10 * 1024 * 1024 + 1024);
      const ab = await file.slice(0, 8).arrayBuffer();
      assert.strictEqual(Buffer.from(ab).toString('hex'), '89504e470d0a1a0a');
    });

    it('MediaGenerator oversized attachment exceeds 50 MiB with valid ZIP header', async () => {
      const file = MediaGenerator.createOversizedAttachment('oversized.zip');
      assert.strictEqual(file.type, 'application/zip');
      assert.strictEqual(file.size, 50 * 1024 * 1024 + 1024);
      const ab = await file.slice(0, 4).arrayBuffer();
      assert.strictEqual(Buffer.from(ab).toString('hex'), '504b0304');
    });

    it('MediaGenerator corrupted image contains invalid magic bytes', async () => {
      const file = MediaGenerator.createCorruptedImage('corrupted.png');
      const text = await file.text();
      assert.ok(text.includes('NOT_A_VALID_IMAGE'));
      const ab = await file.slice(0, 8).arrayBuffer();
      assert.notStrictEqual(Buffer.from(ab).toString('hex'), '89504e470d0a1a0a');
    });
  });

  describe('2. CookieJar Stress Testing', () => {
    it('Multiple Set-Cookie parsing via Headers getSetCookie()', () => {
      const jar = new CookieJar();
      const mockHeaders = {
        getSetCookie() {
          return [
            'session=token_abc; Path=/; HttpOnly; SameSite=Lax',
            'csrf_cookie=csrf_123; Path=/; SameSite=Strict',
            'prefs=dark_mode; Path=/api',
          ];
        },
      };
      jar.setFromHeaders(mockHeaders);
      assert.strictEqual(jar.get('session'), 'token_abc');
      assert.strictEqual(jar.get('csrf_cookie'), 'csrf_123');
      assert.strictEqual(jar.get('prefs'), 'dark_mode');

      const sessDetails = jar.getDetails('session');
      assert.strictEqual(sessDetails.httpOnly, true);
      assert.strictEqual(sessDetails.sameSite, 'Lax');

      const csrfDetails = jar.getDetails('csrf_cookie');
      assert.strictEqual(csrfDetails.httpOnly, false);
      assert.strictEqual(csrfDetails.sameSite, 'Strict');
    });

    it('Multiple Set-Cookie parsing via array in headers["set-cookie"]', () => {
      const jar = new CookieJar();
      jar.setFromHeaders({
        'set-cookie': [
          'alpha=1; Path=/',
          'beta=2; Path=/',
        ],
      });
      assert.strictEqual(jar.get('alpha'), '1');
      assert.strictEqual(jar.get('beta'), '2');
    });

    it('Cookie replacement: new Set-Cookie with same name overwrites value and attributes', () => {
      const jar = new CookieJar();
      jar.parseCookie('auth=initial; Path=/; HttpOnly');
      assert.strictEqual(jar.get('auth'), 'initial');
      assert.strictEqual(jar.getDetails('auth').httpOnly, true);

      // Overwrite with new value and different attributes
      jar.parseCookie('auth=updated; Path=/admin; SameSite=Strict');
      assert.strictEqual(jar.get('auth'), 'updated');
      assert.strictEqual(jar.getDetails('auth').path, '/admin');
      assert.strictEqual(jar.getDetails('auth').httpOnly, false);
      assert.strictEqual(jar.getDetails('auth').sameSite, 'Strict');
    });

    it('Cookie with equals sign in value is parsed correctly (e.g. base64)', () => {
      const jar = new CookieJar();
      jar.parseCookie('token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9==; Path=/');
      assert.strictEqual(jar.get('token'), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9==');
    });

    it('Expiration logic: Max-Age=0 deletes cookie', () => {
      const jar = new CookieJar();
      jar.set('active', 'yes');
      assert.strictEqual(jar.get('active'), 'yes');

      jar.parseCookie('active=; Max-Age=0; Path=/');
      assert.strictEqual(jar.get('active'), undefined);
    });

    it('Expiration logic: Negative Max-Age deletes cookie', () => {
      const jar = new CookieJar();
      jar.set('active', 'yes');
      assert.strictEqual(jar.get('active'), 'yes');

      jar.parseCookie('active=; Max-Age=-100; Path=/');
      assert.strictEqual(jar.get('active'), undefined);
    });

    it('Expiration logic: Past Expires date deletes cookie', () => {
      const jar = new CookieJar();
      jar.set('temp', 'session_id');
      assert.strictEqual(jar.get('temp'), 'session_id');

      jar.parseCookie('temp=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/');
      assert.strictEqual(jar.get('temp'), undefined);
    });

    it('Expiration logic: Future Expires date keeps cookie', () => {
      const jar = new CookieJar();
      const future = new Date(Date.now() + 86400000).toUTCString();
      jar.parseCookie(`persist=alive; Expires=${future}; Path=/`);
      assert.strictEqual(jar.get('persist'), 'alive');
    });

    it('Expiration logic: Malformed Expires date string does not crash and leaves expires null', () => {
      const jar = new CookieJar();
      jar.parseCookie('malformed=val; Expires=not-a-valid-date; Path=/');
      assert.strictEqual(jar.get('malformed'), 'val');
      assert.strictEqual(jar.getDetails('malformed').expires, null);
    });

    it('Path matching empirical analysis: CookieJar stores path attribute but getCookieHeader() returns all cookies', () => {
      const jar = new CookieJar();
      jar.parseCookie('root=val1; Path=/');
      jar.parseCookie('admin_only=secret; Path=/api/admin');

      assert.strictEqual(jar.getDetails('root').path, '/');
      assert.strictEqual(jar.getDetails('admin_only').path, '/api/admin');

      const header = jar.getCookieHeader();
      // Observation: getCookieHeader() serializes all stored cookies without path scoping
      assert.ok(header.includes('root=val1'));
      assert.ok(header.includes('admin_only=secret'));
    });
  });

  describe('3. Assertions & assertEnvelope Stress Testing', () => {
    it('assertEnvelope accepts valid success response (200 OK with data)', () => {
      const res = {
        status: 200,
        ok: true,
        data: { id: 'p1', title: 'Test' },
      };
      assert.doesNotThrow(() => assertEnvelope(res));
    });

    it('assertEnvelope rejects response with undefined data on success status', () => {
      const res = {
        status: 200,
        ok: true,
        data: undefined,
      };
      assert.throws(() => assertEnvelope(res), /Expected response\.data to be defined/);
    });

    it('assertEnvelope accepts valid error envelope { error: { code, message } } on status >= 400', () => {
      const res400 = {
        status: 400,
        ok: false,
        data: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid title',
          },
        },
      };
      assert.doesNotThrow(() => assertEnvelope(res400));

      const res404 = {
        status: 404,
        ok: false,
        data: {
          error: {
            code: 'NOT_FOUND',
            message: 'Page not found',
          },
        },
      };
      assert.doesNotThrow(() => assertEnvelope(res404));

      const res409 = {
        status: 409,
        ok: false,
        data: {
          error: {
            code: 'REVISION_CONFLICT',
            message: 'Conflict detected',
          },
        },
      };
      assert.doesNotThrow(() => assertEnvelope(res409));
    });

    it('assertEnvelope rejects status >= 400 when data is null or missing', () => {
      const res = {
        status: 400,
        ok: false,
        data: null,
      };
      assert.throws(() => assertEnvelope(res), /Expected JSON error response body/);
    });

    it('assertEnvelope rejects status >= 400 when error object is missing', () => {
      const res = {
        status: 400,
        ok: false,
        data: { status: 'error', detail: 'Missing error key' },
      };
      assert.throws(() => assertEnvelope(res), /Expected "error" envelope/);
    });

    it('assertEnvelope rejects status >= 400 when error.code is empty or non-string', () => {
      const emptyCodeRes = {
        status: 400,
        ok: false,
        data: { error: { code: '', message: 'Some message' } },
      };
      assert.throws(() => assertEnvelope(emptyCodeRes), /Expected non-empty string for error\.code/);

      const numCodeRes = {
        status: 400,
        ok: false,
        data: { error: { code: 400, message: 'Some message' } },
      };
      assert.throws(() => assertEnvelope(numCodeRes), /Expected non-empty string for error\.code/);
    });

    it('assertEnvelope rejects status >= 400 when error.message is empty or non-string', () => {
      const emptyMsgRes = {
        status: 400,
        ok: false,
        data: { error: { code: 'BAD_REQUEST', message: '' } },
      };
      assert.throws(() => assertEnvelope(emptyMsgRes), /Expected error\.message to be a non-empty string/);
    });

    it('assertEnvelope rejects status >= 400 if error.message leaks SQL syntax, stack traces or password hashes', () => {
      const sqlLeakRes = {
        status: 500,
        ok: false,
        data: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'sqlite3 returned syntax error near SELECT * FROM pages',
          },
        },
      };
      assert.throws(() => assertEnvelope(sqlLeakRes), /Potential security\/information leak detected/);

      const panicLeakRes = {
        status: 500,
        ok: false,
        data: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Panicked at src/storage.rs:88',
          },
        },
      };
      assert.throws(() => assertEnvelope(panicLeakRes), /Potential security\/information leak detected/);

      const argonLeakRes = {
        status: 500,
        ok: false,
        data: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to verify argon2 password_hash',
          },
        },
      };
      assert.throws(() => assertEnvelope(argonLeakRes), /Potential security\/information leak detected/);
    });

    it('Adversarial finding: assertNoXss passes unquoted javascript: href due to strict quote requirement in regex', () => {
      // In assertions.js: assert.ok(!/href\s*=\s*["']\s*javascript:/i.test(htmlString));
      // Notice: ["'] requires quotes! Unquoted href=javascript:alert(1) bypasses this check!
      const quotedXss = '<a href="javascript:alert(1)">Click</a>';
      const unquotedXss = '<a href=javascript:alert(1)>Click</a>';

      assert.throws(() => assertNoXss(quotedXss), /Unsanitized javascript: link/);
      // Demonstrating that unquoted javascript: currently does NOT throw (bypassed)
      assert.doesNotThrow(() => assertNoXss(unquotedXss));
    });
  });

  describe('4. CLI Runner Discovery & Filtering Empirical Analysis', () => {
    it('run_all.js --feature=13 fails because test filenames do not contain fXX patterns', () => {
      // In run_all.js lines 81-83:
      // const paddedFeature = featureFilter.padStart(2, '0');
      // return f.toLowerCase().includes(`f${paddedFeature}`);
      // But files in tier1 and tier2 are named tier1_01_10.test.js, tier1_11_20.test.js, etc.
      const tier1Files = ['tier1_01_10.test.js', 'tier1_11_20.test.js', 'tier1_21_30.test.js', 'tier1_31_40.test.js', 'tier1_41_46.test.js'];
      const filteredForF13 = tier1Files.filter(f => f.toLowerCase().includes('f13'));
      assert.strictEqual(filteredForF13.length, 0, 'No files match f13 pattern');
    });
  });
});
