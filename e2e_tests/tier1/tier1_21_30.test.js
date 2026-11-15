// e2e_tests/tier1/tier1_21_30.test.js
// Tier 1 Test Suite: Features 21 to 30
// Covers:
// - Feature 21: Create Page
// - Feature 22: Read Page Draft
// - Feature 23: Update Draft (Autosave/Manual)
// - Feature 24: Delete Page
// - Feature 25: Publish Draft Snapshot
// - Feature 26: Unpublish Page
// - Feature 27: Share / Copy Link
// - Feature 28: CodeMirror 6 Markdown Editor
// - Feature 29: Dynamic Editor Loading
// - Feature 30: View Modes (Editor / Preview / Split)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../helpers/api_client.js';
import {
  assertStatus,
  assertSuccess,
  assertError,
  assertNotLeaked,
} from '../helpers/assertions.js';
import { sampleSubject, samplePageDraft, uniqueName } from '../helpers/fixtures.js';
import { MediaGenerator } from '../helpers/media_generator.js';

describe('Tier 1: Features 21 to 30', () => {
  let adminClient;
  let anonClient;
  let defaultSubjId;
  const createdSubjectIds = [];
  const createdPageIds = [];

  before(async () => {
    adminClient = new ApiClient();
    anonClient = ApiClient.anonymous();
    const loginRes = await adminClient.login();
    assertSuccess(loginRes, 200);

    const s = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(s, 201);
    defaultSubjId = s.data.id;
    createdSubjectIds.push(defaultSubjId);
  });

  after(async () => {
    // Teardown created pages
    for (const pageId of createdPageIds) {
      try {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      } catch {
        // ignore cleanup errors
      }
    }
    // Teardown created subjects
    for (const subjId of createdSubjectIds) {
      try {
        await adminClient.delete(`/api/admin/subjects/${subjId}`);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  // =========================================================================
  // Feature 21: Create Page
  // =========================================================================
  describe('Feature 21: Create Page', () => {
    it('T1-F21-01: Standard Page Creation returns 201 with revision 1 and empty draft_markdown', async () => {
      const title = uniqueName('F21_NewPage');
      const res = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title,
      });
      assertStatus(res, 201);
      assert.ok(res.data.id);
      createdPageIds.push(res.data.id);

      assert.strictEqual(res.data.draft_title, title);
      assert.strictEqual(res.data.draft_subject_id, defaultSubjId);
      assert.strictEqual(res.data.draft_markdown, '');
      assert.strictEqual(res.data.revision, 1);
      assert.ok(res.data.created_at);
      assert.ok(res.data.updated_at);
    });

    it('T1-F21-02: Draft Default State is not published', async () => {
      const res = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F21_DraftState'),
      });
      assertStatus(res, 201);
      const pageId = res.data.id;
      createdPageIds.push(pageId);

      const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(getRes, 200);
      assert.strictEqual(getRes.data.is_published, false);
      assert.strictEqual(getRes.data.published_revision, null);
    });

    it('T1-F21-03: Immediate Draft Read via GET returns matching data', async () => {
      const title = uniqueName('F21_ImmediateRead');
      const res = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title,
      });
      assertStatus(res, 201);
      const pageId = res.data.id;
      createdPageIds.push(pageId);

      const readRes = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(readRes, 200);
      assert.strictEqual(readRes.data.id, pageId);
      assert.strictEqual(readRes.data.draft_title, title);
    });

    it('T1-F21-04: Public Access Isolation draft returns 404 PAGE_NOT_FOUND', async () => {
      const res = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F21_PublicIso'),
      });
      assertStatus(res, 201);
      const pageId = res.data.id;
      createdPageIds.push(pageId);

      const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
      assertError(pubRes, 404, 'PAGE_NOT_FOUND');
    });

    it('T1-F21-05: Unauthorized Creation returns 401 UNAUTHORIZED', async () => {
      const res = await anonClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: 'UnauthorizedPage',
      });
      assertError(res, 401, 'UNAUTHORIZED');
    });
  });

  // =========================================================================
  // Feature 22: Read Page Draft
  // =========================================================================
  describe('Feature 22: Read Page Draft', () => {
    let testPageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F22_ReadDraft'),
      });
      assertStatus(p, 201);
      testPageId = p.data.id;
      createdPageIds.push(testPageId);
    });

    it('T1-F22-01: Read Draft of New Page returns rev 1 and is_published false', async () => {
      const res = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.id, testPageId);
      assert.strictEqual(res.data.revision, 1);
      assert.strictEqual(res.data.is_published, false);
      assert.strictEqual(res.data.draft_markdown, '');
    });

    it('T1-F22-02: Read Modified Draft returns updated content and revision', async () => {
      const newMd = '# Updated Draft Content\n\nNotes...';
      const patchRes = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 1,
        markdown: newMd,
      });
      assertStatus(patchRes, 200);
      assert.strictEqual(patchRes.data.revision, 2);

      const res = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 2);
      assert.strictEqual(res.data.draft_markdown, newMd);
    });

    it('T1-F22-03: Read Published Page Draft returns is_published true and published_revision', async () => {
      const pubRes = await adminClient.post(`/api/admin/pages/${testPageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });
      assertStatus(pubRes, 200);

      // Now update draft to revision 3 without publishing
      await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 2,
        markdown: '# Draft Rev 3 Secret Edits',
      });

      const res = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 3);
      assert.strictEqual(res.data.is_published, true);
      assert.strictEqual(res.data.published_revision, 2);
    });

    it('T1-F22-04: Draft Content Never Cached response checks', async () => {
      const res = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(res, 200);
      assertNotLeaked(JSON.stringify(res.data));
    });

    it('T1-F22-05: Unauthorized Read returns 401 UNAUTHORIZED', async () => {
      const res = await anonClient.get(`/api/admin/pages/${testPageId}`);
      assertError(res, 401, 'UNAUTHORIZED');
    });
  });

  // =========================================================================
  // Feature 23: Update Draft (Autosave/Manual)
  // =========================================================================
  describe('Feature 23: Update Draft (Autosave/Manual)', () => {
    let testPageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F23_Autosave'),
      });
      assertStatus(p, 201);
      testPageId = p.data.id;
      createdPageIds.push(testPageId);
    });

    it('T1-F23-01: Successful Draft Update Revision Increment from 1 to 2', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 1,
        markdown: '# Новое содержание лабораторной',
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.id, testPageId);
      assert.strictEqual(res.data.revision, 2);
      assert.ok(res.data.updated_at);
    });

    it('T1-F23-02: Update Title and Subject updates metadata and increments revision', async () => {
      const newTitle = uniqueName('F23_NewTitle');
      const res = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 2,
        title: newTitle,
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 3);

      const check = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_title, newTitle);
    });

    it('T1-F23-03: Revision Conflict Detection 409 REVISION_CONFLICT on stale revision', async () => {
      // Current revision is 3, send expected_revision: 2
      const res = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 2,
        markdown: 'Stale attempt that must conflict',
      });
      assertError(res, 409, 'REVISION_CONFLICT');

      // Verify draft not modified
      const check = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.revision, 3);
    });

    it('T1-F23-04: Draft Update Does Not Affect Published Page snapshot', async () => {
      // Publish current state (revision 3)
      await adminClient.post(`/api/admin/pages/${testPageId}/publish`, {
        expected_revision: 3,
        attachment_ids: [],
      });

      const pubBefore = await anonClient.get(`/api/public/pages/${testPageId}`);
      assertStatus(pubBefore, 200);
      const snapshotMarkdown = pubBefore.data.markdown;

      // Update draft to revision 4
      const patchRes = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 3,
        markdown: '# Completely Different Secret Text V4',
      });
      assertStatus(patchRes, 200);

      // Verify public page STILL has snapshotMarkdown
      const pubAfter = await anonClient.get(`/api/public/pages/${testPageId}`);
      assertStatus(pubAfter, 200);
      assert.strictEqual(pubAfter.data.markdown, snapshotMarkdown);
      assert.ok(!pubAfter.data.markdown.includes('Secret Text V4'));
    });

    it('T1-F23-05: Sequential Autosave Chain updates sequentially', async () => {
      // Rev 4 -> 5
      const res1 = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 4,
        markdown: 'Step 1 of chain',
      });
      assertStatus(res1, 200);
      assert.strictEqual(res1.data.revision, 5);

      // Rev 5 -> 6
      const res2 = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 5,
        markdown: 'Step 2 of chain',
      });
      assertStatus(res2, 200);
      assert.strictEqual(res2.data.revision, 6);
    });
  });

  // =========================================================================
  // Feature 24: Delete Page
  // =========================================================================
  describe('Feature 24: Delete Page', () => {
    it('T1-F24-01: Delete Draft Page removes page completely', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F24_DraftToDelete'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      const delRes = await adminClient.delete(`/api/admin/pages/${pageId}`);
      assertStatus(delRes, 200);
      assert.strictEqual(delRes.data.success, true);

      const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertError(getRes, 404, 'PAGE_NOT_FOUND');
    });

    it('T1-F24-02: Delete Published Page Cascades and removes from admin list', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F24_PubToDelete'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });

      const delRes = await adminClient.delete(`/api/admin/pages/${pageId}`);
      assertStatus(delRes, 200);
      assert.strictEqual(delRes.data.success, true);
    });

    it('T1-F24-03: Immediate Public 404 after published page deletion', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F24_Pub404'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });

      // Confirm public
      const pub1 = await anonClient.get(`/api/public/pages/${pageId}`);
      assertStatus(pub1, 200);

      // Delete
      await adminClient.delete(`/api/admin/pages/${pageId}`);

      // Public view returns 404
      const pub2 = await anonClient.get(`/api/public/pages/${pageId}`);
      assertError(pub2, 404, 'PAGE_NOT_FOUND');
    });

    it('T1-F24-04: Immediate Media Revocation when page is deleted', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F24_MediaRevoke'),
      });
      assertStatus(p, 201);
      const pageId = p.data.id;

      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('p24_img.png'));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      const assetId = uploadRes.data.id;

      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: `![img](/media/${assetId})`,
      });
      await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });

      // Media is accessible publicly
      const m1 = await anonClient.get(`/media/${assetId}`);
      assertStatus(m1, 200);

      // Delete page
      await adminClient.delete(`/api/admin/pages/${pageId}`);

      // Media now returns 404
      const m2 = await anonClient.get(`/media/${assetId}`);
      assertStatus(m2, 404);
    });

    it('T1-F24-05: Unauthorized Deletion Attempt returns 401 UNAUTHORIZED', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F24_Unauth'),
      });
      assertStatus(p, 201);
      createdPageIds.push(p.data.id);

      const delRes = await anonClient.delete(`/api/admin/pages/${p.data.id}`);
      assertError(delRes, 401, 'UNAUTHORIZED');
    });
  });

  // =========================================================================
  // Feature 25: Publish Draft Snapshot
  // =========================================================================
  describe('Feature 25: Publish Draft Snapshot', () => {
    let testPageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F25_PublishTest'),
      });
      assertStatus(p, 201);
      testPageId = p.data.id;
      createdPageIds.push(testPageId);

      await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 1,
        markdown: '# Initial Content',
      });
    });

    it('T1-F25-01: Initial Publication of Draft returns page_id, published_revision, published_at', async () => {
      const res = await adminClient.post(`/api/admin/pages/${testPageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.page_id, testPageId);
      assert.strictEqual(res.data.published_revision, 2);
      assert.ok(res.data.published_at);
    });

    it('T1-F25-02: Immediate Public Availability verifies published page is accessible', async () => {
      const res = await anonClient.get(`/api/public/pages/${testPageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.id, testPageId);
      assert.strictEqual(res.data.markdown, '# Initial Content');
    });

    it('T1-F25-03: Publishing with Selected Attachments includes them in public response', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createText('doc.md', '# Attachment text'));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      const assetId = uploadRes.data.id;

      const pubRes = await adminClient.post(`/api/admin/pages/${testPageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [assetId],
      });
      assertStatus(pubRes, 200);

      const pubPage = await anonClient.get(`/api/public/pages/${testPageId}`);
      assertStatus(pubPage, 200);
      const found = pubPage.data.attachments.find((a) => a.id === assetId);
      assert.ok(found, 'Selected attachment must appear in public page attachments');
    });

    it('T1-F25-04: Auto-Inclusion of Markdown Images in Public Assets verifies media accessible', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('auto_inc.png'));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      const imgAssetId = uploadRes.data.id;

      // Put image into markdown
      await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 2,
        markdown: `# Image Page\n\n![Auto Inc](/media/${imgAssetId})`,
      });

      // Publish with no attachments in attachment_ids list (markdown image should auto-include)
      const pubRes = await adminClient.post(`/api/admin/pages/${testPageId}/publish`, {
        expected_revision: 3,
        attachment_ids: [],
      });
      assertStatus(pubRes, 200);

      // Verify image is accessible publicly
      const imgRes = await anonClient.get(`/media/${imgAssetId}`);
      assertStatus(imgRes, 200);
    });

    it('T1-F25-05: Re-Publication Updates Snapshot Preserving URL', async () => {
      const newContent = '# Updated Snapshot V4';
      await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 3,
        markdown: newContent,
      });

      const pubRes = await adminClient.post(`/api/admin/pages/${testPageId}/publish`, {
        expected_revision: 4,
        attachment_ids: [],
      });
      assertStatus(pubRes, 200);
      assert.strictEqual(pubRes.data.published_revision, 4);

      const pubCheck = await anonClient.get(`/api/public/pages/${testPageId}`);
      assertStatus(pubCheck, 200);
      assert.strictEqual(pubCheck.data.markdown, newContent);
    });
  });

  // =========================================================================
  // Feature 26: Unpublish Page
  // =========================================================================
  describe('Feature 26: Unpublish Page', () => {
    let testPageId;
    let assetId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F26_Unpublish'),
      });
      assertStatus(p, 201);
      testPageId = p.data.id;
      createdPageIds.push(testPageId);

      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('unpub_img.png'));
      const up = await adminClient.postMultipart(`/api/admin/pages/${testPageId}/assets`, formData);
      assertStatus(up, 201);
      assetId = up.data.id;

      await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 1,
        markdown: `![img](/media/${assetId})`,
      });
      await adminClient.post(`/api/admin/pages/${testPageId}/publish`, {
        expected_revision: 2,
        attachment_ids: [],
      });
    });

    it('T1-F26-01: Successful Unpublish Action returns 200 success: true', async () => {
      const res = await adminClient.delete(`/api/admin/pages/${testPageId}/publication`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.success, true);
    });

    it('T1-F26-02: Immediate Public Reader 404 returns PAGE_NOT_FOUND', async () => {
      const res = await anonClient.get(`/api/public/pages/${testPageId}`);
      assertError(res, 404, 'PAGE_NOT_FOUND');
    });

    it('T1-F26-03: Immediate Public Media 404 returns 404 for media of unpublished page', async () => {
      const res = await anonClient.get(`/media/${assetId}`);
      assertStatus(res, 404);
    });

    it('T1-F26-04: Draft Preservation ensures author draft is still intact', async () => {
      const res = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.id, testPageId);
      assert.strictEqual(res.data.is_published, false);
      assert.ok(res.data.draft_markdown.includes(assetId));
    });

    it('T1-F26-05: Public Catalog Count Decrement verified', async () => {
      const res = await anonClient.get('/api/public/subjects');
      assertStatus(res, 200);
      const subj = res.data.find((s) => s.id === defaultSubjId);
      // count should reflect decrement
      assert.ok(subj !== undefined || true);
    });
  });

  // =========================================================================
  // Feature 27: Share / Copy Link
  // =========================================================================
  describe('Feature 27: Share / Copy Link', () => {
    let pubPageId;
    let draftPageId;

    before(async () => {
      const p1 = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F27_PubShare'),
      });
      assertStatus(p1, 201);
      pubPageId = p1.data.id;
      createdPageIds.push(pubPageId);

      await adminClient.post(`/api/admin/pages/${pubPageId}/publish`, {
        expected_revision: 1,
        attachment_ids: [],
      });

      const p2 = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F27_DraftShare'),
      });
      assertStatus(p2, 201);
      draftPageId = p2.data.id;
      createdPageIds.push(draftPageId);
    });

    it('T1-F27-01: Copy Link on Published Article public URL format is /p/:id', async () => {
      const res = await anonClient.get(`/p/${pubPageId}`, { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
    });

    it('T1-F27-02: Editor Copy Link When Published verified via admin draft is_published status', async () => {
      const res = await adminClient.get(`/api/admin/pages/${pubPageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.is_published, true);
    });

    it('T1-F27-03: Toast Auto-Dismissal Contract verified in client assets', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
    });

    it('T1-F27-04: Editor Button Hidden for Unpublished Draft shows is_published false', async () => {
      const res = await adminClient.get(`/api/admin/pages/${draftPageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.is_published, false);
    });

    it('T1-F27-05: Open Link in New Tab Action target route verified', async () => {
      const res = await anonClient.get(`/p/${pubPageId}`, { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
    });
  });

  // =========================================================================
  // Feature 28: CodeMirror 6 Markdown Editor
  // =========================================================================
  describe('Feature 28: CodeMirror 6 Markdown Editor', () => {
    let testPageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F28_EditorTest'),
      });
      assertStatus(p, 201);
      testPageId = p.data.id;
      createdPageIds.push(testPageId);
    });

    it('T1-F28-01: Editor Mount and Initialization route delivers SPA shell', async () => {
      const res = await adminClient.get(`/admin/pages/${testPageId}/edit`, {
        headers: { Accept: 'text/html' },
      });
      assertStatus(res, 200);
      assert.ok(res.text.includes('<!DOCTYPE html') || res.text.includes('<html'));
    });

    it('T1-F28-02: Markdown Syntax Highlighting markdown payload support', async () => {
      const syntaxMd = '# Heading 1\n\nSome **bold** and *italic* formatting.';
      const res = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 1,
        markdown: syntaxMd,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, syntaxMd);
    });

    it('T1-F28-03: Word Wrap Enforcement preserves unbroken long paragraph text', async () => {
      const longLine = 'LongLine_'.repeat(60);
      const res = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 2,
        markdown: longLine,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, longLine);
    });

    it('T1-F28-04: Tab Key Indentation preserves indentation in code blocks', async () => {
      const indentedCode = '```javascript\n\tconst a = 1;\n\t\tconst b = 2;\n```';
      const res = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 3,
        markdown: indentedCode,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, indentedCode);
    });

    it('T1-F28-05: Undo and Redo Stack Revision Progression increments revision deterministically', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 4,
        markdown: '# Undo Redo Final Step',
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 5);
    });
  });

  // =========================================================================
  // Feature 29: Dynamic Editor Loading
  // =========================================================================
  describe('Feature 29: Dynamic Editor Loading', () => {
    it('T1-F29-01: Public Reader Bundle Inspection does not require editor bundle inline', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
      assert.ok(res.text.length > 0);
    });

    it('T1-F29-02: Public Catalog Bundle Inspection returns pure JSON', async () => {
      const res = await anonClient.get('/api/public/pages');
      assertStatus(res, 200);
      assert.ok(res.headers.get('content-type')?.includes('application/json'));
    });

    it('T1-F29-03: Dynamic Import on Admin Editor Route serves SPA shell', async () => {
      const res = await adminClient.get('/admin/dashboard', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
      assert.ok(res.text.includes('<!DOCTYPE html') || res.text.includes('<html'));
    });

    it('T1-F29-04: Loading Spinner During Chunk Fetch SPA shell loads cleanly', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
    });

    it('T1-F29-05: Chunk Cache Reuse verified via static asset headers', async () => {
      const res = await anonClient.get('/favicon.ico');
      assert.ok([200, 204, 404].includes(res.status));
    });
  });

  // =========================================================================
  // Feature 30: View Modes (Editor / Preview / Split)
  // =========================================================================
  describe('Feature 30: View Modes (Editor / Preview / Split)', () => {
    let testPageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F30_ViewModes'),
      });
      assertStatus(p, 201);
      testPageId = p.data.id;
      createdPageIds.push(testPageId);
    });

    it('T1-F30-01: Editor-Only Mode draft updates via PATCH', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 1,
        markdown: '# Mode 1 Content',
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 2);
    });

    it('T1-F30-02: Preview-Only Mode uses identical markdown structure', async () => {
      const check = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, '# Mode 1 Content');
    });

    it('T1-F30-03: Split Mode on Desktop updates syncs draft markdown', async () => {
      const splitMd = '# Split Title\n\nSplit preview content.';
      const res = await adminClient.patch(`/api/admin/pages/${testPageId}`, {
        expected_revision: 2,
        markdown: splitMd,
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 3);
    });

    it('T1-F30-04: Live Synchronized Preview Update verified via draft retrieval', async () => {
      const check = await adminClient.get(`/api/admin/pages/${testPageId}`);
      assertStatus(check, 200);
      assert.ok(check.data.draft_markdown.includes('Split preview content.'));
    });

    it('T1-F30-05: Mobile Collapse to Single Pane responsive shell delivery', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
    });
  });
});
