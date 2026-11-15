import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Setup JSDOM environment for DOMPurify and browser mocks
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
globalThis.HTMLImageElement = dom.window.HTMLImageElement;

import { renderMarkdown, slugify, handleCodeCopyClick } from './src/lib/markdown.ts';
import { matchRoute } from './src/lib/router.ts';
import { ApiClient, ApiClientError } from './src/lib/api.ts';
import { assertNoXss } from '../e2e_tests/helpers/assertions.js';

function createMockHeaders(entries = []) {
  const map = new Map(entries.map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: (key) => map.get(key.toLowerCase()) || null,
  };
}

// Extract formatBytes and getFileIcon logic as implemented in AttachmentTray.svelte
function formatBytes(bytes) {
  if (bytes <= 0) return '0 Б';
  const k = 1024;
  const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const formatted = parseFloat((bytes / Math.pow(k, i)).toFixed(1));
  return `${formatted} ${sizes[i]}`;
}

function getFileIcon(mime, name) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (mime.includes('pdf') || ext === 'pdf') return '📕';
  if (mime.includes('zip') || ext === 'zip' || ext === 'tar' || ext === 'gz') return '📦';
  if (mime.includes('word') || ext === 'docx' || ext === 'doc') return '📝';
  if (mime.includes('text') || ext === 'txt' || ext === 'md') return '📃';
  return '📎';
}

const stats = { total: 0, passed: 0, failed: 0, warnings: 0 };
const findings = [];

async function test(description, fn) {
  stats.total++;
  try {
    await fn();
    stats.passed++;
    console.log(`  [PASS] ${description}`);
  } catch (err) {
    stats.failed++;
    console.error(`  [FAIL] ${description}`);
    console.error(`         ${err.message}`);
    findings.push({ severity: 'FAIL', test: description, error: err.message });
  }
}

function warn(description, message) {
  stats.warnings++;
  console.warn(`  [WARN] ${description}: ${message}`);
  findings.push({ severity: 'WARN', test: description, error: message });
}

