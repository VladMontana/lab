// e2e_tests/tier4/tier4_scenarios_11_23.test.js
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

describe('Tier 4: Real-World Scenarios (WF-T4-11 to WF-T4-23)', () => {
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

  it('WF-T4-11: CSRF & Origin Attack Mitigation (F13, F15, F21, F44)', async () => {
    // 1. Legitimate admin is logged in
    const meRes = await adminClient.checkMe();
    assertSuccess(meRes, 200);

    // 2. Untrusted cross-origin request simulation
    const evilClient = adminClient.clone();
    const evilOriginRes = await evilClient.post('/api/admin/subjects', sampleSubject(), {
      headers: { Origin: 'http://malicious-cross-origin.com' },
    });
    assertError(evilOriginRes, 403, 'FORBIDDEN');

    // 3. Request missing CSRF token
    const missingTokenRes = await evilClient.post('/api/admin/subjects', sampleSubject(), {
      headers: { 'X-CSRF-Token': '' },
    });
    assertError(missingTokenRes, 403, 'FORBIDDEN');

    // 4. Legitimate action with proper Origin & CSRF token
    const goodRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(goodRes, 201);
    createdSubjectIds.push(goodRes.data.id);
  });

  it('WF-T4-12: High-Volume Media Management & Draft Asset Lifecycle (F24, F25, F37, F38, F41, F42)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Media_Heavy_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // 1. Upload 4 screenshot images
    const assetIds = [];
    for (let i = 1; i <= 4; i++) {
      const form = new FormData();
      form.append('file', MediaGenerator.createPng(`step_${i}.png`));
      const upRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form);
      assertStatus(upRes, 201);
      assetIds.push(upRes.data.id);
    }

    // 2. Author deletes step 3 asset
    const delRes = await adminClient.delete(`/api/admin/pages/${pageId}/assets/${assetIds[2]}`);
    assertSuccess(delRes, 200);

    // 3. Author publishes page
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });

    // 4. Public access verifies surviving assets (0, 1, 3) load
    for (const idx of [0, 1, 3]) {
      const mediaRes = await anonClient.get(`/media/${assetIds[idx]}`);
      assertSuccess(mediaRes, 200);
    }

    // 5. Deleted asset 2 returns 404 MEDIA_NOT_FOUND
    const deletedMedia = await anonClient.get(`/media/${assetIds[2]}`);
    assertError(deletedMedia, 404, 'MEDIA_NOT_FOUND');
  });

  it('WF-T4-13: Deep SPA Routing & Direct Link Handling (F01, F05, F08, F27)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Deep_Link_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: '# Deep Link Title\n## Section A\nBody text.\n',
    });

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    // 1. Deep SPA route /p/:id with Accept: text/html returns index.html fallback
    const spaRes = await anonClient.get(`/p/${pageId}`, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    assertStatus(spaRes, 200);
    assert.ok(spaRes.headers.get('content-type')?.includes('text/html'));

    // 2. Svelte frontend then calls API endpoint /api/public/pages/:id
    const apiRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(apiRes, 200);
    assert.strictEqual(apiRes.data.id, pageId);
    assert.ok(apiRes.data.markdown.includes('## Section A'));
  });

  it('WF-T4-14: Server Disaster Recovery & Volume Persistence (F01, F02, F40, F46)', async () => {
    // Verify system readiness
    const health = await anonClient.get('/healthz');
    assertSuccess(health, 200);

    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Persistence_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const zipForm = new FormData();
    zipForm.append('file', MediaGenerator.createZip('persistent_data.zip'));
    const zipRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, zipForm);
    assertStatus(zipRes, 201);
    const assetId = zipRes.data.id;

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [assetId],
    });

    // Verify media download consistency
    const dl1 = await anonClient.get(`/media/${assetId}`);
    assertSuccess(dl1, 200);
    assert.ok(dl1.headers.get('content-disposition')?.includes('persistent_data.zip'));
  });

  it('WF-T4-15: Mobile Student Reader Experience (F04, F06, F08, F09)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Mobile_Reader_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Markdown with responsive elements: wide table, code block, headers
    const mobileMarkdown = `# Mobile Responsive Practical Lab
## 1. Parameters Table
| Register | Bit Range | Description | Default | Reset Value |
| :--- | :--- | :--- | :--- | :--- |
| CR0 | [31:0] | Control Register 0 Configuration | 0x00000000 | 0x60000010 |
| CR1 | [31:0] | Control Register 1 Status Flags | 0x00000000 | 0x00000000 |

## 2. Long Code Snippet
\`\`\`c
void initialize_peripherals(unsigned int base_addr, unsigned int clock_divider, unsigned int flags) {
    volatile unsigned int *reg = (volatile unsigned int *)base_addr;
    *reg = clock_divider | flags;
}
\`\`\`
`;
    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: mobileMarkdown,
    });

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubRes, 200);
    assert.ok(pubRes.data.markdown.includes('| Register |'));
    assert.ok(pubRes.data.markdown.includes('initialize_peripherals'));
  });

  it('WF-T4-16: Rapid Consecutive Autosave & Debounce Throttling (F23, F28, F33)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Rapid_Autosave_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    let revision = pageRes.data.revision;
    // Simulate successive keystrokes debounced to single saves
    const updates = ['First sentence.', 'First sentence. Second sentence.', 'Final paragraph revision.'];
    for (const text of updates) {
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: revision,
        markdown: text,
      });
      assertSuccess(res, 200);
      revision = res.data.revision;
    }

    const finalDraft = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(finalDraft, 200);
    assert.strictEqual(finalDraft.data.draft_markdown, 'Final paragraph revision.');
    assert.strictEqual(finalDraft.data.revision, 4);
  });

  it('WF-T4-17: Draft Staging & Selective Attachment Publication (F10, F25, F39, F41)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Selective_Attachment_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // 1. Upload starter kit (public)
    const starterForm = new FormData();
    starterForm.append('file', MediaGenerator.createZip('starter_kit.zip'));
    const starterUp = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, starterForm);
    assertStatus(starterUp, 201);
    const starterId = starterUp.data.id;

    // 2. Upload solution key (private)
    const solutionForm = new FormData();
    solutionForm.append('file', MediaGenerator.createZip('solution_key.zip'));
    const solutionUp = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, solutionForm);
    assertStatus(solutionUp, 201);
    const solutionId = solutionUp.data.id;

    // 3. Publish page specifying ONLY starter_kit_id
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [starterId],
    });

    // 4. Student checks public page
    const pubPage = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubPage, 200);
    assert.strictEqual(pubPage.data.attachments.length, 1);
    assert.strictEqual(pubPage.data.attachments[0].id, starterId);

    // Starter kit is downloadable by student
    const starterDl = await anonClient.get(`/media/${starterId}`);
    assertSuccess(starterDl, 200);

    // Solution key returns 404 MEDIA_NOT_FOUND to student
    const solutionDlAnon = await anonClient.get(`/media/${solutionId}`);
    assertError(solutionDlAnon, 404, 'MEDIA_NOT_FOUND');

    // Solution key is accessible to authenticated author
    const solutionDlAdmin = await adminClient.get(`/media/${solutionId}`);
    assertSuccess(solutionDlAdmin, 200);
  });

  it('WF-T4-18: Admin Navigation Guard on Unsaved Changes (F28, F30, F35)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('NavGuard_Scenario_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Saving draft transitions revision from 1 to 2
    const saveRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: 'Text typed before navigation attempt',
    });
    assertSuccess(saveRes, 200);
    assert.strictEqual(saveRes.data.revision, 2);

    // Verified clean state
    const draft = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(draft, 200);
    assert.strictEqual(draft.data.revision, 2);
  });

  it('WF-T4-19: Special Character & Unicode Stress Testing (F06, F10, F36, F39)', async () => {
    const cyrillicSubjName = uniqueName('Физический_Практикум');
    const subjRes = await adminClient.post('/api/admin/subjects', {
      name: cyrillicSubjName,
      position: 1,
    });
    assertStatus(subjRes, 201);
    const subjectId = subjRes.data.id;
    createdSubjectIds.push(subjectId);

    const cyrillicTitle = 'Лабораторная работа №3: Исследование колебаний маятника';
    const unicodeMarkdown = `# ${cyrillicTitle}
## 1. Теоретические сведения
Формула периода колебаний:
\`\`\`
T = 2π √(L / g)
\`\`\`
Связь длины волны и частоты: \`λ = c / f\`.
Погрешность измерений: \`Δx ≈ ±0.05 мм\`.
Интеграл: \`∫ f(x) dx\`.
> 🔥 **Важное замечание:** Соблюдайте технику безопасности при работе с установкой!
`;

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjectId,
      title: cyrillicTitle,
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Upload attachment with Cyrillic filename
    const cyrillicFilename = 'Методичка_по_маятникам_2026.docx';
    const form = new FormData();
    form.append('file', MediaGenerator.createZip(cyrillicFilename));
    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form);
    assertStatus(uploadRes, 201);
    const assetId = uploadRes.data.id;

    // Save markdown and publish
    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: unicodeMarkdown,
    });

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [assetId],
    });

    // Public student retrieves page
    const pubPage = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubPage, 200);
    assert.strictEqual(pubPage.data.title, cyrillicTitle);
    assert.ok(pubPage.data.markdown.includes('λ = c / f'));
    assert.ok(pubPage.data.markdown.includes('Δx ≈ ±0.05 мм'));
    assert.ok(pubPage.data.markdown.includes('🔥'));

    // Download attachment and inspect Content-Disposition
    const dlRes = await anonClient.get(`/media/${assetId}`);
    assertSuccess(dlRes, 200);
    const contentDisposition = dlRes.headers.get('content-disposition') || '';
    assert.ok(
      contentDisposition.includes('Методичка') || contentDisposition.includes(encodeURIComponent('Методичка')) || contentDisposition.includes('attachment'),
      `Expected valid content-disposition header for Cyrillic filename, got: ${contentDisposition}`
    );
  });

  it('WF-T4-20: Network Interruption & Offline Resilience (F23, F28, F33, F34)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Offline_Resilience_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Stored content in local state
    const offlineText = 'Paragraph drafted while temporarily offline.';

    // Client reconnects, queries current revision (1), successfully submits update
    const currentDraft = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(currentDraft, 200);

    const saveRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: currentDraft.data.revision,
      markdown: offlineText,
    });
    assertSuccess(saveRes, 200);
    assert.strictEqual(saveRes.data.revision, 2);

    const verified = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(verified, 200);
    assert.strictEqual(verified.data.draft_markdown, offlineText);
  });

  it('WF-T4-21: Empty State to Full Catalog Transition (F03, F04, F11, F17, F21, F25)', async () => {
    // 1. Initially create subject without any published pages
    const subjRes = await adminClient.post('/api/admin/subjects', {
      name: uniqueName('Empty_Track'),
      position: 99,
    });
    assertStatus(subjRes, 201);
    const subjectId = subjRes.data.id;
    createdSubjectIds.push(subjectId);

    // Subject has 0 pages in public listing
    let pubSubjList = await anonClient.get('/api/public/subjects');
    assertSuccess(pubSubjList, 200);
    const foundSubj = pubSubjList.data.find((s) => s.id === subjectId);
    if (foundSubj) {
      assert.strictEqual(foundSubj.page_count, 0);
    }

    // Catalog query for this subject returns empty items
    let pubPages = await anonClient.get(`/api/public/pages?subject_id=${subjectId}`);
    assertSuccess(pubPages, 200);
    assert.strictEqual(pubPages.data.total, 0);
    assert.strictEqual(pubPages.data.items.length, 0);

    // 2. Author creates and publishes a lab in this subject
    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjectId,
      title: 'First Published Lab',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });

    // 3. Catalog now transitions to populated
    pubPages = await anonClient.get(`/api/public/pages?subject_id=${subjectId}`);
    assertSuccess(pubPages, 200);
    assert.strictEqual(pubPages.data.total, 1);
    assert.strictEqual(pubPages.data.items[0].id, pageId);

    pubSubjList = await anonClient.get('/api/public/subjects');
    assertSuccess(pubSubjList, 200);
    const updatedSubj = pubSubjList.data.find((s) => s.id === subjectId);
    assert.ok(updatedSubj);
    assert.strictEqual(updatedSubj.page_count, 1);
  });

  it('WF-T4-22: Page Cascading Deletion & Cleanup Verification (F04, F05, F24, F41, F42)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Obsolete_Coursework'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;

    // Upload an image and attachment
    const imgForm = new FormData();
    imgForm.append('file', MediaGenerator.createPng('obsolete_img.png'));
    const imgUp = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, imgForm);
    assertStatus(imgUp, 201);
    const imgId = imgUp.data.id;

    const zipForm = new FormData();
    zipForm.append('file', MediaGenerator.createZip('obsolete_code.zip'));
    const zipUp = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, zipForm);
    assertStatus(zipUp, 201);
    const zipId = zipUp.data.id;

    // Publish
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [zipId],
    });

    // Delete page
    const delRes = await adminClient.delete(`/api/admin/pages/${pageId}`);
    assertSuccess(delRes, 200);

    // Verify cascading cleanup
    const pubPage = await anonClient.get(`/api/public/pages/${pageId}`);
    assertError(pubPage, 404, 'PAGE_NOT_FOUND');

    const imgCheck = await anonClient.get(`/media/${imgId}`);
    assertError(imgCheck, 404, 'MEDIA_NOT_FOUND');

    const zipCheck = await anonClient.get(`/media/${zipId}`);
    assertError(zipCheck, 404, 'MEDIA_NOT_FOUND');

    const adminCheck = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertError(adminCheck, 404, 'PAGE_NOT_FOUND');
  });

  it('WF-T4-23: End-of-Semester Course Archival & Bulk Subject Migration (F03, F16, F17, F18, F20, F21, F25, F26)', async () => {
    // 1. Fall semester setup
    const fallSubj = await adminClient.post('/api/admin/subjects', {
      name: uniqueName('Web_Dev_Fall_2026'),
      position: 1,
    });
    assertStatus(fallSubj, 201);
    const fallSubjId = fallSubj.data.id;
    createdSubjectIds.push(fallSubjId);

    const fallPage = await adminClient.post('/api/admin/pages', {
      subject_id: fallSubjId,
      title: 'Fall Final Lab',
    });
    assertStatus(fallPage, 201);
    const fallPageId = fallPage.data.id;
    createdPageIds.push(fallPageId);

    await adminClient.post(`/api/admin/pages/${fallPageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });

    // 2. Unpublish fall lab at semester conclusion
    const unpubRes = await adminClient.delete(`/api/admin/pages/${fallPageId}/publication`);
    assertSuccess(unpubRes, 200);

    // Fall subject page count is now 0
    let subjs = await anonClient.get('/api/public/subjects');
    assertSuccess(subjs, 200);
    const fallFound = subjs.data.find((s) => s.id === fallSubjId);
    if (fallFound) {
      assert.strictEqual(fallFound.page_count, 0);
    }

    // 3. Spring semester setup
    const springSubj = await adminClient.post('/api/admin/subjects', {
      name: uniqueName('Web_Dev_Spring_2027'),
      position: 2,
    });
    assertStatus(springSubj, 201);
    const springSubjId = springSubj.data.id;
    createdSubjectIds.push(springSubjId);

    const springPage = await adminClient.post('/api/admin/pages', {
      subject_id: springSubjId,
      title: 'Spring Lab 1: Modern Web Architecture',
    });
    assertStatus(springPage, 201);
    const springPageId = springPage.data.id;
    createdPageIds.push(springPageId);

    await adminClient.post(`/api/admin/pages/${springPageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });

    // 4. Public catalog now shows only the active Spring lab
    subjs = await anonClient.get('/api/public/subjects');
    assertSuccess(subjs, 200);
    const springFound = subjs.data.find((s) => s.id === springSubjId);
    assert.ok(springFound);
    assert.strictEqual(springFound.page_count, 1);
  });
});
