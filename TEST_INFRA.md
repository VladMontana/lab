# TEST_INFRA.md — E2E Testing Infrastructure Specification

**Project**: LabNotes MVP  
**Status**: APPROVED & ACTIVE  
**Framework**: Node.js Native Test Runner (`node:test`)  
**Target Coverage**: >= 529 Test Cases (Tiers 1–4 across all 46 features)  
**Execution Mode**: Opaque-box over HTTP  

---

## 1. Architectural Overview & Methodology

The LabNotes E2E test harness validates the full functional, security, and operational contracts of the LabNotes platform against `ORIGINAL_REQUEST.md`, `AGENT_PLAN.md`, and `PROJECT.md`.

### 1.1 Core Testing Principles
1. **Strictly Opaque-Box**:
   - The test suite interacts exclusively over HTTP (`http://127.0.0.1:8080` by default or configured via `TEST_BASE_URL`).
   - No backend Rust code, SQLx queries, or internal database connections are imported or directly manipulated.
   - All state mutations occur via published REST endpoints (`/api/*`), media endpoints (`/media/*`), or static assets.
2. **Zero External Runtime Dependencies**:
   - Built entirely on Node.js built-ins (`node:test`, `node:assert/strict`, `node:crypto`, `node:buffer`, `node:fs`, `node:path`, `node:url`).
   - Uses native `fetch`, `FormData`, `File`, `Blob`, and `Headers` (Node 18+, tested on Node 24.12.0).
   - Zero `npm install` requirements. Tests run out of the box in any clean environment without downloading third-party npm packages.
3. **Sequential Execution & Isolation**:
   - Sequential execution (`concurrency: 1`) by default guarantees deterministic execution, avoids SQLite transaction lock collisions, and prevents race conditions on draft revisions and session tokens.
4. **Collision-Resistant Entity Generation & Cleanup**:
   - All test fixtures use dynamically generated unique identifiers (`test_<timestamp>_<uuid>`).
   - Tests register `after()` cleanup hooks to purge created subjects and pages via admin DELETE endpoints.

---

## 2. Directory Layout

The complete test harness is isolated in `e2e_tests/` at the project root:

```text
c:\Users\Влад\Desktop\lab\
├── TEST_INFRA.md                    # This authoritative infrastructure documentation
├── e2e_tests/
│   ├── package.json                 # ES module definition and npm test scripts
│   ├── run_all.js                   # Master CLI runner with filtering, health checks, & reporters
│   ├── config.js                    # Base URL, credentials, timeouts, environment overrides
│   ├── sanity.test.js               # Self-verifying test suite validating all helpers & generators
│   ├── helpers/
│   │   ├── api_client.js            # Universal HTTP client (cookies, CSRF, JSON, multipart)
│   │   ├── cookie_jar.js            # RFC 6265 compliant cookie container (getSetCookie support)
│   │   ├── assertions.js            # Status, error envelopes, leak detection, XSS validators
│   │   ├── fixtures.js              # Factory methods for test subjects, drafts, markdown, attack vectors
│   │   ├── media_generator.js       # In-memory PNG, JPEG, WebP, SVG, ZIP, PDF, oversized buffers
│   │   └── wait_for_server.js       # Exponential backoff health poller (GET /healthz)
│   ├── tier1/                       # Tier 1: Baseline Feature Coverage (46 files, >= 230 tests)
│   ├── tier2/                       # Tier 2: Boundary & Corner Cases (46 files, >= 230 tests)
│   ├── tier3/                       # Tier 3: Cross-Feature Combinations (46 pairwise tests)
│   └── tier4/                       # Tier 4: Real-World Scenarios (23 user workflows)
```

---

## 3. Configuration & Environment Variables

All parameters are configured in `e2e_tests/config.js` and can be customized via environment variables:

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `TEST_BASE_URL` | `http://127.0.0.1:8080` | Base address of the target LabNotes server |
| `ADMIN_USERNAME` | `admin` | Administrator username configured on server bootstrap |
| `ADMIN_PASSWORD` | `admin_test_password_123` | Administrator password configured on server bootstrap |
| `TEST_TIMEOUT` | `10000` | Per-test execution timeout in milliseconds |
| `HEALTH_CHECK_TIMEOUT` | `30000` | Maximum wait time for server boot readiness in milliseconds |

---

## 4. Helper Modules Reference

### 4.1 CookieJar (`helpers/cookie_jar.js`)
An in-memory cookie store implementing RFC 6265 semantics:
- `setFromHeaders(headers)`: Extracts and parses `Set-Cookie` headers using `headers.getSetCookie()` or `headers.get('set-cookie')`.
- `parseCookie(cookieStr)`: Parses cookie name, value, `HttpOnly`, `Path`, `SameSite`, `Max-Age`, and `Expires`. Correctly deletes cookies when `Max-Age <= 0` or expiration is past.
- `getCookieHeader()`: Serializes active cookies into a formatted string (`name1=val1; name2=val2`) suitable for the `Cookie` request header.
- `get(name)` & `getDetails(name)`: Retrieves cookie value or full metadata (e.g. for verifying `HttpOnly` and `SameSite` flags).
- `clone()`: Returns an isolated deep copy for parallel or branch testing.
- `clear()`: Purges all stored cookies.