async function runAll() {
  console.log('================================================================');
  console.log('CHALLENGER 2: ADVERSARIAL STRESS SUITE (MILESTONE 4 FRONTEND)');
  console.log('================================================================\n');

  // ============================================================================
  // SUITE 1: ROUTER EDGE CASES & MALFORMED PATHS
  // ============================================================================
  console.log('--- SUITE 1: Router Edge Cases & Malformed Inputs ---');

  await test('Root variations and redundant slashes normalize to catalog', async () => {
    const r1 = matchRoute('/', '', '');
    assert.strictEqual(r1.name, 'catalog');
    assert.strictEqual(r1.path, '/');

    const r2 = matchRoute('///', '', '');
    assert.strictEqual(r2.name, 'catalog');
    assert.strictEqual(r2.path, '/');

    const r3 = matchRoute('', '', '');
    assert.strictEqual(r3.name, 'catalog');
    assert.strictEqual(r3.path, '/');
  });

  await test('Trailing slashes normalized for known routes', async () => {
    const rAdmin = matchRoute('/admin/login/', '', '');
    assert.strictEqual(rAdmin.name, 'login');
    assert.strictEqual(rAdmin.path, '/admin/login');

    const rReader = matchRoute('/p/test-slug-123/', '', '');
    assert.strictEqual(rReader.name, 'reader');
    assert.strictEqual(rReader.params.id, 'test-slug-123');
    assert.strictEqual(rReader.path, '/p/test-slug-123');
  });

  await test('Reader route decodes URL-encoded parameters', async () => {
    const r = matchRoute('/p/%D0%9B%D0%B0%D0%B1%D0%B0-1', '', '');
    assert.strictEqual(r.name, 'reader');
    assert.strictEqual(r.params.id, 'Лаба-1');
  });

  await test('Reader route handles UUID identifiers', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const r = matchRoute(`/p/${uuid}`, '', '');
    assert.strictEqual(r.name, 'reader');
    assert.strictEqual(r.params.id, uuid);
  });

  await test('Deeply nested paths fall back to not-found', async () => {
    const paths = [
      '/p/123/extra',
      '/p/123/sub/page',
      '/admin/login/dashboard',
      '/api/public/pages',
      '/unknown/subpath/item',
      '/admin',
      '/catalog',
    ];
    for (const p of paths) {
      const r = matchRoute(p, '', '');
      assert.strictEqual(r.name, 'not-found', `Path ${p} should match not-found`);
    }
  });

  await test('Malformed percent-encoding in route params behavior', async () => {
    // Adversarial: user navigates to /p/% or /p/%E0%A4 (invalid UTF-8 sequence)
    try {
      matchRoute('/p/%', '', '');
    } catch (err) {
      warn('Malformed percent-encoding in router parameter',
        `matchRoute throws unhandled ${err.name} (${err.message}) on /p/% without try-catch guard`);
    }
  });

  await test('Query string parsing with special characters and encodings', async () => {
    // Test ?q=%20%26%3D (space, &, =)
    const r = matchRoute('/', '?q=%20%26%3D&subject_id=sub_1', '');
    assert.strictEqual(r.name, 'catalog');
    assert.strictEqual(r.query.q, ' &=');
    assert.strictEqual(r.query.subject_id, 'sub_1');
  });

  await test('Query string with empty values and duplicate keys', async () => {
    const r1 = matchRoute('/', '?empty=&val=foo', '');
    assert.strictEqual(r1.query.empty, '');
    assert.strictEqual(r1.query.val, 'foo');

    const r2 = matchRoute('/', '?tag=first&tag=second', '');
    assert.strictEqual(r2.query.tag, 'second');
  });

  await test('Inline query in pathname string is handled', async () => {
    const r = matchRoute('/p/my-id?ref=catalog', '', '#sec-1');
    assert.strictEqual(r.name, 'reader');
    assert.strictEqual(r.params.id, 'my-id');
    assert.strictEqual(r.query.ref, 'catalog');
    assert.strictEqual(r.hash, '#sec-1');
  });

  await test('Empty hash and unusual hash formats', async () => {
    const r1 = matchRoute('/p/id', '', '');
    assert.strictEqual(r1.hash, '');

    const r2 = matchRoute('/p/id', '', '#');
    assert.strictEqual(r2.hash, '#');

    const r3 = matchRoute('/p/id', '', '#section-1.2');
    assert.strictEqual(r3.hash, '#section-1.2');
  });

  // ============================================================================
  // SUITE 2: TOC SLUGIFICATION & COLLISION DISAMBIGUATION
  // ============================================================================
  console.log('\n--- SUITE 2: TOC Slugification & Collision Disambiguation ---');

  await test('Slugify handles complex Cyrillic, Latin, and mixed text', async () => {
    assert.strictEqual(slugify('Лабораторная работа №3: Исследование АЦП'), 'лабораторная-работа-3-исследование-ацп');
    assert.strictEqual(slugify('Section 2.1: TCP/IP Stack & OSI Model'), 'section-21-tcpip-stack-osi-model');
    assert.strictEqual(slugify('Базовый синтаксис Rust (let, mut, &mut)'), 'базовый-синтаксис-rust-let-mut-mut');
  });

  await test('Slugify handles whitespace, punctuation, and fallback', async () => {
    assert.strictEqual(slugify('   '), 'heading');
    assert.strictEqual(slugify('!@#$%^&*()'), 'heading');
    assert.strictEqual(slugify('---___---'), 'heading');
    assert.strictEqual(slugify('---Тест---'), 'тест');
    assert.strictEqual(slugify('Двойные   пробелы  и __ подчеркивания'), 'двойные-пробелы-и-подчеркивания');
  });

  await test('Repeated identical headings produce sequential unique slugs (5 duplicates)', async () => {
    const md = `
## Введение
## Введение
## Введение
## Введение
## Введение
`;
    const result = renderMarkdown(md);
    assert.strictEqual(result.toc.length, 5);

    const ids = result.toc.map(t => t.id);
    assert.deepStrictEqual(ids, [
      'введение',
      'введение-1',
      'введение-2',
      'введение-3',
      'введение-4',
    ]);

    for (const id of ids) {
      assert.ok(result.html.includes(`id="${id}"`), `HTML must contain id="${id}"`);
    }
  });

  await test('Disambiguation handles collision with pre-existing numbered heading', async () => {
    const md = `
## Введение
## Введение 1
## Введение
`;
    const result = renderMarkdown(md);
    const ids = result.toc.map(t => t.id);

    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      warn('Slug disambiguation collision vulnerability',
        `Duplicate IDs generated when heading title collides with suffix: [${ids.join(', ')}]`);
    } else {
      assert.strictEqual(uniqueIds.size, ids.length, 'Generated TOC IDs must be globally unique');
    }
  });

  await test('H2 and H3 share the same disambiguation sequence', async () => {
    const md = `
## Методология
### Методология
## Методология
`;
    const result = renderMarkdown(md);
    assert.strictEqual(result.toc.length, 3);
    assert.strictEqual(result.toc[0].level, 2);
    assert.strictEqual(result.toc[0].id, 'методология');
    assert.strictEqual(result.toc[1].level, 3);
    assert.strictEqual(result.toc[1].id, 'методология-1');
    assert.strictEqual(result.toc[2].level, 2);
    assert.strictEqual(result.toc[2].id, 'методология-2');
  });

  await test('Only H2 and H3 are extracted into TOC (H1, H4-H6 ignored)', async () => {
    const md = `
# Заголовок H1
## Раздел H2
### Подраздел H3
#### Пункт H4
##### Подпункт H5
###### Мелкий H6
`;
    const result = renderMarkdown(md);
    assert.strictEqual(result.toc.length, 2);
    assert.strictEqual(result.toc[0].text, 'Раздел H2');
    assert.strictEqual(result.toc[1].text, 'Подраздел H3');
  });

  await test('Headings with inline code and bold formatting extract clean text for TOC', async () => {
    const md = `
## Введение в **async/await** и \`tokio\`
`;
    const result = renderMarkdown(md);
    assert.strictEqual(result.toc.length, 1);
    assert.strictEqual(result.toc[0].id, 'введение-в-asyncawait-и-tokio');
  });

  // ============================================================================
  // SUITE 3: API CLIENT RESILIENCE & ERROR HANDLING
  // ============================================================================
  console.log('\n--- SUITE 3: API Client Resilience & Error Handling ---');

  await test('ApiClientError predicates accurately categorize standard status codes & codes', async () => {
    const e404a = new ApiClientError(404, 'NOT_FOUND', 'Not found');
    const e404b = new ApiClientError(404, 'PAGE_NOT_FOUND', 'Page not found');
    const e404c = new ApiClientError(404, 'MEDIA_NOT_FOUND', 'Media not found');
    assert.ok(e404a.isNotFound() && e404b.isNotFound() && e404c.isNotFound());
    assert.ok(!e404a.isUnauthorized() && !e404a.isForbidden() && !e404a.isRateLimited());

    const e401a = new ApiClientError(401, 'UNAUTHORIZED', 'Unauthorized');
    const e401b = new ApiClientError(401, 'INVALID_CREDENTIALS', 'Bad credentials');
    assert.ok(e401a.isUnauthorized() && e401b.isUnauthorized());
    assert.ok(!e401a.isNotFound() && !e401a.isConflict());

    const e403 = new ApiClientError(403, 'FORBIDDEN', 'Forbidden');
    assert.ok(e403.isForbidden());
    assert.ok(!e403.isUnauthorized());

    const e409a = new ApiClientError(409, 'REVISION_CONFLICT', 'Version mismatch');
    const e409b = new ApiClientError(409, 'SUBJECT_NOT_EMPTY', 'Has children');
    assert.ok(e409a.isConflict() && e409b.isConflict());

    const e429 = new ApiClientError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests', 45);
    assert.ok(e429.isRateLimited());
    assert.strictEqual(e429.retryAfter, 45);

    const e400 = new ApiClientError(400, 'VALIDATION_ERROR', 'Field required');
    assert.ok(e400.isValidationError());
  });

  await test('ApiClient handles malformed JSON error body and non-JSON server error', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        headers: new Map(),
        json: async () => {
          throw new Error('Unexpected token < in JSON at position 0');
        },
      });

      const client = new ApiClient();
      let threw = false;
      try {
        await client.getPublicSubjects();
      } catch (err) {
        threw = true;
        assert.ok(err instanceof ApiClientError);
        assert.strictEqual(err.status, 502);
        assert.strictEqual(err.code, 'UNKNOWN_ERROR');
        assert.strictEqual(err.message, 'Bad Gateway');
      }
      assert.ok(threw, 'Should throw ApiClientError on 502 Bad Gateway');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('ApiClient extracts structured error envelope when present', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        headers: new Map([['retry-after', '15']]),
        json: async () => ({
          error: {
            code: 'REVISION_CONFLICT',
            message: 'Expected revision 2, found revision 3',
          },
        }),
      });

      const client = new ApiClient();
      let threw = false;
      try {
        await client.getPublicSubjects();
      } catch (err) {
        threw = true;
        assert.ok(err instanceof ApiClientError);
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.code, 'REVISION_CONFLICT');
        assert.strictEqual(err.message, 'Expected revision 2, found revision 3');
        assert.ok(err.isConflict());
      }
      assert.ok(threw);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('ApiClient CSRF token management on mutating vs non-mutating calls', async () => {
    const originalFetch = globalThis.fetch;
    const recordedHeaders = [];

    try {
      globalThis.fetch = async (url, options) => {
        recordedHeaders.push({ method: options.method, headers: options.headers });
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({ success: true }),
        };
      };

      const client = new ApiClient();
      client.setCsrfToken('test-csrf-token-12345');

      // 1. GET request should NOT attach X-CSRF-Token
      await client.getPublicSubjects();
      assert.strictEqual(recordedHeaders[0].headers['X-CSRF-Token'], undefined);

      // 2. POST login should attach X-CSRF-Token
      await client.login({ username: 'admin', password: 'secret' });
      assert.strictEqual(recordedHeaders[1].headers['X-CSRF-Token'], 'test-csrf-token-12345');

      // 3. Logout should clear CSRF token
      await client.logout();
      assert.strictEqual(client.getCsrfToken(), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('ApiClient Retry-After header variations (missing, seconds, date/invalid)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      // 1. Missing Retry-After
      globalThis.fetch = async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: createMockHeaders(),
        json: async () => ({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limited' } }),
      });
      const client = new ApiClient();
      let err1;
      try { await client.getPublicSubjects(); } catch (e) { err1 = e; }
      assert.strictEqual(err1.retryAfter, undefined);

      // 2. Numeric seconds
      globalThis.fetch = async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: createMockHeaders([['retry-after', '30']]),
        json: async () => ({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limited' } }),
      });
      let err2;
      try { await client.getPublicSubjects(); } catch (e) { err2 = e; }
      assert.strictEqual(err2.retryAfter, 30);

      // 3. HTTP Date header (RFC 7231)
      globalThis.fetch = async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: createMockHeaders([['retry-after', 'Wed, 21 Oct 2026 07:28:00 GMT']]),
        json: async () => ({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limited' } }),
      });
      let err3;
      try { await client.getPublicSubjects(); } catch (e) { err3 = e; }
      if (Number.isNaN(err3.retryAfter)) {
        warn('ApiClient Retry-After parsing on HTTP Date',
          `retryAfter is NaN when Retry-After contains HTTP date string instead of integer seconds`);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('Advanced XSS vectors: SVG, MathML, data URIs, mutation payloads', async () => {
    const advancedPayloads = [
      '<svg><animate onbegin=alert(1)>',
      '<svg><set attributeName=onmouseover to=alert(1)>',
      '<math><maction actiontype="statusline#http://attacker.com">click</maction></math>',
      '<object data="javascript:alert(1)"></object>',
      '<embed src="javascript:alert(1)">',
      '<details ontoggle="alert(1)">toggle</details>',
      '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Data XSS</a>',
      '<form action="https://attacker.com"><button>Submit</button></form>',
    ];

    for (const p of advancedPayloads) {
      const result = renderMarkdown(p);
      assertNoXss(result.html);
    }
  });

  await test('Lightbox and link interaction when image is wrapped in anchor', async () => {
    const md = '[![Картинка](/media/screenshot.png)](https://external.example.com)';
    const result = renderMarkdown(md);

    assert.ok(result.html.includes('href="https://external.example.com"'), 'Must contain anchor');
    assert.ok(result.html.includes('data-lightbox="true"'), 'Must contain lightbox attribute');
    assert.ok(result.html.includes('target="_blank"'), 'Must open external in blank');
  });

  // ============================================================================
  // SUITE 4: ATTACHMENT TRAY FORMATTING & ICONS
  // ============================================================================
  console.log('\n--- SUITE 4: Attachment Tray Byte Formatting & Icons ---');

  await test('formatBytes handles zero, boundary, and standard sizes correctly', async () => {
    assert.strictEqual(formatBytes(0), '0 Б');
    assert.strictEqual(formatBytes(-10), '0 Б');
    assert.strictEqual(formatBytes(1), '1 Б');
    assert.strictEqual(formatBytes(512), '512 Б');
    assert.strictEqual(formatBytes(1023), '1023 Б');
    assert.strictEqual(formatBytes(1024), '1 КБ');
    assert.strictEqual(formatBytes(1536), '1.5 КБ');
    assert.strictEqual(formatBytes(1048576), '1 МБ');
    assert.strictEqual(formatBytes(10485760), '10 МБ');
    assert.strictEqual(formatBytes(52428800), '50 МБ');
    assert.strictEqual(formatBytes(1073741824), '1 ГБ');
  });

  await test('formatBytes behavior on extreme values (>= 1 TiB, NaN)', async () => {
    const tb = 1024 * 1024 * 1024 * 1024;
    const formattedTb = formatBytes(tb);
    if (formattedTb.includes('undefined')) {
      warn('formatBytes overflow on >= 1 TiB',
        `formatBytes(${tb}) returned "${formattedTb}" because sizes array only goes up to ГБ`);
    }

    const formattedNan = formatBytes(NaN);
    if (formattedNan.includes('undefined') || formattedNan.includes('NaN')) {
      warn('formatBytes on NaN',
        `formatBytes(NaN) returned "${formattedNan}" without fallback`);
    }
  });

  await test('getFileIcon maps MIME types and file extensions to appropriate icons', async () => {
    assert.strictEqual(getFileIcon('application/pdf', 'guide.pdf'), '📕');
    assert.strictEqual(getFileIcon('application/octet-stream', 'manual.PDF'), '📕');

    assert.strictEqual(getFileIcon('application/zip', 'archive.zip'), '📦');
    assert.strictEqual(getFileIcon('application/x-tar', 'data.tar'), '📦');
    assert.strictEqual(getFileIcon('application/gzip', 'bundle.gz'), '📦');

    assert.strictEqual(getFileIcon('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx'), '📝');
    assert.strictEqual(getFileIcon('application/msword', 'old.doc'), '📝');

    assert.strictEqual(getFileIcon('text/plain', 'readme.txt'), '📃');
    assert.strictEqual(getFileIcon('text/markdown', 'notes.md'), '📃');

    assert.strictEqual(getFileIcon('application/octet-stream', 'binary.bin'), '📎');
  });

  // ============================================================================
  // SUITE 5: LIGHTBOX, CODE COPY & DOM EVENT DELEGATION
  // ============================================================================
  console.log('\n--- SUITE 5: Lightbox, Code Copy & Event Delegation ---');

  await test('Markdown pipeline wraps code fences with copy button, badge, and pre/code', async () => {
    const md = '```python\nprint("Hello World")\n```';
    const result = renderMarkdown(md);

    assert.ok(result.html.includes('class="code-block-wrapper"'), 'Must have code-block-wrapper');
    assert.ok(result.html.includes('class="code-block-header"'), 'Must have code-block-header');
    assert.ok(result.html.includes('class="code-lang-badge">python</span>'), 'Must have code-lang-badge');
    assert.ok(result.html.includes('class="code-copy-btn" data-copy-btn="true"'), 'Must have code-copy-btn');
    assert.ok(result.html.includes('<pre><code class="language-python">'), 'Must have pre code language-python');
  });

  await test('handleCodeCopyClick copies code content using navigator.clipboard', async () => {
    let copiedText = '';
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: async (text) => {
            copiedText = text;
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const container = dom.window.document.createElement('div');
    container.innerHTML = `
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <button type="button" class="code-copy-btn" data-copy-btn="true">
            <span class="copy-icon">📋</span>
            <span class="copy-text">Копировать</span>
          </button>
        </div>
        <pre><code>let x = 42;</code></pre>
      </div>
    `;
    dom.window.document.body.appendChild(container);

    const btn = container.querySelector('.code-copy-btn');
    const icon = container.querySelector('.copy-icon');

    const clickEvent = new dom.window.MouseEvent('click', { bubbles: true });
    Object.defineProperty(clickEvent, 'target', { value: icon });

    handleCodeCopyClick(clickEvent);

    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(copiedText, 'let x = 42;');
    assert.ok(btn.classList.contains('copied'));
    assert.strictEqual(container.querySelector('.copy-text').textContent, 'Скопировано!');
  });

  await test('handleCodeCopyClick falls back to execCommand when clipboard API is unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });

    let execCommandCalled = false;
    let copiedValue = '';
    dom.window.document.execCommand = (cmd) => {
      if (cmd === 'copy') {
        execCommandCalled = true;
        const textarea = dom.window.document.querySelector('textarea');
        if (textarea) copiedValue = textarea.value;
        return true;
      }
      return false;
    };

    const container = dom.window.document.createElement('div');
    container.innerHTML = `
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <button type="button" class="code-copy-btn" data-copy-btn="true">
            <span class="copy-text">Копировать</span>
          </button>
        </div>
        <pre><code>SELECT * FROM users;</code></pre>
      </div>
    `;
    dom.window.document.body.appendChild(container);

    const btn = container.querySelector('.code-copy-btn');
    const clickEvent = new dom.window.MouseEvent('click', { bubbles: true });
    Object.defineProperty(clickEvent, 'target', { value: btn });

    handleCodeCopyClick(clickEvent);

    assert.ok(execCommandCalled, 'document.execCommand should be called on fallback');
    assert.strictEqual(copiedValue, 'SELECT * FROM users;');
    assert.strictEqual(container.querySelector('.copy-text').textContent, 'Скопировано!');
  });

  await test('Image lightbox markup has data-lightbox="true" and markdown-image class', async () => {
    const md = '![Архитектура системы](/media/arch.png)';
    const result = renderMarkdown(md);

    assert.ok(result.html.includes('data-lightbox="true"'));
    assert.ok(result.html.includes('class="markdown-image"'));
    assert.ok(result.html.includes('loading="lazy"'));
    assert.ok(result.html.includes('decoding="async"'));
    assert.ok(result.html.includes('src="/media/arch.png"'));
    assert.ok(result.html.includes('alt="Архитектура системы"'));
  });

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n================================================================');
  console.log(`TEST RUN COMPLETE: ${stats.passed}/${stats.total} tests passed, ${stats.failed} failed, ${stats.warnings} warnings`);
  console.log('================================================================');

  if (findings.length > 0) {
    console.log('\nFindings / Adversarial Observations:');
    for (const f of findings) {
      console.log(`- [${f.severity}] ${f.test}: ${f.error}`);
    }
  }

  if (stats.failed > 0) {
    process.exit(1);
  }
}

await runAll();
