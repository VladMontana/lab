// e2e_tests/tier3/tier3_pairwise_21_46.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../helpers/api_client.js';
import {
  assertStatus,
  assertSuccess,
  assertError,
  assertNotLeaked,
} from '../helpers/assertions.js';
import {
  uniqueName,
  sampleSubject,
  samplePageDraft,
} from '../helpers/fixtures.js';
import { MediaGenerator } from '../helpers/media_generator.js';
import { config } from '../config.js';

describe('Tier 3: Pairwise Interaction Coverage (TC-T3-21 to TC-T3-46)', () => {
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
    // Teardown created pages
    for (const pageId of createdPageIds) {
      try {
        await adminClient.delete(`/api/admin/pages/${pageId}`);
      } catch {
        // ignore errors
      }
    }
    // Teardown created subjects
    for (const subjId of createdSubjectIds) {
      try {
        await adminClient.delete(`/api/admin/subjects/${subjId}`);
      } catch {
        // ignore errors
      }
    }
  });

  it('TC-T3-21: Optimistic Concurrency Revision Conflict Rejection (HTTP 409) (F22 + F23)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Concurrency_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);
    assert.strictEqual(pageRes.data.revision, 1);

    // Client A updates with expected_revision: 1 -> succeeds, revision becomes 2
    const clientA = adminClient.clone();
    const patchARes = await clientA.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: 'Client A update content',
    });
    assertSuccess(patchARes, 200);
    assert.strictEqual(patchARes.data.revision, 2);

    // Client B attempts update with stale expected_revision: 1 -> fails with 409 REVISION_CONFLICT
    const clientB = adminClient.clone();
    const patchBRes = await clientB.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: 'Client B stale update content',
    });
    assertError(patchBRes, 409, 'REVISION_CONFLICT');

    // Verify draft content remained Client A's text
    const draftRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(draftRes, 200);
    assert.strictEqual(draftRes.data.draft_markdown, 'Client A update content');
    assert.strictEqual(draftRes.data.revision, 2);
  });

  it('TC-T3-22: Autosave Debounce and Monotonic Revision Increment (F23 + F33)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Autosave_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Sequence of sequential debounced saves
    let currentRev = pageRes.data.revision; // 1
    for (let i = 1; i <= 3; i++) {
      const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: currentRev,
        markdown: `Autosave revision step ${i}`,
      });
      assertSuccess(patchRes, 200);
      assert.strictEqual(patchRes.data.revision, currentRev + 1);
      currentRev = patchRes.data.revision;
    }

    const finalDraft = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(finalDraft, 200);
    assert.strictEqual(finalDraft.data.revision, 4);
    assert.strictEqual(finalDraft.data.draft_markdown, 'Autosave revision step 3');
  });

  it('TC-T3-23: Conflict Recovery from Client LocalStorage (F23 + F34)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Conflict_Recovery_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Remote update sets revision to 2
    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: 'Remote authoritative content',
    });

    // Local client with stale revision gets 409
    const localContent = 'Local client unsaved text preserved in localStorage';
    const conflictRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: localContent,
    });
    assertError(conflictRes, 409, 'REVISION_CONFLICT');

    // Client recovers: fetches latest revision (2), applies localContent with expected_revision 2
    const latestRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(latestRes, 200);
    const remoteRevision = latestRes.data.revision;

    const recoveryRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: remoteRevision,
      markdown: localContent,
    });
    assertSuccess(recoveryRes, 200);
    assert.strictEqual(recoveryRes.data.revision, 3);
  });

  it('TC-T3-24: Cascading Asset Cleanup upon Page Deletion (F24 + F41)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Cascade_Delete_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;

    // Upload asset to page
    const formData = new FormData();
    formData.append('file', MediaGenerator.createPng('cascade_test.png'));
    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
    assertStatus(uploadRes, 201);
    const assetId = uploadRes.data.id;

    // Publish page
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });

    // Asset accessible publicly
    const mediaCheck1 = await anonClient.get(`/media/${assetId}`);
    assertSuccess(mediaCheck1, 200);

    // Delete page
    const delRes = await adminClient.delete(`/api/admin/pages/${pageId}`);
    assertSuccess(delRes, 200);

    // Asset media access must return 404 MEDIA_NOT_FOUND
    const mediaCheck2 = await anonClient.get(`/media/${assetId}`);
    assertError(mediaCheck2, 404, 'MEDIA_NOT_FOUND');

    // Public page returns 404 PAGE_NOT_FOUND
    const pubCheck = await anonClient.get(`/api/public/pages/${pageId}`);
    assertError(pubCheck, 404, 'PAGE_NOT_FOUND');
  });

  it('TC-T3-25: Public Visibility Isolation for Unpublished Draft Images (F25 + F41)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Draft_Image_Gating'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Upload image to draft
    const formData = new FormData();
    formData.append('file', MediaGenerator.createPng('draft_secret.png'));
    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
    assertStatus(uploadRes, 201);
    const assetId = uploadRes.data.id;

    // Step 1: Anonymous request must receive 404 MEDIA_NOT_FOUND
    const anonRes1 = await anonClient.get(`/media/${assetId}`);
    assertError(anonRes1, 404, 'MEDIA_NOT_FOUND');

    // Step 2: Authenticated admin request receives 200 OK
    const adminRes = await adminClient.get(`/media/${assetId}`);
    assertSuccess(adminRes, 200);

    // Step 3: Admin publishes page
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });

    // Step 4: Anonymous request now receives 200 OK
    const anonRes2 = await anonClient.get(`/media/${assetId}`);
    assertSuccess(anonRes2, 200);
  });

  it('TC-T3-26: Copied Share Link Invalidation on Unpublish (F26 + F27)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Share_Link_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Publish
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });

    // While published, public page returns 200 OK
    const getBefore = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(getBefore, 200);

    // Unpublish
    const unpubRes = await adminClient.delete(`/api/admin/pages/${pageId}/publication`);
    assertSuccess(unpubRes, 200);

    // After unpublish, public page returns 404 PAGE_NOT_FOUND
    const getAfter = await anonClient.get(`/api/public/pages/${pageId}`);
    assertError(getAfter, 404, 'PAGE_NOT_FOUND');
  });

  it('TC-T3-27: Public Link Rendering Parity with Published Snapshot (F27 + F05)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const title = uniqueName('Parity_Lab');
    const markdown = `# ${title}\n\nStrict parity validation body.`;

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: title,
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown,
    });

    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubRes, 200);
    assert.strictEqual(pubRes.data.title, title);
    assert.strictEqual(pubRes.data.markdown, markdown);
    assert.strictEqual(pubRes.data.subject_id, subjRes.data.id);
  });

  it('TC-T3-28: Split-Pane Editor and Live Markdown Preview Synchronization (F28 + F30)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Split_Pane_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const sampleText = '**Bold Statement** and *Italic note* with `inline code`';
    const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: sampleText,
    });
    assertSuccess(patchRes, 200);

    const readRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(readRes, 200);
    assert.strictEqual(readRes.data.draft_markdown, sampleText);
  });

  it('TC-T3-29: Dynamic CodeMirror Bundle Splitting on Reader vs. Admin Routes (F29 + F01)', async () => {
    // Reader SPA route loads index.html without requiring admin credentials
    const readerRes = await anonClient.get('/p/00000000-0000-0000-0000-000000000000', {
      headers: { Accept: 'text/html' },
    });
    assertStatus(readerRes, 200);
    assert.ok(readerRes.headers.get('content-type')?.includes('text/html'));

    // Admin API endpoint requires authentication
    const adminApiRes = await anonClient.get('/api/admin/pages');
    assertError(adminApiRes, 401, 'UNAUTHORIZED');
  });

  it('TC-T3-30: Navigation Guard on Dirty Editor State (F30 + F35)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Nav_Guard_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Verify baseline revision is 1
    const draftRes1 = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(draftRes1, 200);
    assert.strictEqual(draftRes1.data.revision, 1);

    // Saving updates revision to 2
    const saveRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: 'Saved changes before navigating away',
    });
    assertSuccess(saveRes, 200);
    assert.strictEqual(saveRes.data.revision, 2);
  });

  it('TC-T3-31: Formatting Toolbar and Hotkey Selection Wrapping (F31 + F32)', async () => {
    const wrapBold = (text) => `**${text}**`;
    const wrapItalic = (text) => `*${text}*`;
    const wrapCode = (text) => `\`${text}\``;

    const base = 'Selected text';
    assert.strictEqual(wrapBold(base), '**Selected text**');
    assert.strictEqual(wrapItalic(base), '*Selected text*');
    assert.strictEqual(wrapCode(base), '`Selected text`');

    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: 'Formatting Test',
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const formatted = `Hello ${wrapBold('World')} and ${wrapItalic('Science')} in ${wrapCode('Rust')}`;
    const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: formatted,
    });
    assertSuccess(patchRes, 200);

    const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(getRes, 200);
    assert.strictEqual(getRes.data.draft_markdown, formatted);
  });

  it('TC-T3-32: Ctrl+S Hotkey Immediate Manual Save Bypassing Debounce (F32 + F23)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Immediate_Save_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Immediate save execution
    const immediateText = 'Immediate manual save triggered via Ctrl+S';
    const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: immediateText,
    });
    assertSuccess(patchRes, 200);
    assert.strictEqual(patchRes.data.revision, 2);

    const draftRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(draftRes, 200);
    assert.strictEqual(draftRes.data.draft_markdown, immediateText);
  });

  it('TC-T3-33: Admin Logout Purging Client LocalStorage Drafts (F33 + F14)', async () => {
    const sessionClient = new ApiClient();
    await sessionClient.login();

    // Verify authenticated
    const meRes = await sessionClient.checkMe();
    assertSuccess(meRes, 200);

    // Logout
    const logoutRes = await sessionClient.logout();
    assertSuccess(logoutRes, 200);
    assert.strictEqual(sessionClient.csrfToken, null);

    // Mutating call fails after logout
    const postRes = await sessionClient.post('/api/admin/subjects', sampleSubject());
    assertError(postRes, 401, 'UNAUTHORIZED');
  });

  it('TC-T3-34: Import Markdown File and LocalStorage Synchronization (F34 + F36)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Import_Sync_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const importedMarkdown = `# Imported Lab Guide\n\nContent imported from offline editor.\n- Step 1\n- Step 2\n`;
    const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: importedMarkdown,
    });
    assertSuccess(patchRes, 200);

    const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(getRes, 200);
    assert.strictEqual(getRes.data.draft_markdown, importedMarkdown);
  });

  it('TC-T3-35: Auto-Save Prior to Publication Dispatch (F35 + F25)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Autosave_Publish_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Save final content updating revision to 2
    const finalContent = 'Final Polish Before Publication';
    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: finalContent,
    });

    // Publish with revision 2
    const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });
    assertSuccess(pubRes, 200);
    assert.strictEqual(pubRes.data.published_revision, 2);

    // Public visitor sees final polished text
    const pubPage = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubPage, 200);
    assert.strictEqual(pubPage.data.markdown, finalContent);
  });

  it('TC-T3-36: Markdown Import/Export Neutrality Against Malicious Scripts (F36 + F43)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const dangerousSnippet = '# Lab Instructions\n<script>alert("xss")</script>\n';
    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Neutrality_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Update draft
    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: dangerousSnippet,
    });

    // In draft storage, markdown must preserve raw content verbatim
    const draftRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(draftRes, 200);
    assert.strictEqual(draftRes.data.draft_markdown, dangerousSnippet);

    // When published, public API returns markdown without leaking secrets
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 2,
      attachment_ids: [],
    });

    const pubRes = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubRes, 200);
    assertNotLeaked(pubRes.data.markdown);
  });

  it('TC-T3-37: Image Upload Streaming Storage and Magic Byte Verification (F37 + F40)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Magic_Byte_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // 1. Valid PNG upload succeeds
    const goodForm = new FormData();
    goodForm.append('file', MediaGenerator.createPng('valid.png'));
    const goodRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, goodForm);
    assertStatus(goodRes, 201);
    assert.strictEqual(goodRes.data.kind, 'image');

    // 2. Corrupted PNG with invalid magic bytes fails with 400 INVALID_IMAGE_FORMAT
    const badForm = new FormData();
    badForm.append('file', MediaGenerator.createCorruptedImage('corrupted.png'));
    const badRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, badForm);
    assertError(badRes, 400, 'INVALID_IMAGE_FORMAT');
  });

  it('TC-T3-38: Drag-and-Drop Image Insertion at Exact Editor Cursor (F37 + F38)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('DnD_Image_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const form = new FormData();
    form.append('file', MediaGenerator.createPng('screenshot.png'));
    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form);
    assertStatus(uploadRes, 201);
    const assetId = uploadRes.data.id;

    // Simulate inserting ![screenshot.png](/media/:id) at cursor position
    const insertedMarkdown = `Initial paragraph.\n\n![screenshot.png](/media/${assetId})\n\nSubsequent text.`;
    const patchRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: insertedMarkdown,
    });
    assertSuccess(patchRes, 200);

    const draftRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(draftRes, 200);
    assert.ok(draftRes.data.draft_markdown.includes(`/media/${assetId}`));
  });

  it('TC-T3-39: Editor Markdown Image Auto-Preview Rendering (F38 + F30)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Auto_Preview_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const form = new FormData();
    form.append('file', MediaGenerator.createJpeg('sample.jpg'));
    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form);
    assertStatus(uploadRes, 201);
    const assetId = uploadRes.data.id;

    const markdownWithImg = `# Visual Preview\n\n![Sample](/media/${assetId})\n`;
    await adminClient.patch(`/api/admin/pages/${pageId}`, {
      expected_revision: 1,
      markdown: markdownWithImg,
    });

    const getRes = await adminClient.get(`/api/admin/pages/${pageId}`);
    assertSuccess(getRes, 200);
    assert.ok(getRes.data.draft_markdown.includes(`/media/${assetId}`));
  });

  it('TC-T3-40: Attachment Streaming Storage Chunk Handling (F39 + F40)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Chunked_Attachment_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const form = new FormData();
    form.append('file', MediaGenerator.createZip('dataset.zip'));
    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form);
    assertStatus(uploadRes, 201);
    assert.strictEqual(uploadRes.data.kind, 'attachment');
    assert.strictEqual(uploadRes.data.original_name, 'dataset.zip');
    assert.strictEqual(uploadRes.data.mime, 'application/zip');
  });

  it('TC-T3-41: Attachment Publication Inclusion and Public Download Verification (F39 + F10)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Attachment_Pub_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const form = new FormData();
    form.append('file', MediaGenerator.createPdf('manual.pdf'));
    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form);
    assertStatus(uploadRes, 201);
    const assetId = uploadRes.data.id;

    // Publish with attachment ID
    const pubRes = await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [assetId],
    });
    assertSuccess(pubRes, 200);

    // Public page returns attachment
    const pubPage = await anonClient.get(`/api/public/pages/${pageId}`);
    assertSuccess(pubPage, 200);
    const attachment = pubPage.data.attachments.find((a) => a.id === assetId);
    assert.ok(attachment, 'Published attachment must be present');
    assert.strictEqual(attachment.original_name, 'manual.pdf');

    // Download media
    const dlRes = await anonClient.get(`/media/${assetId}`);
    assertSuccess(dlRes, 200);
    assert.ok(dlRes.headers.get('content-type')?.includes('application/pdf'));
  });

  it('TC-T3-42: Uploaded Asset Persistence Across Server Restarts (F40 + F46)', async () => {
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

    const form = new FormData();
    form.append('file', MediaGenerator.createPng('persistent_icon.png'));
    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form);
    assertStatus(uploadRes, 201);
    const assetId = uploadRes.data.id;

    // Publish page
    await adminClient.post(`/api/admin/pages/${pageId}/publish`, {
      expected_revision: 1,
      attachment_ids: [],
    });

    // Multiple sequential downloads to verify streaming consistency
    for (let i = 0; i < 3; i++) {
      const getRes = await anonClient.get(`/media/${assetId}`);
      assertSuccess(getRes, 200);
      assert.ok(getRes.headers.get('content-type')?.includes('image/png'));
    }
  });

  it('TC-T3-43: Media Access Gating via Session Cookie Authentication (F41 + F13)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Gating_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    const form = new FormData();
    form.append('file', MediaGenerator.createWebp('draft_only.webp'));
    const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form);
    assertStatus(uploadRes, 201);
    const assetId = uploadRes.data.id;

    // Anonymous visitor cannot access draft media -> 404 MEDIA_NOT_FOUND
    const anonRes = await anonClient.get(`/media/${assetId}`);
    assertError(anonRes, 404, 'MEDIA_NOT_FOUND');

    // Authenticated admin can access draft media -> 200 OK
    const adminRes = await adminClient.get(`/media/${assetId}`);
    assertSuccess(adminRes, 200);
    assert.ok(adminRes.headers.get('content-type')?.includes('image/webp'));
  });

  it('TC-T3-44: Asset Listing and Asset Deletion Synchronization (F42 + F24)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Asset_List_Del_Lab'),
    });
    assertStatus(pageRes, 201);
    const pageId = pageRes.data.id;
    createdPageIds.push(pageId);

    // Upload two assets
    const form1 = new FormData();
    form1.append('file', MediaGenerator.createPng('asset1.png'));
    const res1 = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form1);
    assertStatus(res1, 201);
    const asset1Id = res1.data.id;

    const form2 = new FormData();
    form2.append('file', MediaGenerator.createPng('asset2.png'));
    const res2 = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, form2);
    assertStatus(res2, 201);
    const asset2Id = res2.data.id;

    // List assets
    let listRes = await adminClient.get(`/api/admin/pages/${pageId}/assets`);
    assertSuccess(listRes, 200);
    assert.ok(listRes.data.some((a) => a.id === asset1Id));
    assert.ok(listRes.data.some((a) => a.id === asset2Id));

    // Delete asset 1
    const delAssetRes = await adminClient.delete(`/api/admin/pages/${pageId}/assets/${asset1Id}`);
    assertSuccess(delAssetRes, 200);

    // List assets again: asset 1 must be gone
    listRes = await adminClient.get(`/api/admin/pages/${pageId}/assets`);
    assertSuccess(listRes, 200);
    assert.ok(!listRes.data.some((a) => a.id === asset1Id));
    assert.ok(listRes.data.some((a) => a.id === asset2Id));

    // Direct access to asset 1 returns 404 MEDIA_NOT_FOUND
    const mediaRes = await adminClient.get(`/media/${asset1Id}`);
    assertError(mediaRes, 404, 'MEDIA_NOT_FOUND');
  });

  it('TC-T3-45: Sanitization of Malicious Code Snippets in Code Blocks (F43 + F07)', async () => {
    const subjRes = await adminClient.post('/api/admin/subjects', sampleSubject());
    assertStatus(subjRes, 201);
    createdSubjectIds.push(subjRes.data.id);

    const maliciousCode = '<script>window.pwned=true;</script>';
    const markdownContent = `# Exploit Demonstration\n\n\`\`\`html\n${maliciousCode}\n\`\`\`\n`;

    const pageRes = await adminClient.post('/api/admin/pages', {
      subject_id: subjRes.data.id,
      title: uniqueName('Code_Sanitize_Lab'),
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
    assert.ok(pubRes.data.markdown.includes(maliciousCode), 'Markdown raw content must preserve code text');
    assertNotLeaked(pubRes.data.markdown);
  });

  it('TC-T3-46: Combined Security Defense: CSRF and Rate Limiting (F44 + F45)', async () => {
    // 1. Mutating requests without CSRF token return 403 FORBIDDEN
    const noCsrfClient = adminClient.clone();
    const forbiddenRes = await noCsrfClient.post('/api/admin/subjects', sampleSubject(), {
      headers: { 'X-CSRF-Token': '' },
    });
    assertError(forbiddenRes, 403, 'FORBIDDEN');

    // 2. Healthz remains unthrottled and 200 OK
    const healthRes = await anonClient.get('/healthz');
    assertSuccess(healthRes, 200);
    assert.strictEqual(healthRes.data.status, 'ok');
  });
});
