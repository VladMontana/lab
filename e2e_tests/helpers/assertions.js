// e2e_tests/helpers/assertions.js - Proposed remediation for Iteration 2
import assert from 'node:assert/strict';

/**
 * Assert that the HTTP response status matches the expected status code.
 * @param {object} res - Response object from ApiClient
 * @param {number} expectedStatus - Expected HTTP status code
 * @param {string} [message] - Optional contextual message
 */
export function assertStatus(res, expectedStatus, message = '') {
  assert.ok(res, `Response object must be defined. ${message}`);
  const detail = res.data ? JSON.stringify(res.data) : (res.text || '');
  assert.strictEqual(
    res.status,
    expectedStatus,
    `Expected HTTP ${expectedStatus} but received ${res.status}. Body: ${detail} ${message}`
  );
}

/**
 * Assert that the HTTP response was successful (ok = true) with matching status.
 * @param {object} res
 * @param {number} [expectedStatus=200]
 */
export function assertSuccess(res, expectedStatus = 200) {
  assertStatus(res, expectedStatus);
  assert.strictEqual(res.ok, true, `Expected response.ok to be true, got false (status ${res.status})`);
}

/**
 * Assert standard error JSON envelope:
 * {
 *   "error": {
 *     "code": "STRING_CODE",
 *     "message": "Human-readable description"
 *   }
 * }
 * @param {object} res
 * @param {number} expectedStatus
 * @param {string} [expectedErrorCode]
 */
export function assertError(res, expectedStatus, expectedErrorCode) {
  assertStatus(res, expectedStatus);
  assert.ok(res.data, 'Expected JSON error response body');
  assert.ok(
    res.data && typeof res.data === 'object' && res.data.error,
    `Expected "error" envelope in response: ${JSON.stringify(res.data)}`
  );

  const { error } = res.data;
  assert.ok(
    typeof error.code === 'string' && error.code.length > 0,
    `Expected non-empty string for error.code, got: ${JSON.stringify(error.code)}`
  );

  if (expectedErrorCode) {
    assert.strictEqual(
      error.code,
      expectedErrorCode,
      `Expected error.code "${expectedErrorCode}", got "${error.code}"`
    );
  }

  assert.ok(
    typeof error.message === 'string' && error.message.length > 0,
    `Expected error.message to be a non-empty string, got: ${JSON.stringify(error.message)}`
  );

  // Security leak check: ensure no internal database syntax, stack traces, or hashes leak in message
  assertNotLeaked(error.message);
}

/**
 * Assert that the text does not contain forbidden substrings indicating information leaks.
 * @param {string} text
 * @param {string[]} [forbidden]
 */
export function assertNotLeaked(
  text,
  forbidden = [
    'sqlite3',
    'sqlx',
    'syntax error',
    'password_hash',
    'argon2',
    'stack trace',
    'panicked at',
    'internal server error',
    'select ',
    'from ',
    'where ',
  ]
) {
  if (typeof text !== 'string') return;
  const lower = text.toLowerCase();
  for (const item of forbidden) {
    assert.ok(
      !lower.includes(item.toLowerCase()),
      `Potential security/information leak detected! Found forbidden string "${item}" in: ${text}`
    );
  }
}

/**
 * Assert that an HTML string contains no unsanitized XSS payloads or script execution vectors.
 * Hardened to catch quoted and unquoted javascript: URLs, data:text/html URLs, vbscript: URLs,
 * event handlers, case-variant script tags, and dangerous HTML elements.
 * @param {string} htmlString
 */