### 4.2 ApiClient (`helpers/api_client.js`)
High-level HTTP client wrapping native `fetch`:
- Automatic cookie management via internal `CookieJar`.
- Automatic CSRF protection: stores `csrf_token` received from `/api/admin/login` or `/api/admin/me`, injecting it as `X-CSRF-Token` on all mutating methods (`POST`, `PUT`, `PATCH`, `DELETE`).
- Automatic `Origin` header matching `new URL(baseUrl).origin`.
- Transparent JSON handling: serializes request objects, parses response JSON when `content-type` includes `application/json`.
- Multipart file upload support via `postMultipart(path, formData)`.
- Convenience methods: `get`, `post`, `patch`, `put`, `delete`, `login`, `logout`, `checkMe`, `clone`, and `static anonymous(baseUrl)`.

### 4.3 Custom Assertions (`helpers/assertions.js`)
Domain-specific assertion primitives providing clear error diagnostics:
- `assertStatus(res, expectedStatus, message)`: Verifies exact HTTP status code, printing body details on failure.
- `assertSuccess(res, expectedStatus = 200)`: Asserts status and `res.ok === true`.
- `assertError(res, expectedStatus, expectedErrorCode)`: Validates the standard JSON error envelope:
  ```json
  {
    "error": {
      "code": "STRING_CODE",
      "message": "Human-readable description"
    }
  }
  ```
  Also runs `assertNotLeaked()` on the error message.
- `assertNotLeaked(text, forbidden)`: Scans strings for database syntax, stack traces, password hashes, or SQL tokens (`sqlite3`, `sqlx`, `syntax error`, `password_hash`, `argon2`, `stack trace`, `SELECT`, `FROM`).
- `assertNoXss(htmlString)`: Detects script tags, inline event handlers (`onerror`, `onload`, `onclick`, `onmouseover`), `javascript:` pseudo-protocols, and dangerous tags (`<iframe>`, `<object>`, `<embed>`).
- `assertHeader(res, headerName, expectedValue)`: Matches headers by exact string or regular expression.
- `assertEnvelope(res)`: Verifies structural response validity.

### 4.4 Binary Media Generator (`helpers/media_generator.js`)
Constructs byte-accurate binary `File` objects directly in memory without disk I/O:
- `createPng(filename)`: 1x1 valid PNG (70 bytes, magic header `89 50 4E 47 0D 0A 1A 0A`).
- `createJpeg(filename)`: 1x1 valid JFIF JPEG (151 bytes, SOI `FF D8`, EOI `FF D9`).
- `createWebp(filename)`: 1x1 valid WebP (44 bytes, `RIFF....WEBP`).
- `createSvg(filename)`: Valid XML SVG file (type `image/svg+xml`) to verify rejection as image.
- `createCorruptedImage(filename)`: Invalid image bytes to verify magic byte check (`400 INVALID_IMAGE_FORMAT`).
- `createOversizedImage(filename)`: 10 MiB + 1 KiB buffer with PNG header to verify payload limit (`413 FILE_TOO_LARGE`).
- `createZip(filename)`: Minimal 22-byte empty ZIP archive with valid End of Central Directory signature (`50 4B 05 06`).
- `createPdf(filename)`: Valid minimal PDF (`%PDF-1.4...%%EOF`).
- `createText(filename, content)`: Valid Markdown/plain text attachment.
- `createOversizedAttachment(filename)`: 50 MiB + 1 KiB buffer with ZIP header to verify attachment limit (`413 FILE_TOO_LARGE`).
- `createPathTraversalFile(filename)`: Payload with traversal path in filename (`../../etc/passwd`).

### 4.5 Fixture Generators (`helpers/fixtures.js`)
Provides deterministic and unique test inputs:
- `uniqueName(prefix)`: Collision-resistant unique string containing timestamp and UUID suffix.
- `sampleSubject(override)`: Valid subject payload `{ name, position: 0 }`.
- `samplePageDraft(subjectId, override)`: Valid page draft payload.
- `sampleMarkdown(title)`: Full-featured Markdown document with H1-H3, lists, checklists, tables, code blocks, images, blockquotes, and links.
- `xssMarkdownPayloads`: Array of 15 adversarial XSS vectors.
- `sqlInjectionPayloads`: Array of SQL injection probe vectors.

### 4.6 Server Readiness Poller (`helpers/wait_for_server.js`)
- `waitForServer(baseUrl, timeoutMs, options)`: Polls `GET /healthz` with exponential/linear backoff until the server responds with HTTP 200 and `{"status": "ok"}`. Throws a clear timeout error if the server is offline.

---

## 5. Execution Commands

