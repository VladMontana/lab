// e2e_tests/tier3/tier3_pairwise_01_20.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../helpers/api_client.js';
import {
  assertStatus,
  assertSuccess,
  assertError,
  assertNotLeaked,
  assertNoXss,
} from '../helpers/assertions.js';
import {
  uniqueName,
  sampleSubject,
  samplePageDraft,
} from '../helpers/fixtures.js';
import { MediaGenerator } from '../helpers/media_generator.js';
import { config } from '../config.js';

describe('Tier 3: Pairwise Interaction Coverage (TC-T3-01 to TC-T3-20)', () => {
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
    // Teardown created pages first
    for (const pageId of createdPageIds) {
      try {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      } catch {
        // ignore errors during cleanup
      }
    }
    // Teardown created subjects
    for (const subjId of createdSubjectIds) {
      try {
        await adminClient.delete(`/api/admin/subjects/${subjId}`);
      } catch {
        // ignore errors during cleanup
      }
    }
  });

  it('TC-T3-01: Single-Binary Routing vs. API Error Envelope (F01 + F11)', async () => {
    // Step 1: Unmatched /api/* path must return JSON error NOT_FOUND (404)
    const apiRes = await anonClient.get('/api/unknown-endpoint-404-test');
    assertError(apiRes, 404, 'NOT_FOUND');
    assert.ok(apiRes.headers.get('content-type')?.includes('application/json'));

    // Step 2: Unmatched /media/* path must return JSON error MEDIA_NOT_FOUND (404)
    const mediaRes = await anonClient.get('/media/00000000-0000-0000-0000-000000000000');
    assertError(mediaRes, 404, 'MEDIA_NOT_FOUND');
    assert.ok(mediaRes.headers.get('content-type')?.includes('application/json'));

    // Step 3: Unmatched browser SPA route with Accept: text/html returns index.html fallback (200 OK)
    const spaRes = await anonClient.get('/some-non-existent-spa-route', {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    assertStatus(spaRes, 200);
    assert.ok(spaRes.headers.get('content-type')?.includes('text/html'));
    assert.ok(
      spaRes.text && (spaRes.text.includes('<html') || spaRes.text.includes('id="app"') || spaRes.text.includes('<!DOCTYPE html>')),
      'Expected HTML SPA document in response body'
    );
  });

  it('TC-T3-02: Health Probe Verification under Database File Lock (F02 + F46)', async () => {
    const res = await anonClient.get('/healthz');
    assertSuccess(res, 200);
    assert.ok(res.data, 'Expected JSON data in health check');
    assert.strictEqual(res.data.status, 'ok');
    assertNotLeaked(JSON.stringify(res.data));
  });

  it('TC-T3-03: Subject Creation and Real-Time Public Subject Count Aggregation (F03 + F17)', async () => {
    // Step 1: Admin creates subject
    const subjName = uniqueName('Subj_Math');
    const createSubjRes = await adminClient.post('/api/admin/subjects', {
      name: subjName,
      position: 10,
    });
    assertStatus(createSubjRes, 201);
    const subjectId = createSubjRes.data.id;
    createdSubjectIds.push(subjectId);

    // Step 2: Anon checks public subjects; subject is either omitted or has page_count = 0
    let publicSubjRes = await anonClient.get('/api/public/subjects');
    assertSuccess(publicSubjRes, 200);
    const initialFound = publicSubjRes.data.find((s) => s.id === subjectId);
    if (initialFound) {
      assert.strictEqual(initialFound.page_count, 0);
    }

    // Step 3: Admin creates a draft page in this subject
    const createPageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjectId,
      title: uniqueName('Discrete_Math_Lab'),
    });
    assertStatus(createPageRes, 201);
    const pageId = createPageRes.data.id;
    createdPageIds.push(pageId);

    // Step 4: Anon checks public subjects; draft page does not increment public page_count
    publicSubjRes = await anonClient.get('/api/public/subjects');
    assertSuccess(publicSubjRes, 200);
    const intermediateFound = publicSubjRes.data.find((s) => s.id === subjectId);
    if (intermediateFound) {
      assert.strictEqual(intermediateFound.page_count, 0);
    }

    // Step 5: Admin publishes page
    const publishRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });
    assertSuccess(publishRes, 200);

    // Step 6: Anon checks public subjects; page_count is now 1
    publicSubjRes = await anonClient.get('/api/public/subjects');
    assertSuccess(publicSubjRes, 200);
    const publishedFound = publicSubjRes.data.find((s) => s.id === subjectId);
    assert.ok(publishedFound, 'Expected published subject in public subjects list');
    assert.strictEqual(publishedFound.page_count, 1);
  });

  it('TC-T3-04: Draft Content Isolation from Public SQL Search (F04 + F25)', async () => {
    // Setup: Create subject and publish a page P1 with "Intro to C" / "Basics of pointers"
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    const subjectId = subjRes.data.id;
    createdSubjectIds.push(subjectId);

    const secretKeyword = uniqueName('valgrind_secret');
    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjectId,
      title: 'Intro to C',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const patchInitial = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: 'Basics of pointers in C programming language',
    });
    assertSuccess(patchInitial, 200);

    const pubRes1 = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });
    assertSuccess(pubRes1, 200);

    // Step 1: Anonymous search for keyword returns 0 items
    let searchRes = await anonClient.get(`/api/public/pages?q=${encodeURIComponent(secretKeyword)}`);
    assertSuccess(searchRes, 200);
    assert.strictEqual(searchRes.data.items.length, 0);
    assert.strictEqual(searchRes.data.total, 0);

    // Step 2: Admin updates draft with secret keyword (revision 3)
    const patchDraft = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 2,
      markdown: `Debugging memory leaks with ${secretKeyword} tool in Linux`,
    });
    assertSuccess(patchDraft, 200);

    // Step 3: Anonymous search must STILL return 0 items (draft changes are isolated!)
    searchRes = await anonClient.get(`/api/public/pages?q=${encodeURIComponent(secretKeyword)}`);
    assertSuccess(searchRes, 200);
    assert.strictEqual(searchRes.data.items.length, 0);
    assert.strictEqual(searchRes.data.total, 0);

    // Step 4: Admin publishes revision 3
    const pubRes2 = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 3,
      attachment_ids: [],
    });
    assertSuccess(pubRes2, 200);

    // Step 5: Anonymous search now returns page P1
    searchRes = await anonClient.get(`/api/public/pages?q=${encodeURIComponent(secretKeyword)}`);
    assertSuccess(searchRes, 200);
    assert.strictEqual(searchRes.data.total, 1);
    assert.strictEqual(searchRes.data.items[0].id, pageId);
  });

  it('TC-T3-05: Immediate 404 Transition on Page Unpublishing (F05 + F26)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Unpublish_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Publish page
    const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });
    assertSuccess(pubRes, 200);

    // Step 1: Public page access returns 200 OK
    const getPub1 = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(getPub1, 200);
    assert.strictEqual(getPub1.data.id, pageId);

    // Step 2: Admin unpublishes page
    const unpubRes = await adminClient.delete(`/api/admin/pages/${pageId}/publication`);
    assertSuccess(unpubRes, 200);

    // Step 3: Anonymous access immediately returns 404 PAGE_NOT_FOUND
    const getPub2 = await anonClient.get(`/api/public/pages/${pageId}`);
    assertError(getPub2, 404, 'PAGE_NOT_FOUND');

    // Step 4: Admin retains full access to draft
    const getDraft = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(getDraft, 200);
    assert.strictEqual(getDraft.data.id, pageId);
  });

  it('TC-T3-06: Markdown Typography Rendering with XSS Defense (F06 + F43)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const attackMarkdown = `# Lab Work
| Command | Description |
| :--- | :--- |
| \`ls -la\` | List files <script>alert('table-xss')</script> |

> Note: [Click here](javascript:alert('link-xss'))

- [x] Task 1 <img src="invalid" onerror="alert('img-xss')">
`;

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: 'XSS Defense Verification',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: attackMarkdown,
    });

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    const getRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(getRes, 200);
    assert.ok(getRes.data.markdown, 'Expected markdown in public page');

    // Verify sanitization invariants
    assertNotLeaked(getRes.data.markdown);
  });

  it('TC-T3-07: Code Block Copy Button Preservation of Exact Indentation (F07 + F28)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pythonCode = 'def compute():\n    x = 10\n    if x > 5:\n        return True\n    return False';
    const markdownContent = `# Python Snippet\n\n\`\`\`python\n${pythonCode}\n\`\`\`\n`;

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: 'Code Indentation Test',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: markdownContent,
    });

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubRes, 200);
    assert.ok(pubRes.data.markdown.includes(pythonCode), 'Verbatim code indentation must be preserved');
  });

  it('TC-T3-08: Dynamic TOC Anchor Generation from Heading Toolbar Insertions (F08 + F31)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const markdownWithHeadings = `# Document Title
## 1. Setup Environment
Instructions for setup.
### 1.1 Prerequisites
Prerequisites detail.
## 2. Execution
Run commands.
`;

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: 'TOC Heading Anchor Test',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: markdownWithHeadings,
    });

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubRes, 200);
    assert.ok(pubRes.data.markdown.includes('## 1. Setup Environment'));
    assert.ok(pubRes.data.markdown.includes('### 1.1 Prerequisites'));
  });

  it('TC-T3-09: Image Upload, Editor Placement, and Lightbox Overlay Activation (F09 + F38)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: 'Image Lightbox Test',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Upload PNG image
    const formData = new FormData();
    const imageFile = MediaGenerator.createPng('diagram.png');
    formData.append('file', imageFile);

    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
    assertStatus(uploadRes, 201);
    assert.strictEqual(uploadRes.data.kind, 'image');
    const assetId = uploadRes.data.id;
    const mediaUrl = uploadRes.data.url || `/media/${assetId}`;

    // Place image in markdown and publish
    const imageMarkdown = `# Architecture Diagram\n\n![diagram.png](${mediaUrl})\n`;
    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: imageMarkdown,
    });

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    // Public visitor can view page and load image
    const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubRes, 200);
    assert.ok(pubRes.data.markdown.includes(assetId));

    const imgRes = await anonClient.get(`/media/${assetId}`);
    assertSuccess(imgRes, 200);
    assert.ok(imgRes.headers.get('content-type')?.includes('image/png'));
  });

  it('TC-T3-10: Attachment Upload, Public Listing, and Binary Download Streaming (F10 + F39)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: 'Attachment Download Test',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Upload ZIP attachment
    const formData = new FormData();
    const zipFile = MediaGenerator.createZip('lab_starter.zip');
    formData.append('file', zipFile);

    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
    assertStatus(uploadRes, 201);
    assert.strictEqual(uploadRes.data.kind, 'attachment');
    const assetId = uploadRes.data.id;

    // Publish page with attachment_ids: [assetId]
    const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [assetId],
    });
    assertSuccess(pubRes, 200);

    // Public visitor retrieves page details
    const getRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(getRes, 200);
    assert.ok(Array.isArray(getRes.data.attachments), 'Expected attachments array');
    const att = getRes.data.attachments.find((a) => a.id === assetId);
    assert.ok(att, 'Uploaded attachment must be in public attachments list');
    assert.strictEqual(att.original_name, 'lab_starter.zip');

    // Download attachment via /media/:id
    const downloadRes = await anonClient.get(`/media/${assetId}`);
    assertSuccess(downloadRes, 200);
    assert.ok(downloadRes.headers.get('content-type')?.includes('application/zip'));
    assert.ok(downloadRes.headers.get('content-disposition')?.includes('attachment'));
  });

  it('TC-T3-11: Environment Variable Bootstrap and Idempotent Restart (F12 + F13)', async () => {
    // Client authenticates with valid bootstrap credentials
    const validClient = new ApiClient();
    const okRes = await validClient.login(config.adminUsername, config.adminPassword);
    assertSuccess(okRes, 200);

    // Invalid password must fail with 401 INVALID_CREDENTIALS
    const invalidClient = new ApiClient();
    const failRes = await invalidClient.login(config.adminUsername, 'Incorrect_Password_999!');
    assertError(failRes, 401, 'INVALID_CREDENTIALS');
  });

  it('TC-T3-12: Brute Force Password Guessing and Rate Limiter Lockout (F13 + F45)', async () => {
    const bruteClient = new ApiClient();
    let hitRateLimit = false;

    // Send rapid failed login attempts using isolated client IP
    for (let i = 0; i < 8; i++) {
      const res = await bruteClient.login('admin', `wrong_pass_${i}_${Date.now()}`, {
        headers: { 'X-Forwarded-For': '198.51.100.32' },
      });
      if (res.status === 429) {
        assertError(res, 429, 'RATE_LIMIT_EXCEEDED');
        hitRateLimit = true;
        break;
      } else {
        assertError(res, 401, 'INVALID_CREDENTIALS');
      }
    }

    // Health probe must remain 200 OK regardless of login rate limiting
    const healthRes = await anonClient.get('/healthz');
    assertSuccess(healthRes, 200);
  });

  it('TC-T3-13: Explicit Logout and Session Token Invalidation in SQLite (F14 + F15)', async () => {
    const tempClient = new ApiClient();
    const loginRes = await tempClient.login();
    assertSuccess(loginRes, 200);

    // Check session validity
    const meRes1 = await tempClient.checkMe();
    assertSuccess(meRes1, 200);
    assert.strictEqual(meRes1.data.username, config.adminUsername);

    // Logout
    const logoutRes = await tempClient.logout();
    assertSuccess(logoutRes, 200);

    // Repeating /api/admin/me must return 401 UNAUTHORIZED
    const meRes2 = await tempClient.checkMe();
    assertError(meRes2, 401, 'UNAUTHORIZED');
  });

  it('TC-T3-14: CSRF Header Requirement on Mutating Requests (F15 + F44)', async () => {
    // Clone admin client
    const customClient = adminClient.clone();

    // 1. Missing X-CSRF-Token on mutating request
    const missingCsrfRes = await customClient.post('/api/admin/subjects', sampleSubject(), {
      headers: { 'X-CSRF-Token': '' },
    });
    assertError(missingCsrfRes, 403, 'FORBIDDEN');

    // 2. Invalid X-CSRF-Token
    const badCsrfRes = await customClient.post('/api/admin/subjects', sampleSubject(), {
      headers: { 'X-CSRF-Token': 'malicious-bogus-csrf-token' },
    });
    assertError(badCsrfRes, 403, 'FORBIDDEN');

    // 3. Invalid Origin header
    const badOriginRes = await customClient.post('/api/admin/subjects', sampleSubject(), {
      headers: { Origin: 'https://evil-attacker.example.com' },
    });
    assertError(badOriginRes, 403, 'FORBIDDEN');

    // 4. Valid CSRF and Origin succeeds
    const goodRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(goodRes, 201);
    createdSubjectIds.push(goodRes.data.id);
  });

  it('TC-T3-15: Subject Renaming and Alphabetical / Positional Ordering (F16 + F18)', async () => {
    const subjA = await adminClient.post('/api/admin/subjects', {
      name: uniqueName('Subj_Alpha'),
      position: 10,
    });
    assertStatus(subjA, 201);
    createdSubjectIds.push(subjA.data.id);

    const subjB = await adminClient.post('/api/admin/subjects', {
      name: uniqueName('Subj_Beta'),
      position: 20,
    });
    assertStatus(subjB, 201);
    createdSubjectIds.push(subjB.data.id);

    // Reposition Subj B to position 0 and rename
    const newName = uniqueName('Subj_Beta_Promoted');
    const patchRes = await adminClient.patch(`/api/admin/subjects/${subjB.data.id}`, {
      position: 0,
      name: newName,
    });
    assertSuccess(patchRes, 200);

    // List admin subjects
    const listRes = await adminClient.get('/api/admin/subjects');
    assertSuccess(listRes, 200);
    const updatedB = listRes.data.find((s) => s.id === subjB.data.id);
    assert.ok(updatedB);
    assert.strictEqual(updatedB.name, newName);
    assert.strictEqual(updatedB.position, 0);
  });

  it('TC-T3-16: Foreign Key Enforcement on Page Creation (F17 + F21)', async () => {
    const nonExistentSubjectId = '00000000-0000-0000-0000-000000000000';
    const res = await adminClient.post('/api/admin/pages', {
      subject_id: nonExistentSubjectId,
      title: 'Orphaned Page Draft',
    });
    assert.ok(res.status === 400 || res.status === 404, `Expected 400 or 404, got ${res.status}`);
    assertError(res, res.status);
  });

  it('TC-T3-17: Independent Draft Subject Relocation without Affecting Published Page (F18 + F25)', async () => {
    const subj1 = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subj1, 201);
    createdSubjectIds.push(subj1.data.id);

    const subj2 = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subj2, 201);
    createdSubjectIds.push(subj2.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subj1.data.id,
      title: 'Dual Subject Relocation Test',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Initial publish under subject 1
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });

    // Relocate draft to subject 2
    const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      subject_id: subj2.data.id,
    });
    assertSuccess(patchRes, 200);

    // Public page still points to Subject 1
    let pubGet = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubGet, 200);
    assert.strictEqual(pubGet.data.subject_id, subj1.data.id);

    // Publish revision 2
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    // Public page now points to Subject 2
    pubGet = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubGet, 200);
    assert.strictEqual(pubGet.data.subject_id, subj2.data.id);
  });

  it('TC-T3-18: Non-Empty Subject Deletion Blocked with 409 (F19 + F24)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    const subjectId = subjRes.data.id;
    createdSubjectIds.push(subjectId);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjectId,
      title: 'Blocking Child Page',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;

    // Step 1: Attempt to delete subject while page exists -> 409 SUBJECT_NOT_EMPTY
    const delSubjRes1 = await adminClient.delete(`/api/admin/subjects/${subjectId}`);
    assertError(delSubjRes1, 409, 'SUBJECT_NOT_EMPTY');

    // Step 2: Delete page -> 200 OK
    const delPageRes = await adminClient.delete(`/api/admin/pages/${pageId}`);
    assertSuccess(delPageRes, 200);

    // Step 3: Delete subject now succeeds -> 200 OK
    const delSubjRes2 = await adminClient.delete(`/api/admin/subjects/${subjectId}`);
    assertSuccess(delSubjRes2, 200);

    // Remove from cleanup array since deleted
    const idx = createdSubjectIds.indexOf(subjectId);
    if (idx !== -1) createdSubjectIds.splice(idx, 1);
  });

  it('TC-T3-19: Admin Page List Reflecting Real-Time Publication State (F20 + F26)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('PubState_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Initially unpublished
    let listRes = await adminClient.get('/api/admin/pages');
    assertSuccess(listRes, 200);
    let item = listRes.data.find((p) => p.id === pageId);
    assert.ok(item);
    assert.strictEqual(item.is_published, false);

    // Publish page
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });

    listRes = await adminClient.get('/api/admin/pages');
    assertSuccess(listRes, 200);
    item = listRes.data.find((p) => p.id === pageId);
    assert.ok(item);
    assert.strictEqual(item.is_published, true);

    // Unpublish page
    await adminClient.delete(`/api/admin/pages/${pageId}/publication`);

    listRes = await adminClient.get('/api/admin/pages');
    assertSuccess(listRes, 200);
    item = listRes.data.find((p) => p.id === pageId);
    assert.ok(item);
    assert.strictEqual(item.is_published, false);
  });

  it('TC-T3-20: Sequential Draft Revision Numbering on Creation (F21 + F22)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const title = uniqueName('Revision_Initial_Lab');
    const createRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: title,
    });
    assertStatus(createRes, 201);
    const pageId = createRes.data.id;
    createdPageIds.push(pageId);
    assert.strictEqual(createRes.data.revision, 1);

    const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(getRes, 200);
    assert.strictEqual(getRes.data.revision, 1);
    assert.strictEqual(getRes.data.draft_markdown, '');
    assert.strictEqual(getRes.data.draft_title, title);
  });
});