export function assertNoXss(htmlString) {
  assert.strictEqual(typeof htmlString, 'string', 'Expected string for XSS inspection');

  // Case-insensitive checks for script tags and embedding elements
  assert.ok(!/<script[\s/>]/i.test(htmlString) && !/<\/script/i.test(htmlString), 'Unsanitized <script> tag detected in rendered HTML');
  assert.ok(!/<iframe[\s/>]/i.test(htmlString), 'Unsanitized <iframe> tag detected');
  assert.ok(!/<object[\s/>]/i.test(htmlString), 'Unsanitized <object> tag detected');
  assert.ok(!/<embed[\s/>]/i.test(htmlString), 'Unsanitized <embed> tag detected');
  assert.ok(!/<base[\s/>]/i.test(htmlString), 'Unsanitized <base> tag detected');
  assert.ok(!/<meta[\s/>]/i.test(htmlString), 'Unsanitized <meta> tag detected');

  // Explicit event handlers anchored to HTML/SVG tags
  assert.ok(!/<[^>]*[\s/]+onerror\s*=/i.test(htmlString), 'Unsanitized onerror event handler detected');
  assert.ok(!/<[^>]*[\s/]+onload\s*=/i.test(htmlString), 'Unsanitized onload event handler detected');
  assert.ok(!/<[^>]*[\s/]+onclick\s*=/i.test(htmlString), 'Unsanitized onclick event handler detected');
  assert.ok(!/<[^>]*[\s/]+onmouseover\s*=/i.test(htmlString), 'Unsanitized onmouseover event handler detected');

  // Generic WHATWG DOM event handler categories inside HTML tags (prevents false positives on 'online', 'one', 'only', etc.)
  const domEventPattern =
    'on(?:abort|activate|after|animation|auxclick|before|begin|blur|bounce|canplay|cancel|change|click|close|contextmenu|copy|cue|cut|dblclick|drag|drop|duration|emptied|end|ended|error|finish|focus|form|fullscreen|gesture|hash|input|invalid|key|load|lostpointercapture|message|mouse|offline|online|orientation|page|paste|pause|play|pointer|popstate|progress|rate|repeat|reset|resize|scroll|search|seek|select|slotchange|stalled|start|storage|submit|suspend|time|toggle|touch|transition|unload|volume|waiting|wheel)[a-z]*';
  const inlineEventRegex = new RegExp(`<[^>]*[\\s/]+${domEventPattern}\\s*=`, 'i');
  assert.ok(!inlineEventRegex.test(htmlString), 'Unsanitized inline event handler detected');

  // Protocol handlers in href, src, action, formaction: quotes optional, spaces before colon, hex/dec entity colons
  assert.ok(!/(?:href|src|action|formaction)\s*=\s*(?:["']\s*)?javascript\s*(?::|&#x0*3a;|&#0*58;)/i.test(htmlString), 'Unsanitized javascript: link pseudo-protocol detected');
  assert.ok(!/(?:href|src|action|formaction)\s*=\s*(?:["']\s*)?data\s*:\s*text\/html/i.test(htmlString), 'Unsanitized data:text/html source detected');
  assert.ok(!/(?:href|src|action|formaction)\s*=\s*(?:["']\s*)?vbscript\s*(?::|&#x0*3a;|&#0*58;)/i.test(htmlString), 'Unsanitized vbscript: link pseudo-protocol detected');

  // Style-based script execution (CSS expressions & javascript: URLs)
  assert.ok(!/style\s*=\s*[^>]*url\s*\(\s*(?:["']\s*)?javascript\s*:/i.test(htmlString), 'Unsanitized javascript: url detected in style attribute');
  assert.ok(!/style\s*=\s*[^>]*expression\s*\(/i.test(htmlString), 'Unsanitized expression() detected in style attribute');
}

/**
 * Assert that a response header matches an expected string or RegExp.
 * @param {object} res
 * @param {string} headerName
 * @param {string|RegExp} expectedValue
 */
export function assertHeader(res, headerName, expectedValue) {
  const actual = res.headers.get(headerName);
  if (expectedValue instanceof RegExp) {
    assert.ok(
      expectedValue.test(actual || ''),
      `Header "${headerName}" (${actual}) failed regex pattern ${expectedValue}`
    );
  } else {
    assert.strictEqual(
      actual,
      expectedValue,
      `Header "${headerName}" mismatch: expected "${expectedValue}", got "${actual}"`
    );
  }
}

/**
 * Validate that response data follows standard envelope contracts.
 * @param {object} res
 */
export function assertEnvelope(res) {
  if (res.status >= 400) {
    assertError(res, res.status);
  } else {
    assert.ok(res.data !== undefined, 'Expected response.data to be defined for successful response');
  }
}