### From Project Root:
```bash
# Execute entire E2E test suite (Tiers 1-4)
node e2e_tests/run_all.js

# Execute specific tier
node e2e_tests/run_all.js --tier=1
node e2e_tests/run_all.js --tier=2
node e2e_tests/run_all.js --tier=3
node e2e_tests/run_all.js --tier=4

# Execute tests for a specific feature (e.g. Feature 13: Admin Login)
node e2e_tests/run_all.js --feature=13

# Filter tests by title pattern
node e2e_tests/run_all.js --filter="Rate Limiting"

# Override target base URL
node e2e_tests/run_all.js --base-url="http://127.0.0.1:9000"

# Execute sanity self-test directly
node --test e2e_tests/sanity.test.js
```

### From `e2e_tests/` Directory:
```bash
npm test
npm run test:tier1
npm run test:tier2
npm run test:tier3
npm run test:tier4
npm run test:sanity
```

---

## 6. Test Authoring Standard

Every test suite file must follow this standardized template:

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../helpers/api_client.js';
import { assertStatus, assertSuccess, assertError } from '../helpers/assertions.js';
import { sampleSubject, uniqueName } from '../helpers/fixtures.js';

describe('Feature XX: [Feature Name]', () => {
  let client;
  let createdSubjectId;

  before(async () => {
    client = new ApiClient();
    const loginRes = await client.login();
    assertSuccess(loginRes, 200);
  });

  after(async () => {
    // Teardown created resources to maintain clean database state
    if (createdSubjectId) {
      await client.delete(`/api/admin/subjects/${createdSubjectId}`);
    }
  });

  it('TC-XX-01: [Primary Happy Path Scenario]', async () => {
    const res = await client.post('/api/admin/subjects', sampleSubject());
    assertStatus(res, 201);
    assert.ok(res.data.id, 'Expected subject ID in response');
    createdSubjectId = res.data.id;
  });

  it('TC-XX-02: [Negative / Validation Scenario]', async () => {
    const res = await client.post('/api/admin/subjects', { name: '' });
    assertError(res, 400, 'VALIDATION_ERROR');
  });
});
```

---

## 7. 4-Tier Test Matrix & Feature Allocation

All 46 features from `PROJECT.md` are systematically covered across four tiers:

| Feature # | Feature Name | Tier 1 (Coverage >= 5) | Tier 2 (Boundaries >= 5) | Tier 3 (Pairwise) | Tier 4 (Scenarios) |
| :---: | :--- | :---: | :---: | :---: | :---: |
| 1 | Single-binary runtime | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 2 | Health Readiness Probe | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 3 | Public Subjects List | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 4 | Public Page Catalog & Search | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 5 | Public Page View | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 6 | Rendered Markdown View | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 7 | Code Block Copy Button | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 8 | Table of Contents (TOC) | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 9 | Image Lightbox | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 10 | Attachment Download List | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 11 | Friendly 404 & Empty States | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 12 | Initial Admin Bootstrap | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 13 | Admin Login | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 14 | Admin Logout | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 15 | Admin Session Check | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 16 | List All Subjects | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 17 | Create Subject | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 18 | Update Subject | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 19 | Delete Subject | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 20 | List Admin Pages | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 21 | Create Page | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 22 | Read Page Draft | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 23 | Update Draft (Autosave/Manual) | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 24 | Delete Page | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 25 | Publish Draft Snapshot | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 26 | Unpublish Page | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 27 | Share / Copy Link | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 28 | CodeMirror 6 Markdown Editor | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 29 | Dynamic Editor Loading | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 30 | View Modes (Editor / Preview / Split) | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 31 | Formatting Toolbar | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 32 | Formatting Hotkeys | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 33 | Autosave & Status Indicators | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 34 | LocalStorage Recovery | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 35 | Navigation Guard | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 36 | Import / Export Markdown | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 37 | Image Upload (Paste / DnD / Picker) | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 38 | Image Insertion in Editor | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 39 | Attachment Upload | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 40 | Streaming Disk Storage | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 41 | Media Serving & Visibility Check | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 42 | List Page Assets | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 43 | Markdown XSS Sanitization | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 44 | CSRF & Origin Validation | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 45 | Rate Limiting on Login | ✓ (5) | ✓ (5) | ✓ | ✓ |
| 46 | Docker Multi-Stage Build | ✓ (5) | ✓ (5) | ✓ | ✓ |
| **Total** | | **230 tests** | **230 tests** | **46 tests** | **23 scenarios** |

**Grand Total**: **>= 529 test cases**.

---

## 8. Verification & Sanity Test Results

The infrastructure was independently verified using the native Node.js test runner:
```text
node --test e2e_tests/sanity.test.js
```
- **Total Tests Executed**: 35
- **Passed**: 35 (100%)
- **Failed**: 0
- **Duration**: ~260 ms
- **Scope Verified**:
  - `config.js` environment parameter handling and defaults.
  - `cookie_jar.js` RFC 6265 cookie parsing, expiration, headers, and cloning.
  - `assertions.js` status codes, error envelope contracts, information leak detection, and XSS sanitization.
  - `media_generator.js` binary generation of PNG, JPEG, WebP, SVG, ZIP, PDF, oversized files, and traversal paths.
  - `fixtures.js` unique ID generation, sample subjects, sample drafts, sample markdown, and security payloads.
  - `api_client.js` constructor, origin derivation, isolation, and unauthenticated factory.
  - `wait_for_server.js` timeout and connection retry behavior.
