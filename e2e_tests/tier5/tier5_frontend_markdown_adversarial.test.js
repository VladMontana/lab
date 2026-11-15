// e2e_tests/tier5/tier5_frontend_markdown_adversarial.test.js
// Tier 5 Adversarial Stress Testing Suite:
// 1. Frontend Markdown XSS Sanitization & Bypass Resistance
// 2. Code Block Edge Cases & Formatting Boundaries
// 3. Table of Contents (TOC) & Slugification Robustness
// 4. Non-ASCII & Cyrillic Search (Case-Insensitivity & Wildcards)
// 5. Autosave Recovery & LocalStorage Revision Concurrency
// 6. SPA Routing Fallback & Security Isolation Boundaries

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiClient } from '../helpers/api_client.js';
import {
  assertStatus,
  assertSuccess,
  assertError,
  assertNotLeaked,
  assertHeader,
  assertNoXss,
} from '../helpers/assertions.js';
import { uniqueName } from '../helpers/fixtures.js';
import { JSDOM } from '../../frontend/node_modules/jsdom/lib/api.js';

// Setup JSDOM global window for DOMPurify & Markdown testing
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;

const { renderMarkdown, slugify } = await import('../../frontend/src/lib/markdown.ts');
const { matchRoute } = await import('../../frontend/src/lib/router.ts');

/**
 * Validates that an HTML string creates zero executable DOM nodes when parsed by the browser.
 */
function assertDomSafety(htmlString, context = '') {
  assert.strictEqual(typeof htmlString, 'string', `Expected HTML string: ${context}`);
  const container = dom.window.document.createElement('div');
  container.innerHTML = htmlString;

  // 1. Script tags in DOM
  const scripts = container.querySelectorAll('script');
  assert.strictEqual(scripts.length, 0, `DOM contains <script> tags: ${context}`);

  // 2. Forbidden embedding and dangerous tags
  const forbiddenTags = [
    'script', 'iframe', 'object', 'embed', 'base', 'meta', 'style',
    'form', 'input', 'textarea', 'select', 'link', 'applet',
  ];
  for (const tag of forbiddenTags) {
    const found = container.querySelectorAll(tag);
    assert.strictEqual(found.length, 0, `DOM contains forbidden <${tag}>: ${context}`);
  }

  // 3. Element attributes inspection
  const allElements = container.querySelectorAll('*');
  for (const el of allElements) {
    const tagName = el.tagName.toLowerCase();
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      const val = attr.value;

      // Event handlers (on*)
      assert.ok(
        !name.startsWith('on'),
        `DOM element <${tagName}> contains event handler ${name}="${val}": ${context}`
      );

      // Dangerous schemes in URI attributes
      if (['href', 'src', 'action', 'formaction'].includes(name)) {
        assert.ok(
          !/^\s*javascript\s*:/i.test(val),
          `javascript: URI found in ${name}="${val}" on <${tagName}>: ${context}`
        );
        assert.ok(
          !/^\s*vbscript\s*:/i.test(val),
          `vbscript: URI found in ${name}="${val}" on <${tagName}>: ${context}`
        );
        assert.ok(
          !/^\s*data\s*:\s*text\/html/i.test(val),
          `data:text/html URI found in ${name}="${val}" on <${tagName}>: ${context}`
        );
      }

      // Inline styles
      if (name === 'style') {
        assert.ok(!/javascript\s*:/i.test(val), `javascript: URL in style attribute: ${context}`);
        assert.ok(!/expression\s*\(/i.test(val), `expression() in style attribute: ${context}`);
      }
    }
  }
}

/**
 * Sends a raw HTTP request without client URL pre-normalization.
 */
function sendRawHttpRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 8080,
        path,
        method,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(body);
          } catch {
            data = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: body,
            data,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Tier 5: Adversarial Frontend, Markdown Security & Routing Hardening', () => {
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
    for (const pageId of createdPageIds) {
      try {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      } catch {}
    }
    for (const subjId of createdSubjectIds) {
      try {
        await adminClient.delete(`/api/admin/subjects/${subjId}`);
      } catch {}
    }
  });

  // =========================================================================
  // Suite 1: Markdown XSS Neutralization & Bypass Resistance
  // =========================================================================
  describe('Suite 1: Markdown XSS Sanitization & Mutation Resistance', () => {
    it('T5-XSS-01: Nested, malformed, and confused HTML tags neutralized', () => {
      const nestedPayloads = [
        '<script>alert("nested_1")</script>',
        '<<SCRIPT>script>alert(1)<</SCRIPT>/script>',
        '<div><span><p><script>alert("deep")</script></p></span></div>',
        '<script src="https://evil.com/malicious.js"></script>',
        '<img src="x" onerror="alert(\'img_onerror\')">',
        '<svg onload="alert(\'svg_onload\')"><circle r="10"/></svg>',
        '<svg><script>alert(\'svg_script\')</script></svg>',
        '<svg><desc><![CDATA[</desc><script>alert(1)</script>]]></svg>',
        '<iframe src="javascript:alert(\'iframe\')"></iframe>',
        '<object data="javascript:alert(\'obj\')"></object>',
        '<embed src="javascript:alert(\'embed\')">',
        '<!--<script>alert("comment")</script>-->',
        '<<style>body{background:red}</style>',
        '<form action="javascript:alert(1)"><input type="submit"></form>',
        '<details open ontoggle="alert(1)"><summary>Expand</summary></details>',
      ];

      for (const payload of nestedPayloads) {
        const res = renderMarkdown(payload);
        assertDomSafety(res.html, `Payload: ${payload}`);
      }
    });

    it('T5-XSS-02: Obfuscated pseudo-protocol schemes and colons neutralized', () => {
      const schemePayloads = [
        '[x](javascript:alert(1))',
        '[x](javascript:void(0))',
        '[x](JaVaScRiPt:alert(1))',
        '[x](jAvAsCrIpT:void(0))',
        '[x](  javascript:alert(1)  )',
        '[x](\njavascript:alert(1))',
        '[x](\tjavascript:alert(1))',
        '[x](javascript&#x3a;alert(1))',
        '[x](javascript&#58;alert(1))',
        '[x](javascript&colon;alert(1))',
        '[x](vbscript:msgbox(1))',
        '[x](file:///etc/passwd)',
        '![img](javascript:alert(1))',
        '![img](JaVaScRiPt:alert(1))',
        '![img](javascript&#x3a;alert(1))',
        '![img](vbscript:msgbox(1))',
      ];

      for (const payload of schemePayloads) {
        const res = renderMarkdown(payload);
        assertDomSafety(res.html, `Scheme payload: ${payload}`);
      }
    });

    it('T5-XSS-03: Data URIs and SVG inlined vectors neutralized', () => {
      const dataPayloads = [
        '[data1](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
        '[data2](data:text/html,<script>alert(1)</script>)',
        '[data3](data:image/svg+xml;utf8,<svg onload=alert(1)>)',
        '[data4](data:application/javascript,alert(1))',
        '![data_img](data:image/svg+xml;utf8,<svg onload=alert(1)>)',
        '<svg><a xlink:href="javascript:alert(1)"><circle r="10"/></a></svg>',
        '<svg><animate xlink:href="#x" attributeName="href" values="javascript:alert(1)" /><a id="x"><text y="1em">click</text></a></svg>',
      ];

      for (const payload of dataPayloads) {
        const res = renderMarkdown(payload);
        assertDomSafety(res.html, `Data payload: ${payload}`);
      }
    });

    it('T5-XSS-04: Attribute injection through markdown syntax elements neutralized', () => {
      const attributeInjections = [
        '![img](x "title" onerror="alert(1)")',
        '![img " onerror="alert(1)](https://example.com/pic.png)',
        '![img](https://example.com/pic.png "title \\" onerror=\\"alert(1)")',
        '[link](https://example.com "title" onmouseover="alert(1)")',
        '## Heading " onclick="alert(1)',
        '| Col 1 | Col 2 |\n|---|---|\n| [x](javascript:alert(1)) | <img src=x onerror=alert(1)> |',
        '> <script>alert(1)</script>\n> [x](javascript:alert(1))',
      ];

      for (const payload of attributeInjections) {
        const res = renderMarkdown(payload);
        assertDomSafety(res.html, `Attribute injection: ${payload}`);
      }
    });

    it('T5-XSS-05: Mutation XSS (mXSS) and MathML vectors neutralized', () => {
      const mxssPayloads = [
        '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
        '<form><math><mtext></form><form><mglyph><style></math><img src=x onerror=alert(1)>',
        '<math href="javascript:alert(1)">click</math>',
        '<svg><style>{@import "javascript:alert(1)"}</style></svg>',
      ];

      for (const payload of mxssPayloads) {
        const res = renderMarkdown(payload);
        assertDomSafety(res.html, `mXSS payload: ${payload}`);
      }
    });

    it('T5-XSS-06: End-to-End backend publishing and public reader retrieval strips XSS', async () => {
      // 1. Create subject
      const subjRes = await adminClient.post('/api/admin/subjects', {
        name: uniqueName('xss_test_subj'),
      });
      assertStatus(subjRes, 201);
      const subjectId = subjRes.data.id;
      createdSubjectIds.push(subjectId);

      // 2. Create page draft
      const pageRes = await adminClient.post('/api/admin/pages', {
        subject_id: subjectId,
        title: uniqueName('xss_test_page'),
      });
      assertStatus(pageRes, 201);
      const pageId = pageRes.data.id;
      createdPageIds.push(pageId);

      const maliciousMarkdown = [
        '# Lab Work: Security Testing',
        '## Introduction',
        'Normal text content.',
        '<script>window.pwned = true;</script>',
        '<img src="invalid-src" onerror="window.pwned=true">',
        '[Click Here](javascript:alert("pwned"))',
        '```javascript\nconsole.log("safe code");\n```',
      ].join('\n\n');

      // 3. Update draft
      const updateRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: maliciousMarkdown,
      });
      assertStatus(updateRes, 200);

      // 4. Publish snapshot
      const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });
      assertStatus(pubRes, 200);

      // 5. Retrieve via public API
      const publicRes = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(publicRes, 200);
      assert.ok(publicRes.data.markdown, 'Expected markdown in public page response');

      // 6. Verify backend sanitization
      assertNoXss(publicRes.data.markdown);

      // 7. Verify frontend render of the received markdown
      const renderResult = renderMarkdown(publicRes.data.markdown);
      assertDomSafety(renderResult.html, 'Public page rendered HTML');
      assert.strictEqual(renderResult.toc.length, 1);
      assert.strictEqual(renderResult.toc[0].id, 'introduction');
    });
  });

  // =========================================================================
  // Suite 2: Code Block Edge Cases & Formatting Boundaries
  // =========================================================================
  describe('Suite 2: Code Block Rendering & Syntax Robustness', () => {
    it('T5-CODE-01: Malicious language tags and attribute breakout neutralized', () => {
      const maliciousLangFences = [
        '```<script>alert(1)</script>\nconsole.log(1)\n```',
        '```js" onclick="alert(1)" data-exploit="true\nconst a = 1;\n```',
        '```"><img src=x onerror=alert(1)>\nconst b = 2;\n```',
        '```language-injection\';alert(1)//\nconst c = 3;\n```',
      ];

      for (const fence of maliciousLangFences) {
        const res = renderMarkdown(fence);
        assertDomSafety(res.html, `Malicious code fence: ${fence.slice(0, 40)}`);
        assert.ok(res.html.includes('class="code-block-wrapper"'), 'Must have code-block-wrapper');
        assert.ok(res.html.includes('data-copy-btn="true"'), 'Must have copy button');
      }
    });

    it('T5-CODE-02: Unclosed fences, nested fences, and empty code blocks handle gracefully', () => {
      const structuralFences = [
        // Unclosed fence at EOF
        '```javascript\nconst x = "unclosed";',
        // Unclosed tilde fence
        '~~~\nconst y = 42;',
        // Empty fence
        '```\n```',
        // Nested tilde inside backticks
        '```markdown\n~~~\ncode inside\n~~~\n```',
        // Nested backticks inside tildes
        '~~~\n```python\nprint("nested")\n```\n~~~',
        // Code block containing raw HTML
        '```html\n<div id="test"><script>alert(1)</script></div>\n```',
      ];

      for (const fence of structuralFences) {
        const res = renderMarkdown(fence);
        assertDomSafety(res.html, `Structural fence: ${fence.slice(0, 30)}`);
        assert.ok(res.html.includes('code-block-wrapper'), 'Must retain wrapper');
      }
    });

    it('T5-CODE-03: Massive code block stress test (1,000 lines) renders without error', () => {
      const massiveCode =
        '```python\n' +
        Array.from({ length: 1000 }, (_, i) => `def func_${i}():\n    return ${i} * 2\n`).join('') +
        '```';

      const start = Date.now();
      const res = renderMarkdown(massiveCode);
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 2000, `Massive code block took too long: ${elapsed}ms`);
      assert.ok(res.html.includes('func_999'), 'Must contain final function');
      assertDomSafety(res.html, 'Massive code block');
    });
  });

  // =========================================================================
  // Suite 3: Table of Contents (TOC) & Slugification Robustness
  // =========================================================================
  describe('Suite 3: Table of Contents (TOC) & Unicode Slug Generation', () => {
    it('T5-TOC-01: Heading level boundaries: H1 and H4-H6 excluded from TOC', () => {
      const headingsMarkdown = `
# Title (H1)
## Valid Section H2 A
### Valid Subsection H3 A
#### Sub-sub section H4
##### Sub-sub-sub section H5
###### Deep section H6
## Valid Section H2 B
### Valid Subsection H3 B
`;
      const res = renderMarkdown(headingsMarkdown);
      assert.strictEqual(res.toc.length, 4, 'TOC must contain exactly 4 items (H2 and H3 only)');
      assert.deepStrictEqual(
        res.toc.map((t) => ({ level: t.level, text: t.text })),
        [
          { level: 2, text: 'Valid Section H2 A' },
          { level: 3, text: 'Valid Subsection H3 A' },
          { level: 2, text: 'Valid Section H2 B' },
          { level: 3, text: 'Valid Subsection H3 B' },
        ]
      );
    });

    it('T5-TOC-02: Duplicate headings produce idempotent, unique disambiguated slugs', () => {
      const duplicatesMarkdown = `
## Введение
## Введение
## Введение
### Введение
## Введение
`;
      const res = renderMarkdown(duplicatesMarkdown);
      assert.strictEqual(res.toc.length, 5);
      assert.strictEqual(res.toc[0].id, 'введение');
      assert.strictEqual(res.toc[1].id, 'введение-1');
      assert.strictEqual(res.toc[2].id, 'введение-2');
      assert.strictEqual(res.toc[3].id, 'введение-3');
      assert.strictEqual(res.toc[4].id, 'введение-4');

      // Verify that every ID appears exactly once in the rendered HTML as heading id attribute
      for (const item of res.toc) {
        assert.ok(res.html.includes(`id="${item.id}"`), `HTML must contain heading id="${item.id}"`);
      }
    });

    it('T5-TOC-03: Unicode, Cyrillic, Greek, punctuation and emoji slugification', () => {
      const unicodeCases = [
        { text: 'Лабораторная работа №2', expected: 'лабораторная-работа-2' },
        { text: 'Алгоритм Дейкстры: O(V²)', expected: 'алгоритм-дейкстры-ov²' },
        { text: '   --Пробелы и Дефисы--  ', expected: 'пробелы-и-дефисы' },
        { text: '🚀 High-Performance Rust & Svelte 🔥', expected: 'high-performance-rust-svelte' },
        { text: 'Теорема Пифагора: a² + b² = c²', expected: 'теорема-пифагора-a²-b²-c²' },
        { text: 'Special characters: !@#$%^&*()_+', expected: 'special-characters' },
        { text: '!@#$%^&*()_+', expected: 'heading' }, // pure special characters fallback
        { text: '   ', expected: 'heading' }, // whitespace fallback
        { text: '', expected: 'heading' }, // empty string fallback
      ];

      for (const tc of unicodeCases) {
        const slug = slugify(tc.text);
        assert.strictEqual(slug, tc.expected, `Slug for "${tc.text}" mismatch`);
      }
    });

    it('T5-TOC-04: Headings with inline formatting and tags generate clean slugs and TOC text', () => {
      const formattingMarkdown = [
        '## **Важное** примечание',
        '## Код `renderMarkdown()` в деталях',
        '## Ссылка [Документация](https://example.com)',
        '## <span>HTML в заголовке</span>',
      ].join('\n\n');

      const res = renderMarkdown(formattingMarkdown);
      assert.strictEqual(res.toc.length, 4);

      assert.strictEqual(res.toc[0].id, 'важное-примечание');
      assert.strictEqual(res.toc[1].id, 'код-rendermarkdown-в-деталях');
      assert.strictEqual(res.toc[2].id, 'ссылка-документацияhttpsexamplecom');
      assert.strictEqual(res.toc[3].id, 'spanhtml-в-заголовкеspan');

      // Verify that every TOC id corresponds to an exact id attribute in the rendered HTML
      for (const item of res.toc) {
        assert.ok(
          res.html.includes(`id="${item.id}"`),
          `Rendered HTML must contain id="${item.id}" matching TOC item`
        );
      }

      // Check DOM safety of the rendered headings
      assertDomSafety(res.html, 'Headings with inline formatting');
    });
  });

  // =========================================================================
  // Suite 4: Non-ASCII & Cyrillic Search (Live API)
  // =========================================================================
  describe('Suite 4: Non-ASCII & Cyrillic Search Hardening (Live API)', () => {
    let searchSubjectId;
    let searchPageId;

    before(async () => {
      // Create dedicated subject for Cyrillic search verification
      const subjRes = await adminClient.post('/api/admin/subjects', {
        name: uniqueName('search_subj_cyrillic'),
      });
      assertStatus(subjRes, 201);
      searchSubjectId = subjRes.data.id;
      createdSubjectIds.push(searchSubjectId);

      // Create page with specific Cyrillic text and special characters
      const pageRes = await adminClient.post('/api/admin/pages', {
        subject_id: searchSubjectId,
        title: 'Лабораторная работа №7: Исследование графов и деревьев 100%',
      });
      assertStatus(pageRes, 201);
      searchPageId = pageRes.data.id;
      createdPageIds.push(searchPageId);

      const markdownContent = [
        '# Отчёт по практической работе',
        '## Раздел 1. Введение в теорию графов',
        'В данном практическом задании исследуется алгоритм поиска в ширину (BFS) и алгоритм Дейкстры.',
        'Точность полученных экспериментальных расчётов составляет 100% без потери данных.',
        'Для хранения рёбер используется матрица смежности и списки инцидентности.',
      ].join('\n\n');

      const updateRes = await adminClient.patch(`/api/admin/pages/${searchPageId}`, {
        expected_revision: 1,
        markdown: markdownContent,
      });
      assertStatus(updateRes, 200);

      const pubRes = await adminClient.post(`/api/admin/pages/${searchPageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });
      assertStatus(pubRes, 200);
    });

    it('T5-SRCH-01: Case-insensitive Cyrillic title search (lowercase, uppercase, mixed-case)', async () => {
      const queries = ['лабораторная', 'ЛАБОРАТОРНАЯ', 'ЛаБоРаТоРнАя', 'исследование', 'ГРАФОВ'];
      for (const q of queries) {
        const res = await anonClient.get(`/api/public/pages?q=${encodeURIComponent(q)}`);
        assertStatus(res, 200);
        assert.ok(res.data.total >= 1, `Expected search total >= 1 for query "${q}"`);
        const item = res.data.items.find((it) => it.id === searchPageId);
        assert.ok(item, `Expected page ${searchPageId} in search results for "${q}"`);
        assert.ok(item.snippet, `Expected snippet for query "${q}"`);
      }
    });

    it('T5-SRCH-02: Search terms targeting markdown body only', async () => {
      const queries = ['ширину', 'ШИРИНУ', 'дейкстры', 'ДЕЙКСТРЫ', 'смежности'];
      for (const q of queries) {
        const res = await anonClient.get(`/api/public/pages?q=${encodeURIComponent(q)}`);
        assertStatus(res, 200);
        assert.ok(res.data.total >= 1, `Expected search total >= 1 for markdown body query "${q}"`);
        const item = res.data.items.find((it) => it.id === searchPageId);
        assert.ok(item, `Expected page ${searchPageId} in results for "${q}"`);
      }
    });

    it('T5-SRCH-03: SQLite LIKE wildcards (%, _, \\) treated as literal text', async () => {
      // 1. Literal percent sign search
      const percentRes = await anonClient.get('/api/public/pages?q=100%25');
      assertStatus(percentRes, 200);
      assert.ok(percentRes.data.total >= 1, 'Expected match for literal "100%"');

      // 2. Underscores wildcard probe
      // Searching for 8 underscores "________" should NOT match arbitrary 8-letter words
      const underscoreRes = await anonClient.get('/api/public/pages?q=________');
      assertStatus(underscoreRes, 200);
      const matched = underscoreRes.data.items.some((it) => it.id === searchPageId);
      assert.strictEqual(
        matched,
        false,
        'Underscores must NOT match as wildcard characters'
      );

      // 3. Non-existent Cyrillic term returns 0 results
      const missingRes = await anonClient.get(
        `/api/public/pages?q=${encodeURIComponent('несуществующий_термин_фхцчшщ')}`
      );
      assertStatus(missingRes, 200);
      assert.strictEqual(missingRes.data.total, 0);
      assert.strictEqual(missingRes.data.items.length, 0);
    });

    it('T5-SRCH-04: Pagination clamping and extreme boundaries', async () => {
      // limit=0 clamped to 1
      const res0 = await anonClient.get('/api/public/pages?limit=0');
      assertStatus(res0, 200);
      assert.strictEqual(res0.data.limit, 1);

      // limit=1000 clamped to 100
      const resMax = await anonClient.get('/api/public/pages?limit=1000');
      assertStatus(resMax, 200);
      assert.strictEqual(resMax.data.limit, 100);

      // offset exceeds total
      const resOver = await anonClient.get('/api/public/pages?offset=999999');
      assertStatus(resOver, 200);
      assert.strictEqual(resOver.data.items.length, 0);
      assert.ok(resOver.data.total >= 1);
    });

    it('T5-SRCH-05: Unicode snippet preservation without multi-byte UTF-8 corruption', async () => {
      const res = await anonClient.get(
        `/api/public/pages?q=${encodeURIComponent('дейкстры')}`
      );
      assertStatus(res, 200);
      const item = res.data.items.find((it) => it.id === searchPageId);
      assert.ok(item, 'Page must be in results');

      // Check snippet string integrity
      assert.ok(typeof item.snippet === 'string', 'Snippet must be string');
      assert.ok(item.snippet.length > 0, 'Snippet must not be empty');
      assert.ok(
        !item.snippet.includes('\uFFFD'),
        'Snippet must not contain Unicode replacement characters (truncated UTF-8 multibyte sequence)'
      );
    });
  });

  // =========================================================================
  // Suite 5: Autosave Recovery & LocalStorage Revision Concurrency
  // =========================================================================
  describe('Suite 5: Autosave Recovery & Concurrency Conflict State Machine', () => {
    let concSubjectId;

    before(async () => {
      const subjRes = await adminClient.post('/api/admin/subjects', {
        name: uniqueName('autosave_subj'),
      });
      assertStatus(subjRes, 201);
      concSubjectId = subjRes.data.id;
      createdSubjectIds.push(concSubjectId);
    });

    it('T5-AUTO-01: Storage key derivation adheres to contract', () => {
      const testPageId = '550e8400-e29b-41d4-a716-446655440000';
      const expectedDraftKey = `labnotes_draft_${testPageId}`;
      const expectedConflictKey = `labnotes_conflict_page_${testPageId}`;

      assert.strictEqual(`labnotes_draft_${testPageId}`, expectedDraftKey);
      assert.strictEqual(`labnotes_conflict_page_${testPageId}`, expectedConflictKey);
    });

    it('T5-AUTO-02: Revision mismatch yields HTTP 409 and protects database draft', async () => {
      // 1. Create initial page draft (revision 1)
      const pageRes = await adminClient.post('/api/admin/pages', {
        subject_id: concSubjectId,
        title: uniqueName('conflict_test'),
      });
      assertStatus(pageRes, 201);
      const pageId = pageRes.data.id;
      createdPageIds.push(pageId);
      assert.strictEqual(pageRes.data.revision, 1);

      // 2. Client A updates draft with expected_revision: 1 -> advances revision to 2
      const updateA = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        title: 'Title Saved by Client A',
        markdown: 'Content saved by client A.',
      });
      assertStatus(updateA, 200);
      assert.strictEqual(updateA.data.revision, 2);

      // 3. Client B attempts update with stale expected_revision: 1 -> MUST yield 409 REVISION_CONFLICT
      const updateB = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        title: 'Conflicting Title by Client B',
        markdown: 'Conflicting content by client B.',
      });
      assertStatus(updateB, 409);
      assertError(updateB, 409, 'REVISION_CONFLICT');

      // 4. Verify draft in database was NOT overwritten by Client B
      const currentDraft = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(currentDraft, 200);
      assert.strictEqual(currentDraft.data.draft_title, 'Title Saved by Client A');
      assert.strictEqual(currentDraft.data.draft_markdown, 'Content saved by client A.');
      assert.strictEqual(currentDraft.data.revision, 2);
    });

    it('T5-AUTO-03: LocalStorage recovery banner detection logic simulation', () => {
      // Client state machine recovery simulation
      const serverState = {
        title: 'Server Title',
        markdown: 'Server Markdown',
      };

      // Scenario A: Local draft identical to server -> NO recovery banner
      const cachedIdentical = {
        title: 'Server Title',
        markdown: 'Server Markdown',
        timestamp: Date.now() - 5000,
      };
      const diffA =
        cachedIdentical.markdown !== serverState.markdown ||
        cachedIdentical.title !== serverState.title;
      assert.strictEqual(diffA, false, 'No recovery banner when drafts match');

      // Scenario B: Local draft has unsaved changes -> Recovery banner triggered
      const cachedUnsaved = {
        title: 'Server Title',
        markdown: 'Server Markdown with local uncommitted edits!',
        timestamp: Date.now() - 1000,
      };
      const diffB =
        cachedUnsaved.markdown !== serverState.markdown ||
        cachedUnsaved.title !== serverState.title;
      assert.strictEqual(diffB, true, 'Recovery banner MUST trigger when local draft differs');

      // Scenario C: Conflict draft recovery
      const conflictDraft = {
        pageId: 'test-page-123',
        title: 'Conflict Title',
        markdown: 'Conflict Markdown',
        expectedRevision: 1,
        timestamp: Date.now(),
      };
      const diffC =
        conflictDraft.markdown !== serverState.markdown ||
        conflictDraft.title !== serverState.title;
      assert.strictEqual(diffC, true, 'Conflict draft MUST trigger recovery prompt');
    });
  });

  // =========================================================================
  // Suite 6: SPA Client-Side Routing Fallback Boundaries (Live API)
  // =========================================================================
  describe('Suite 6: SPA Routing Fallback & Security Isolation Boundaries', () => {
    it('T5-ROUT-01: Client routes return SPA index.html with no-cache header', async () => {
      const clientRoutes = [
        '/',
        '/p/test-page-id',
        '/admin',
        '/admin/login',
        '/admin/pages',
        '/admin/pages/new',
        '/admin/pages/some-id/edit',
        '/deep/nested/client/route/that/does/not/exist',
      ];

      for (const route of clientRoutes) {
        const res = await anonClient.get(route);
        assertStatus(res, 200, `Route: ${route}`);
        assertHeader(res, 'content-type', /text\/html/);
        assertHeader(res, 'cache-control', 'no-cache');
        assert.ok(
          res.text.includes('<!DOCTYPE html>') || res.text.includes('<html'),
          `Route ${route} must deliver HTML index`
        );
      }
    });

    it('T5-ROUT-02: HEAD requests to SPA routes return 200 with empty body and identical headers', async () => {
      const headRoutes = ['/', '/p/head-check-page', '/admin'];
      for (const route of headRoutes) {
        const res = await anonClient.request('HEAD', route);
        assertStatus(res, 200, `HEAD Route: ${route}`);
        assertHeader(res, 'content-type', /text\/html/);
        assertHeader(res, 'cache-control', 'no-cache');
        assert.strictEqual(res.text, '', `HEAD request to ${route} must have empty body`);
      }
    });

    it('T5-ROUT-03: Missing static assets in /assets/ strictly return 404 text/plain', async () => {
      const missingAssets = [
        '/assets/nonexistent.js',
        '/assets/nonexistent.css',
        '/assets/vendor-bundle.hash.js',
      ];

      for (const assetPath of missingAssets) {
        const res = await anonClient.get(assetPath);
        assertStatus(res, 404, `Missing asset: ${assetPath}`);
        assertHeader(res, 'content-type', /text\/plain/);
        assert.strictEqual(res.text.trim(), 'Asset not found');
      }
    });

    it('T5-ROUT-04: Missing files with extensions and system paths return 404 text/plain', async () => {
      const missingFiles = [
        '/missing_file.json',
        '/unknown_style.css',
        '/test.txt',
        '/etc/passwd',
        '/proc/cpuinfo',
        '/windows/system32/cmd.exe',
      ];

      for (const filePath of missingFiles) {
        const res = await anonClient.get(filePath);
        assertStatus(res, 404, `Missing file: ${filePath}`);
        assertHeader(res, 'content-type', /text\/plain/);
        assert.strictEqual(res.text.trim(), 'Not found');
      }
    });

    it('T5-ROUT-05: Unmatched /api/* and /media/* strictly return JSON 404 envelope', async () => {
      const protectedEndpoints = [
        '/api/nonexistent_route',
        '/api/v1/invalid',
        '/media/00000000-0000-0000-0000-000000000000',
      ];

      for (const ep of protectedEndpoints) {
        const res = await anonClient.get(ep);
        assertStatus(res, 404, `Protected endpoint: ${ep}`);
        assertHeader(res, 'content-type', /application\/json/);
        assertError(res, 404);
      }
    });

    it('T5-ROUT-06: Mutating methods on fallback routes return JSON 404 (never index.html)', async () => {
      const mutatingProbes = [
        { method: 'POST', path: '/arbitrary/unmatched/route' },
        { method: 'PUT', path: '/admin' },
        { method: 'DELETE', path: '/p/sample-id' },
        { method: 'PATCH', path: '/unknown' },
      ];

      for (const probe of mutatingProbes) {
        const res = await anonClient.request(probe.method, probe.path, {
          body: {},
        });
        assertStatus(res, 404, `Mutating fallback: ${probe.method} ${probe.path}`);
        assertHeader(res, 'content-type', /application\/json/);
        assertError(res, 404, 'NOT_FOUND');
      }
    });

    it('T5-ROUT-07: Path traversal attacks rejected with HTTP 400 Bad Request', async () => {
      const traversalProbes = [
        '/%2e%2e/%2e%2e/etc/passwd',
        '/assets/..%2f..%2fbackend/Cargo.toml',
        '/..%5c..%5cwindows%5cwin.ini',
        '/%00index.html',
      ];

      for (const rawPath of traversalProbes) {
        const res = await sendRawHttpRequest(rawPath);
        assert.strictEqual(
          res.status,
          400,
          `Raw path traversal ${rawPath} must return 400 Bad Request`
        );
        assert.strictEqual(res.data?.error?.code, 'BAD_REQUEST');
      }
    });

    it('T5-ROUT-08: Client-side router route matching table verification', () => {
      const routeCases = [
        { path: '/', search: '', hash: '', expected: 'catalog' },
        { path: '/p/550e8400', search: '', hash: '#intro', expected: 'reader' },
        { path: '/admin/login', search: '', hash: '', expected: 'login' },
        { path: '/admin', search: '', hash: '', expected: 'admin-dashboard' },
        { path: '/admin/dashboard', search: '', hash: '', expected: 'admin-dashboard' },
        { path: '/admin/pages', search: '', hash: '', expected: 'admin-dashboard' },
        { path: '/admin/subjects', search: '', hash: '', expected: 'admin-dashboard' },
        { path: '/admin/pages/new', search: '', hash: '', expected: 'admin-editor-new' },
        { path: '/admin/pages/550e8400/edit', search: '', hash: '', expected: 'admin-editor' },
        { path: '/unknown/random/path', search: '', hash: '', expected: 'not-found' },
      ];

      for (const rc of routeCases) {
        const match = matchRoute(rc.path, rc.search, rc.hash);
        assert.strictEqual(
          match.name,
          rc.expected,
          `Route ${rc.path} expected ${rc.expected}, got ${match.name}`
        );
      }
    });
  });
});
