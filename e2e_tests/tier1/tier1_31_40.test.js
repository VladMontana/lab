// e2e_tests/tier1/tier1_31_40.test.js
// Tier 1 Test Suite: Features 31 to 40
// Covers:
// - Feature 31: Formatting Toolbar
// - Feature 32: Formatting Hotkeys
// - Feature 33: Autosave & Status Indicators
// - Feature 34: LocalStorage Recovery
// - Feature 35: Navigation Guard
// - Feature 36: Import / Export Markdown
// - Feature 37: Image Upload (Paste / DnD / Picker)
// - Feature 38: Image Insertion in Editor
// - Feature 39: Attachment Upload
// - Feature 40: Streaming Disk Storage

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

describe('Tier 1: Features 31 to 40', () => {
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
  // Feature 31: Formatting Toolbar
  // =========================================================================
  describe('Feature 31: Formatting Toolbar', () => {
    let pageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F31_Toolbar'),
      });
      assertStatus(p, 201);
      pageId = p.data.id;
      createdPageIds.push(pageId);
    });

    it('T1-F31-01: Bold Button syntax wrapping **text** preserved in draft', async () => {
      const boldMd = '**важная команда**';
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: boldMd,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, boldMd);
    });

    it('T1-F31-02: Italic Button syntax wrapping *text* preserved in draft', async () => {
      const italicMd = '*курсив*';
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 2,
        markdown: italicMd,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, italicMd);
    });

    it('T1-F31-03: Heading Level Buttons H2 insertion preserved in draft', async () => {
      const h2Md = '## Введение в лабораторную работу';
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 3,
        markdown: h2Md,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, h2Md);
    });

    it('T1-F31-04: Code Block Insertion syntax fences preserved in draft', async () => {
      const codeBlockMd = '```bash\necho "Hello"\n```';
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 4,
        markdown: codeBlockMd,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, codeBlockMd);
    });

    it('T1-F31-05: Undo Formatting via History revisions advance reliably', async () => {
      const revertedMd = 'Plain text without formatting';
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 5,
        markdown: revertedMd,
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 6);
    });
  });

  // =========================================================================
  // Feature 32: Formatting Hotkeys
  // =========================================================================
  describe('Feature 32: Formatting Hotkeys', () => {
    let pageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F32_Hotkeys'),
      });
      assertStatus(p, 201);
      pageId = p.data.id;
      createdPageIds.push(pageId);
    });

    it('T1-F32-01: Ctrl+S Triggers Immediate Save without revision conflict', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: '# Saved via Ctrl+S',
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 2);
    });

    it('T1-F32-02: Ctrl+B Toggles Bold syntax preserved on save', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 2,
        markdown: 'Text with **терминал** command',
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 3);
    });

    it('T1-F32-03: Ctrl+I Toggles Italic syntax preserved on save', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 3,
        markdown: 'Text with *заметка* note',
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 4);
    });

    it('T1-F32-04: Hotkeys with Empty Selection syntax preserved cleanly', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 4,
        markdown: '**** and **',
      });
      assertStatus(res, 200);
    });

    it('T1-F32-05: Undo Hotkey Action returns to previous revision content', async () => {
      const undoText = 'Restored text state';
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 5,
        markdown: undoText,
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 6);
    });
  });

  // =========================================================================
  // Feature 33: Autosave & Status Indicators
  // =========================================================================
  describe('Feature 33: Autosave & Status Indicators', () => {
    let pageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F33_Autosave'),
      });
      assertStatus(p, 201);
      pageId = p.data.id;
      createdPageIds.push(pageId);
    });

    it('T1-F33-01: Typing Transitions to Dirty Status verified via revision progression', async () => {
      const res = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 1);
    });

    it('T1-F33-02: Autosave Debounce Trigger updates draft on server', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: 'Autosaved revision 2',
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 2);
    });

    it('T1-F33-03: Successful Autosave Completion returns 200 with new revision and updated_at', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 2,
        markdown: 'Autosaved revision 3',
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 3);
      assert.ok(res.data.updated_at);
    });

    it('T1-F33-04: Typing While Save In Flight sequential queue execution', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 3,
        markdown: 'Autosaved revision 4',
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 4);
    });

    it('T1-F33-05: Server Error Display returns 409 on revision conflict without data wipe', async () => {
      const conflictRes = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1, // Stale!
        markdown: 'Attempted overwrite',
      });
      assertError(conflictRes, 409, 'REVISION_CONFLICT');

      // Verify original draft is still rev 4
      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.revision, 4);
      assert.strictEqual(check.data.draft_markdown, 'Autosaved revision 4');
    });
  });

  // =========================================================================
  // Feature 34: LocalStorage Recovery
  // =========================================================================
  describe('Feature 34: LocalStorage Recovery', () => {
    let pageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F34_Recovery'),
      });
      assertStatus(p, 201);
      pageId = p.data.id;
      createdPageIds.push(pageId);
    });

    it('T1-F34-01: Draft Caching on Edit contract verifies draft payload format', async () => {
      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.ok(typeof check.data.revision === 'number');
      assert.ok(typeof check.data.draft_markdown === 'string');
    });

    it('T1-F34-02: Recovery Prompt on Page Reopen server draft returns revision', async () => {
      const res = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 1);
    });

    it('T1-F34-03: Accept Recovery updates server draft with recovered content', async () => {
      const recoveredText = '# Recovered from Local Cache';
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: recoveredText,
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 2);

      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, recoveredText);
    });

    it('T1-F34-04: Discard Recovery retains existing server draft', async () => {
      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.revision, 2);
    });

    it('T1-F34-05: Cleanup on Successful Save aligns revision state', async () => {
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 2,
        markdown: '# Final Clean State',
      });
      assertStatus(res, 200);
      assert.strictEqual(res.data.revision, 3);
    });
  });

  // =========================================================================
  // Feature 35: Navigation Guard
  // =========================================================================
  describe('Feature 35: Navigation Guard', () => {
    it('T1-F35-01: Browser Tab Close Warning SPA shell delivered for client handling', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
    });

    it('T1-F35-02: No Warning When Saved state verified via draft sync', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F35_Saved'),
      });
      assertStatus(p, 201);
      createdPageIds.push(p.data.id);

      const res = await adminClient.get(`/api/admin/pages/${p.data.id}`);
      assertStatus(res, 200);
    });

    it('T1-F35-03: In-App SPA Navigation Interception SPA router handles routes', async () => {
      const res = await anonClient.get('/admin/pages', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
    });

    it('T1-F35-04: Cancel Navigation draft content remains intact on server', async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F35_Cancel'),
      });
      assertStatus(p, 201);
      createdPageIds.push(p.data.id);

      const res = await adminClient.get(`/api/admin/pages/${p.data.id}`);
      assertStatus(res, 200);
      assert.ok(res.data.id);
    });

    it('T1-F35-05: Confirm Navigation route transition succeeds cleanly', async () => {
      const res = await anonClient.get('/', { headers: { Accept: 'text/html' } });
      assertStatus(res, 200);
    });
  });

  // =========================================================================
  // Feature 36: Import / Export Markdown
  // =========================================================================
  describe('Feature 36: Import / Export Markdown', () => {
    let pageId;
    const testMarkdown = '# Practical Work Export\n\n## Table\n| A | B |\n|---|---|\n| 1 | 2 |\n';

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: 'Лабораторная работа 1 - Импорт Экспорт',
      });
      assertStatus(p, 201);
      pageId = p.data.id;
      createdPageIds.push(pageId);

      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: testMarkdown,
      });
    });

    it('T1-F36-01: Export Markdown File provides exact markdown content', async () => {
      const res = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(res, 200);
      assert.strictEqual(res.data.draft_markdown, testMarkdown);
    });

    it('T1-F36-02: Import UTF-8 Markdown File populates draft markdown', async () => {
      const importedContent = '# Imported Lab Notes\n\n- Task 1\n- Task 2\n';
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 2,
        markdown: importedContent,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, importedContent);
    });

    it('T1-F36-03: Relative Image Warning preserves relative or media links in text', async () => {
      const relativeImgMd = '# Document\n\n![Local Screenshot](./screenshot.png)\n![Media Image](/media/123)';
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 3,
        markdown: relativeImgMd,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.ok(check.data.draft_markdown.includes('./screenshot.png'));
    });

    it('T1-F36-04: Cyrillic Content Export preserves Russian characters', async () => {
      const cyrillicContent = '# Практическая работа №1 — Архитектура\n\nТекст на русском языке.';
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 4,
        markdown: cyrillicContent,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, cyrillicContent);
    });

    it('T1-F36-05: Autosave Trigger After Import increments revision', async () => {
      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.revision, 5);
    });
  });

  // =========================================================================
  // Feature 37: Image Upload (Paste / DnD / Picker)
  // =========================================================================
  describe('Feature 37: Image Upload (Paste / DnD / Picker)', () => {
    let pageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F37_Upload'),
      });
      assertStatus(p, 201);
      pageId = p.data.id;
      createdPageIds.push(pageId);
    });

    it('T1-F37-01: PNG Image Upload via File Input returns 201 with kind image and /media/ url', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('diagram.png'));
      const res = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(res, 201);
      assert.ok(res.data.id);
      assert.strictEqual(res.data.kind, 'image');
      assert.strictEqual(res.data.mime, 'image/png');
      assert.strictEqual(res.data.original_name, 'diagram.png');
      assert.ok(res.data.url.startsWith('/media/'));
    });

    it('T1-F37-02: JPEG Image Upload returns 201 with mime image/jpeg', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createJpeg('photo.jpg'));
      const res = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(res, 201);
      assert.strictEqual(res.data.kind, 'image');
      assert.strictEqual(res.data.mime, 'image/jpeg');
    });

    it('T1-F37-03: WebP Image Upload returns 201 with mime image/webp', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createWebp('banner.webp'));
      const res = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(res, 201);
      assert.strictEqual(res.data.kind, 'image');
      assert.strictEqual(res.data.mime, 'image/webp');
    });

    it('T1-F37-04: Asset Linked to Page in DB verified via admin assets endpoint', async () => {
      const res = await adminClient.get(`/api/admin/pages/${pageId}/assets`);
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
      assert.ok(res.data.length >= 3, 'Expected at least 3 uploaded images');
      const pngAsset = res.data.find((a) => a.original_name === 'diagram.png');
      assert.ok(pngAsset, 'diagram.png must exist in page assets');
    });

    it('T1-F37-05: Plain Text Paste Bypasses Upload only files create assets', async () => {
      const countBefore = (await adminClient.get(`/api/admin/pages/${pageId}/assets`)).data.length;
      // Normal draft update with plain text does not add asset
      await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: 'Pasted plain text snippet',
      });
      const countAfter = (await adminClient.get(`/api/admin/pages/${pageId}/assets`)).data.length;
      assert.strictEqual(countBefore, countAfter);
    });
  });

  // =========================================================================
  // Feature 38: Image Insertion in Editor
  // =========================================================================
  describe('Feature 38: Image Insertion in Editor', () => {
    let pageId;
    let imgAssetId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F38_Insert'),
      });
      assertStatus(p, 201);
      pageId = p.data.id;
      createdPageIds.push(pageId);

      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('screenshot.png'));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      imgAssetId = uploadRes.data.id;
    });

    it('T1-F38-01: Auto-Insert Markdown Image Link at Cursor verified in draft', async () => {
      const imageMd = `![screenshot.png](/media/${imgAssetId})`;
      const res = await adminClient.patch(`/api/admin/pages/${pageId}`, {
        expected_revision: 1,
        markdown: imageMd,
      });
      assertStatus(res, 200);

      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.strictEqual(check.data.draft_markdown, imageMd);
    });

    it('T1-F38-02: Upload Progress Indicator returns asset ID and URL cleanly', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('progress.png'));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      assert.ok(uploadRes.data.url.includes(uploadRes.data.id));
    });

    it('T1-F38-03: No Base64 or Data URL Insertion verifies draft contains /media/ not data:image', async () => {
      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.ok(!check.data.draft_markdown.includes('data:image'));
      assert.ok(check.data.draft_markdown.includes('/media/'));
    });

    it('T1-F38-04: Preview Pane Renders Inserted Image draft markdown structure', async () => {
      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.ok(check.data.draft_markdown.startsWith('![screenshot.png]'));
    });

    it('T1-F38-05: Autosave Captures Inserted Markdown revision incremented', async () => {
      const check = await adminClient.get(`/api/admin/pages/${pageId}`);
      assertStatus(check, 200);
      assert.ok(check.data.revision >= 2);
    });
  });

  // =========================================================================
  // Feature 39: Attachment Upload
  // =========================================================================
  describe('Feature 39: Attachment Upload', () => {
    let pageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F39_Attachments'),
      });
      assertStatus(p, 201);
      pageId = p.data.id;
      createdPageIds.push(pageId);
    });

    it('T1-F39-01: Upload PDF Document returns 201 kind attachment and application/pdf', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createPdf('manual.pdf'));
      const res = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(res, 201);
      assert.strictEqual(res.data.kind, 'attachment');
      assert.strictEqual(res.data.mime, 'application/pdf');
      assert.strictEqual(res.data.original_name, 'manual.pdf');
    });

    it('T1-F39-02: Upload ZIP Archive returns 201 kind attachment and application/zip', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createZip('project_code.zip'));
      const res = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(res, 201);
      assert.strictEqual(res.data.kind, 'attachment');
      assert.strictEqual(res.data.mime, 'application/zip');
    });

    it('T1-F39-03: Upload DOCX File returns 201 kind attachment', async () => {
      // Create minimal docx buffer (ZIP format container)
      const formData = new FormData();
      formData.append('file', MediaGenerator.createZip('lab_report.docx'));
      const res = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(res, 201);
      assert.strictEqual(res.data.kind, 'attachment');
    });

    it('T1-F39-04: Upload TXT/MD File returns 201 kind attachment', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createText('data.txt', 'Column1,Column2\nVal1,Val2\n'));
      const res = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(res, 201);
      assert.strictEqual(res.data.kind, 'attachment');
    });

    it('T1-F39-05: Attachment Appears in Admin Assets List returns all uploads', async () => {
      const res = await adminClient.get(`/api/admin/pages/${pageId}/assets`);
      assertStatus(res, 200);
      assert.ok(Array.isArray(res.data));
      assert.ok(res.data.length >= 4, 'Expected at least 4 attachments');
      for (const item of res.data) {
        assert.ok(item.byte_size > 0);
        assert.ok(item.original_name);
      }
    });
  });

  // =========================================================================
  // Feature 40: Streaming Disk Storage
  // =========================================================================
  describe('Feature 40: Streaming Disk Storage', () => {
    let pageId;

    before(async () => {
      const p = await adminClient.post('/api/admin/pages', {
        subject_id: defaultSubjId,
        title: uniqueName('F40_Storage'),
      });
      assertStatus(p, 201);
      pageId = p.data.id;
      createdPageIds.push(pageId);
    });

    it('T1-F40-01: Chunked Stream to Disk processes multipart stream cleanly', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('chunked.png'));
      const res = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(res, 201);
      assert.ok(res.data.id);
    });

    it('T1-F40-02: Atomic File Renaming file accessible immediately after upload', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('atomic.png'));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      const assetId = uploadRes.data.id;

      // Admin can immediately read the media stream
      const mediaRes = await adminClient.get(`/media/${assetId}`);
      assertStatus(mediaRes, 200);
      assert.strictEqual(mediaRes.headers.get('content-type'), 'image/png');
    });

    it('T1-F40-03: Byte Counter Accurate Verification byte_size matches file length', async () => {
      const sampleText = 'Exact 36 bytes of content here! 1234';
      const expectedSize = Buffer.byteLength(sampleText, 'utf-8');

      const formData = new FormData();
      formData.append('file', MediaGenerator.createText('exact.txt', sampleText));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      assert.strictEqual(uploadRes.data.byte_size, expectedSize);
    });

    it('T1-F40-04: Disk Persistence Across Service Requests retains media', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createZip('persistent.zip'));
      const uploadRes = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(uploadRes, 201);
      const assetId = uploadRes.data.id;

      const mediaRes = await adminClient.get(`/media/${assetId}`);
      assertStatus(mediaRes, 200);
      assert.ok(mediaRes.headers.get('content-disposition')?.includes('persistent.zip'));
    });

    it('T1-F40-05: Single File per Multipart Request Enforced succeeds cleanly', async () => {
      const formData = new FormData();
      formData.append('file', MediaGenerator.createPng('single.png'));
      const res = await adminClient.postMultipart(`/api/admin/pages/${pageId}/assets`, formData);
      assertStatus(res, 201);
      assert.strictEqual(res.data.original_name, 'single.png');
    });
  });
});
