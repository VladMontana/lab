import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Setup JSDOM window for DOMPurify testing in Node.js
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;

import { renderMarkdown, slugify } from './src/lib/markdown.ts';
import { matchRoute } from './src/lib/router.ts';
import { ApiClientError } from './src/lib/api.ts';
import { assertNoXss } from '../e2e_tests/helpers/assertions.js';

console.log('--- 1. Testing Slugify & Unicode ---');
assert.strictEqual(slugify('Привет, Мир!'), 'привет-мир');
assert.strictEqual(slugify('Step 1: Introduction'), 'step-1-introduction');
assert.strictEqual(slugify('   --Лабораторная №2 (Часть 1)--  '), 'лабораторная-2-часть-1');
console.log('✓ Slugify tests passed');

console.log('--- 2. Testing Markdown Rendering & TOC ---');
const mdSource = `
# Главный заголовок

Вводный текст.

## Введение
Текст введения.

### Цель работы
Цель работы — изучить работу системы.

## Введение
Второй раздел с таким же названием.

\`\`\`rust
fn main() {
    println!("Hello, LabNotes!");
}
\`\`\`

![Схема архитектуры](/media/diagram-123.png)

| Колонка 1 | Колонка 2 |
|-----------|-----------|
| Данные A  | Данные B  |

[Внешняя ссылка](https://example.com)
`;

const res = renderMarkdown(mdSource);
console.log('TOC items:', JSON.stringify(res.toc, null, 2));

assert.strictEqual(res.toc.length, 3);
assert.deepStrictEqual(res.toc[0], { level: 2, id: 'введение', text: 'Введение' });
assert.deepStrictEqual(res.toc[1], { level: 3, id: 'цель-работы', text: 'Цель работы' });
assert.deepStrictEqual(res.toc[2], { level: 2, id: 'введение-1', text: 'Введение' });

// Check headings IDs in HTML
assert.ok(res.html.includes('id="введение"'), 'Must contain id="введение"');
assert.ok(res.html.includes('id="цель-работы"'), 'Must contain id="цель-работы"');
assert.ok(res.html.includes('id="введение-1"'), 'Must contain id="введение-1" (disambiguated)');

// Check code block
assert.ok(res.html.includes('class="code-block-wrapper"'), 'Must contain code-block-wrapper');
assert.ok(res.html.includes('data-copy-btn="true"'), 'Must contain data-copy-btn');
assert.ok(res.html.includes('class="code-lang-badge">rust</span>'), 'Must contain lang badge');
assert.ok(res.html.includes('<pre><code class="language-rust">'), 'Must contain pre code');

// Check image
assert.ok(res.html.includes('data-lightbox="true"'), 'Must contain data-lightbox');
assert.ok(res.html.includes('class="markdown-image"'), 'Must contain markdown-image');

// Check table wrapper
assert.ok(res.html.includes('<div class="table-wrapper"><table'), 'Must wrap table in table-wrapper');

// Check external link target="_blank"
assert.ok(res.html.includes('target="_blank"'), 'Must set target="_blank" on external link');
assert.ok(res.html.includes('rel="noopener noreferrer"'), 'Must set rel="noopener noreferrer"');
console.log('✓ Markdown rendering and TOC tests passed');

console.log('--- 3. Testing Strict Sanitization (XSS Defense) ---');
const xssPayloads = [
  '<script>alert("XSS")</script>',
  '<SCRIPT SRC="https://evil.com/xss.js"></SCRIPT>',
  '<img src="x" onerror="alert(1)">',
  '<svg onload="alert(1)"></svg>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '[Click me](javascript:alert("XSS"))',
  '[VBScript link](vbscript:msgbox(1))',
  '[Data HTML link](data:text/html,<script>alert(1)</script>)',
  '<a href="javascript:alert(1)">Dangerous</a>',
  '<div onclick="alert(1)">Clickable div</div>',
  '<button onmouseover="alert(1)">Hover</button>',
];

for (const payload of xssPayloads) {
  const sanitized = renderMarkdown(payload).html;
  console.log(`Payload: ${payload} -> Output: ${sanitized}`);
  assertNoXss(sanitized);
}
console.log('✓ XSS defense tests passed');

console.log('--- 4. Testing Router Matching ---');
const r1 = matchRoute('/', '', '');
assert.strictEqual(r1.name, 'catalog');
assert.strictEqual(Object.keys(r1.params).length, 0);

const r2 = matchRoute('/?q=search&subject_id=sub1&offset=20', '?q=search&subject_id=sub1&offset=20', '');
assert.strictEqual(r2.name, 'catalog');
assert.strictEqual(r2.query.q, 'search');
assert.strictEqual(r2.query.subject_id, 'sub1');
assert.strictEqual(r2.query.offset, '20');

const r3 = matchRoute('/p/550e8400-e29b-41d4-a716-446655440000', '', '#heading-1');
assert.strictEqual(r3.name, 'reader');
assert.strictEqual(r3.params.id, '550e8400-e29b-41d4-a716-446655440000');
assert.strictEqual(r3.hash, '#heading-1');

const r4 = matchRoute('/admin/login', '', '');
assert.strictEqual(r4.name, 'login');

const r5 = matchRoute('/random/invalid/path', '', '');
assert.strictEqual(r5.name, 'not-found');
console.log('✓ Router matching tests passed');

console.log('--- 5. Testing ApiClientError ---');
const err404 = new ApiClientError(404, 'PAGE_NOT_FOUND', 'Page not found');
assert.ok(err404.isNotFound());
assert.ok(!err404.isUnauthorized());
assert.ok(!err404.isRateLimited());

const err401 = new ApiClientError(401, 'INVALID_CREDENTIALS', 'Invalid password');
assert.ok(err401.isUnauthorized());
assert.ok(!err401.isNotFound());

const err429 = new ApiClientError(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded', 60);
assert.ok(err429.isRateLimited());
assert.strictEqual(err429.retryAfter, 60);

const err409 = new ApiClientError(409, 'REVISION_CONFLICT', 'Conflict');
assert.ok(err409.isConflict());
console.log('✓ ApiClientError tests passed');

console.log('ALL VERIFICATION TESTS PASSED SUCCESSFULLY!');
