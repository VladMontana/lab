<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { router } from '../lib/router';
  import {
    api,
    type AdminPageDetail,
    type SubjectResponse,
    type AssetResponse,
    ApiClientError,
  } from '../lib/api';
  import { toast } from '../lib/toast';
  import Modal from '../components/Modal.svelte';
  import AdminAssetTray from '../components/AdminAssetTray.svelte';
  import { convertDocxToMarkdown, type DocxConvertResult } from '../lib/docx';

  interface Props {
    pageId?: string;
    isNew?: boolean;
  }

  let { pageId = '', isNew = false }: Props = $props();

  // Page Data
  let page = $state<AdminPageDetail | null>(null);
  let subjects = $state<SubjectResponse[]>([]);
  let assets = $state<AssetResponse[]>([]);
  let selectedAttachmentIds = $state<string[]>([]);
  let isLoadingPage = $state(true);
  let loadError = $state<string | null>(null);

  // Editor Inputs
  let title = $state('');
  let subjectId = $state('');
  let markdown = $state('');
  let revision = $state(1);
  let isPublished = $state(false);
  let publishedRevision = $state<number | null>(null);
  let publishedAt = $state<string | null>(null);

  // Autosave & Concurrency State Machine
  // 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
  let saveStatus = $state<'saved' | 'dirty' | 'saving' | 'error' | 'conflict'>('saved');
  let saveErrorMessage = $state<string | null>(null);
  let inFlight = false;
  let pendingSaveAfterInFlight = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // LocalStorage Keys
  const draftKey = $derived(`labnotes_draft_${pageId}`);
  const conflictKey = $derived(`labnotes_conflict_page_${pageId}`);

  // Draft Recovery Banner
  let recoveredDraft = $state<{
    title: string;
    markdown: string;
    timestamp: number;
  } | null>(null);
  let showRecoveryBanner = $state(false);

  // Modals
  let conflictModalOpen = $state(false);
  let unpublishModalOpen = $state(false);
  let importModalOpen = $state(false);
  let isUnpublishing = $state(false);
  let isPublishing = $state(false);
  let pendingImportText = $state<string | null>(null);
  let fileInputImportEl: HTMLInputElement | null = null;

  // DOCX Import State
  let docxModalOpen = $state(false);
  let isConvertingDocx = $state(false);
  let pendingDocxResult = $state<DocxConvertResult | null>(null);
  let docxImportMode = $state<'replace' | 'append'>('replace');
  let applyExtractedTitle = $state(true);
  let docxFileName = $state('');
  let fileInputDocxEl: HTMLInputElement | null = null;

  // Dynamic Editor Component Reference
  let editorInstance = $state<any>(null);
  let importEditorPromise = $state<Promise<any> | null>(null);

  function loadCodeMirrorEditor() {
    importEditorPromise = import('../components/CodeMirrorEditor.svelte');
    return importEditorPromise;
  }

  onMount(() => {
    // 1. Kick off CodeMirror chunk download
    loadCodeMirrorEditor();

    // 2. Fetch page and subjects
    initPage();

    // 3. Register navigation guard for internal SPA routing
    const unregisterGuard = router.registerGuard((toUrl) => {
      if (saveStatus === 'dirty' || saveStatus === 'saving' || saveStatus === 'conflict') {
        return window.confirm(
          'У вас есть несохранённые изменения. Вы действительно хотите покинуть страницу?'
        );
      }
      return true;
    });

    // 4. Window beforeunload guard (tab close, refresh, browser back)
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveStatus === 'dirty' || saveStatus === 'saving' || saveStatus === 'conflict') {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      unregisterGuard();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  async function initPage() {
    isLoadingPage = true;
    loadError = null;
    try {
      // Load subjects for selector
      subjects = await api.getAdminSubjects();

      if (isNew) {
        // Create new draft immediately with default subject
        const defaultSubj = subjects[0]?.id || '';
        const created = await api.createAdminPage({
          title: 'Новая практическая работа',
          subject_id: defaultSubj,
        });
        // Transition URL without re-mounting
        window.history.replaceState({}, '', `/admin/pages/${created.id}/edit`);
        pageId = created.id;
        applyPageData(created);
      } else {
        const fetched = await api.getAdminPage(pageId);
        applyPageData(fetched);
      }

      // Load assets
      if (pageId) {
        assets = await api.getAdminPageAssets(pageId);
      }

      // Check LocalStorage for uncommitted drafts
      checkLocalStorageRecovery();
    } catch (err: any) {
      if (err instanceof ApiClientError && err.isUnauthorized()) {
        router.navigate('/admin/login');
        return;
      }
      loadError = err.message || 'Ошибка загрузки страницы';
    } finally {
      isLoadingPage = false;
    }
  }

  function applyPageData(data: AdminPageDetail) {
    page = data;
    title = data.draft_title;
    subjectId = data.draft_subject_id;
    markdown = data.draft_markdown;
    revision = data.revision;
    isPublished = data.is_published;
    publishedRevision = data.published_revision;
    publishedAt = data.published_at;
    saveStatus = 'saved';
  }

  function checkLocalStorageRecovery() {
    try {
      const cachedConflict = localStorage.getItem(conflictKey);
      const cachedDraft = localStorage.getItem(draftKey);
      const raw = cachedConflict || cachedDraft;
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (
        parsed &&
        (parsed.markdown !== markdown || (parsed.title && parsed.title !== title))
      ) {
        recoveredDraft = parsed;
        showRecoveryBanner = true;
      }
    } catch {
      // Ignore JSON parse or storage quota errors
    }
  }

  function acceptRecovery() {
    if (!recoveredDraft) return;
    title = recoveredDraft.title || title;
    markdown = recoveredDraft.markdown || markdown;
    showRecoveryBanner = false;
    recoveredDraft = null;
    markDirty();
    toast.info('Черновик восстановлен из локального хранилища');
  }

  function discardRecovery() {
    try {
      localStorage.removeItem(conflictKey);
      localStorage.removeItem(draftKey);
    } catch {}
    showRecoveryBanner = false;
    recoveredDraft = null;
    toast.info('Локальный черновик отклонён');
  }

  // Dirty State & Autosave Scheduling
  function markDirty() {
    if (saveStatus !== 'saving') {
      saveStatus = 'dirty';
    }

    // Save to LocalStorage immediately
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({
          pageId,
          title,
          subjectId,
          markdown,
          revision,
          timestamp: Date.now(),
        })
      );
    } catch {
      // LocalStorage quota warning suppressed
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      triggerSave();
    }, 1000); // 1000ms debounce
  }

  function handleTitleChange(newTitle: string) {
    title = newTitle;
    markDirty();
  }

  function handleSubjectChange(newSubjectId: string) {
    subjectId = newSubjectId;
    markDirty();
  }

  function handleMarkdownChange(newMarkdown: string) {
    markdown = newMarkdown;
    markDirty();
  }

  // In-flight serialized save execution
  async function triggerSave(forceImmediate = false) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (!pageId) return;

    if (inFlight) {
      pendingSaveAfterInFlight = true;
      return;
    }

    inFlight = true;
    saveStatus = 'saving';
    saveErrorMessage = null;

    try {
      const res = await api.updateAdminPage(pageId, {
        expected_revision: revision,
        title: title.trim() || 'Без названия',
        subject_id: subjectId,
        markdown: markdown,
      });

      revision = res.revision;
      inFlight = false;

      if (pendingSaveAfterInFlight) {
        pendingSaveAfterInFlight = false;
        triggerSave();
      } else {
        saveStatus = 'saved';
        try {
          localStorage.removeItem(draftKey);
        } catch {}
      }
    } catch (err: any) {
      inFlight = false;
      pendingSaveAfterInFlight = false;

      if (err instanceof ApiClientError && (err.status === 409 || err.isRevisionConflict())) {
        saveStatus = 'conflict';
        // Immediately persist conflict draft
        try {
          localStorage.setItem(
            conflictKey,
            JSON.stringify({
              pageId,
              title,
              subjectId,
              markdown,
              expectedRevision: revision,
              timestamp: Date.now(),
            })
          );
        } catch {}
        conflictModalOpen = true;
      } else {
        saveStatus = 'error';
        saveErrorMessage = err.message || 'Ошибка сохранения';
      }
    }
  }

  // 409 Conflict Resolution Options
  async function resolveConflictReloadServer() {
    try {
      const serverPage = await api.getAdminPage(pageId);
      applyPageData(serverPage);
      try {
        localStorage.removeItem(conflictKey);
        localStorage.removeItem(draftKey);
      } catch {}
      conflictModalOpen = false;
      saveStatus = 'saved';
      toast.info('Загружена актуальная версия с сервера');
    } catch (err: any) {
      toast.error('Не удалось обновить страницу с сервера');
    }
  }

  async function resolveConflictForceSaveMyVersion() {
    try {
      // 1. Fetch current server revision
      const serverPage = await api.getAdminPage(pageId);
      // 2. Overwrite with latest expected_revision
      const res = await api.updateAdminPage(pageId, {
        expected_revision: serverPage.revision,
        title: title.trim() || 'Без названия',
        subject_id: subjectId,
        markdown: markdown,
      });
      revision = res.revision;
      try {
        localStorage.removeItem(conflictKey);
        localStorage.removeItem(draftKey);
      } catch {}
      conflictModalOpen = false;
      saveStatus = 'saved';
      toast.success('Ваша версия успешно сохранена на сервере');
    } catch (err: any) {
      toast.error('Ошибка принудительного сохранения: ' + err.message);
    }
  }

  function downloadConflictBackup() {
    const filename = `draft-${pageId}-conflict.md`;
    downloadMarkdownFile(markdown, filename);
    toast.success('Резервная копия скачана на компьютер');
  }

  // Media & Asset Upload Pipeline
  async function handleEditorUploadImage(file: File) {
    if (!pageId) throw new Error('Страница не инициализирована');
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('Размер изображения превышает 10 МБ');
    }
    const uploaded = await api.uploadAdminPageAsset(pageId, file);
    assets = [...assets, uploaded];
    return {
      id: uploaded.id,
      url: uploaded.url,
      name: uploaded.original_name,
    };
  }

  async function handleAssetTrayUpload(file: File) {
    if (!pageId) throw new Error('Страница не инициализирована');
    const uploaded = await api.uploadAdminPageAsset(pageId, file);
    assets = [...assets, uploaded];
    return uploaded;
  }

  async function handleAssetTrayDelete(assetId: string) {
    if (!pageId) return;
    await api.deleteAdminPageAsset(pageId, assetId);
    assets = assets.filter((a) => a.id !== assetId);
    selectedAttachmentIds = selectedAttachmentIds.filter((id) => id !== assetId);
  }

  function handleInsertFromTray(snippet: string) {
    if (editorInstance && editorInstance.insertText) {
      editorInstance.insertText(snippet);
    } else {
      markdown += snippet;
      markDirty();
    }
  }

  // Publication Actions
  async function handlePublish() {
    if (!pageId) return;
    if (saveStatus === 'dirty') {
      await triggerSave();
    }

    isPublishing = true;
    try {
      const res = await api.publishAdminPage(pageId, {
        expected_revision: revision,
        attachment_ids: selectedAttachmentIds,
      });
      isPublished = true;
      publishedRevision = res.published_revision;
      publishedAt = res.published_at;
      toast.success('Страница успешно опубликована!');
    } catch (err: any) {
      if (err instanceof ApiClientError && (err.status === 409 || err.isRevisionConflict())) {
        saveStatus = 'conflict';
        conflictModalOpen = true;
      } else {
        toast.error(err.message || 'Ошибка публикации');
      }
    } finally {
      isPublishing = false;
    }
  }

  async function confirmUnpublish() {
    if (!pageId) return;
    isUnpublishing = true;
    try {
      await api.unpublishAdminPage(pageId);
      isPublished = false;
      publishedRevision = null;
      publishedAt = null;
      unpublishModalOpen = false;
      toast.success('Страница снята с публикации');
    } catch (err: any) {
      toast.error(err.message || 'Ошибка отмены публикации');
    } finally {
      isUnpublishing = false;
    }
  }

  async function handleCopyPublicLink() {
    if (!isPublished) return;
    const publicUrl = `${window.location.origin}/p/${pageId}`;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(publicUrl);
      } else {
        const el = document.createElement('textarea');
        el.value = publicUrl;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      toast.success('Ссылка скопирована в буфер обмена');
    } catch {
      toast.error('Не удалось скопировать ссылку');
    }
  }

  // Import / Export
  function handleExportMarkdown() {
    const filename = `${(title || 'lab-note').toLowerCase().replace(/[\/\\?%*:|"<>]/g, '_').trim()}.md`;
    downloadMarkdownFile(markdown, filename);
    toast.success('Файл .md экспортирован');
  }

  function downloadMarkdownFile(content: string, filename: string) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function handleTriggerImport() {
    fileInputImportEl?.click();
  }

  function handleImportFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const files = target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingImportText = e.target?.result as string;
      importModalOpen = true;
    };
    reader.readAsText(file, 'UTF-8');
    target.value = '';
  }

  function confirmImport() {
    if (pendingImportText !== null) {
      markdown = pendingImportText;
      pendingImportText = null;
      importModalOpen = false;
      markDirty();
      toast.success('Текст Markdown импортирован');
    }
  }

  function handleTriggerDocxImport() {
    fileInputDocxEl?.click();
  }

  async function handleDocxFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const files = target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    docxFileName = file.name;
    isConvertingDocx = true;

    try {
      const buffer = await file.arrayBuffer();

      const result = await convertDocxToMarkdown(buffer, {
        uploadImage: async (blob, filename, contentType) => {
          if (!pageId) return '';
          const imgFile = new File([blob], filename, { type: contentType });
          const uploaded = await api.uploadAdminPageAsset(pageId, imgFile);
          return uploaded.url;
        },
      });

      // Refresh assets list so newly uploaded images show up immediately in sidebar
      if (pageId && result.uploadedImagesCount > 0) {
        try {
          assets = await api.getAdminPageAssets(pageId);
        } catch {}
      }

      pendingDocxResult = result;
      docxModalOpen = true;
    } catch (err: any) {
      console.error('Ошибка конвертации DOCX:', err);
      toast.error('Не удалось прочитать файл DOCX: ' + (err.message || 'неверный формат'));
    } finally {
      isConvertingDocx = false;
      target.value = '';
    }
  }

  function confirmDocxImport() {
    if (!pendingDocxResult) return;

    if (applyExtractedTitle && pendingDocxResult.title) {
      if (!title || title === 'Новая практическая работа' || docxImportMode === 'replace') {
        title = pendingDocxResult.title;
      }
    }

    if (docxImportMode === 'replace') {
      markdown = pendingDocxResult.markdown;
    } else {
      markdown = markdown
        ? `${markdown}\n\n${pendingDocxResult.markdown}`
        : pendingDocxResult.markdown;
    }

    const imgMsg =
      pendingDocxResult.imageCount > 0
        ? ` (изображений: ${pendingDocxResult.imageCount})`
        : '';
    toast.success(`Документ Word успешно импортирован${imgMsg}!`);

    docxModalOpen = false;
    pendingDocxResult = null;
    markDirty();
  }
</script>

<div class="editor-page-container">
  <!-- Top Navigation & Breadcrumb -->
  <header class="editor-top-bar">
    <div class="bar-left">
      <a href="/admin/pages" class="back-link">
        ← Все работы
      </a>
      <span class="divider">/</span>

      <!-- Autosave Status Badge -->
      <div class="autosave-badge {saveStatus}" role="status" aria-live="polite">
        {#if saveStatus === 'saved'}
          <span class="status-icon">✓</span>
          <span>Все изменения сохранены</span>
        {:else if saveStatus === 'dirty'}
          <span class="status-dot">●</span>
          <span>Несохраненные изменения</span>
        {:else if saveStatus === 'saving'}
          <span class="status-spinner">⟳</span>
          <span>Сохранение...</span>
        {:else if saveStatus === 'error'}
          <span class="status-icon">⚠️</span>
          <span>Ошибка сохранения</span>
          <button type="button" class="retry-btn" onclick={() => triggerSave(true)}>
            Повторить
          </button>
        {:else if saveStatus === 'conflict'}
          <span class="status-icon">⚡</span>
          <span>Конфликт версий</span>
          <button type="button" class="retry-btn" onclick={() => (conflictModalOpen = true)}>
            Разрешить
          </button>
        {/if}
      </div>
    </div>

    <div class="bar-right">
      <!-- Import / Export Actions -->
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        title="Экспорт статьи в файл .md"
        onclick={handleExportMarkdown}
      >
        📥 Экспорт .md
      </button>

      <button
        type="button"
        class="btn btn-secondary btn-sm"
        title="Импорт статьи из файла .md"
        onclick={handleTriggerImport}
      >
        📤 Импорт .md
      </button>
      <input
        type="file"
        accept=".md,text/markdown"
        bind:this={fileInputImportEl}
        onchange={handleImportFileSelected}
        style="display: none;"
      />

      <button
        type="button"
        class="btn btn-secondary btn-sm"
        title="Импорт методички из документа Word (.docx)"
        disabled={isConvertingDocx}
        onclick={handleTriggerDocxImport}
      >
        {isConvertingDocx ? '⏳ Конвертация...' : '📄 Импорт .docx'}
      </button>
      <input
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        bind:this={fileInputDocxEl}
        onchange={handleDocxFileSelected}
        style="display: none;"
      />

      <!-- Public Link Button -->
      {#if isPublished}
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          title="Скопировать публичную ссылку на работу"
          onclick={handleCopyPublicLink}
        >
          🔗 Копировать ссылку
        </button>
        <a
          href="/p/{pageId}"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-secondary btn-sm"
          title="Открыть публичную версию в новой вкладке"
        >
          👁 Открыть
        </a>
        <button
          type="button"
          class="btn btn-danger btn-sm"
          title="Снять статью с публикации"
          onclick={() => (unpublishModalOpen = true)}
        >
          Снять с публикации
        </button>
      {/if}

      <!-- Publish Action -->
      <button
        type="button"
        class="btn btn-primary btn-sm"
        onclick={handlePublish}
        disabled={isPublishing}
      >
        {isPublishing
          ? 'Публикация...'
          : isPublished && revision > (publishedRevision || 0)
          ? 'Обновить публикацию'
          : isPublished
          ? 'Опубликовано'
          : 'Опубликовать'}
      </button>
    </div>
  </header>

  <!-- LocalStorage Recovery Banner -->
  {#if showRecoveryBanner}
    <div class="draft-recovery-banner" role="alert">
      <div class="banner-content">
        <span class="banner-icon">💡</span>
        <span>
          Обнаружен сохранённый локальный черновик
          {#if recoveredDraft?.timestamp}
            от {new Date(recoveredDraft.timestamp).toLocaleTimeString()}
          {/if}.
          Восстановить его или использовать серверную версию?
        </span>
      </div>
      <div class="banner-actions">
        <button type="button" class="btn btn-sm btn-primary" onclick={acceptRecovery}>
          Восстановить черновик
        </button>
        <button type="button" class="btn btn-sm btn-secondary" onclick={discardRecovery}>
          Отклонить
        </button>
      </div>
    </div>
  {/if}

  {#if isLoadingPage}
    <div class="page-loading-skeleton" role="status">
      <span class="spinner">⏳</span>
      <span>Загрузка практической работы...</span>
    </div>
  {:else if loadError}
    <div class="page-load-error" role="alert">
      <p>❌ {loadError}</p>
      <button type="button" class="btn btn-secondary" onclick={initPage}>
        Повторить попытку
      </button>
    </div>
  {:else}
    <!-- Page Header: Title, Subject & Status Badges -->
    <section class="page-meta-header">
      <div class="title-input-wrapper">
        <input
          type="text"
          class="title-input"
          placeholder="Название практической работы..."
          value={title}
          oninput={(e) => handleTitleChange((e.target as HTMLInputElement).value)}
          maxlength="200"
          aria-label="Название практической работы"
        />
      </div>

      <div class="meta-row">
        <!-- Subject Selector -->
        <div class="meta-item">
          <label for="subject-select" class="meta-label">Предмет:</label>
          <select
            id="subject-select"
            class="subject-select"
            value={subjectId}
            onchange={(e) => handleSubjectChange((e.target as HTMLSelectElement).value)}
          >
            {#each subjects as subj}
              <option value={subj.id}>{subj.name}</option>
            {/each}
          </select>
        </div>

        <!-- Status Badges -->
        <div class="meta-item badges-group">
          {#if isPublished && revision === publishedRevision}
            <span class="badge badge-published" title="Опубликовано: {publishedAt || ''}">
              ✓ Опубликовано
            </span>
          {:else if isPublished && revision > (publishedRevision || 0)}
            <span
              class="badge badge-modified"
              title="Черновик: рев. {revision} | Опубликовано: рев. {publishedRevision}"
            >
              Есть неопубликованные изменения
            </span>
          {:else}
            <span class="badge badge-draft">
              Черновик
            </span>
          {/if}
          <span class="revision-indicator" title="Текущая ревизия черновика">
            рев. {revision}
          </span>
        </div>
      </div>
    </section>

    <!-- Dynamic CodeMirror Editor Container -->
    <div class="editor-main-container">
      {#await importEditorPromise}
        <div class="editor-loading-spinner" role="status" aria-live="polite">
          <span class="spinner-icon">⏳</span>
          <span>Загрузка редактора CodeMirror 6...</span>
        </div>
      {:then { default: CodeMirrorEditor }}
        <CodeMirrorEditor
          bind:this={editorInstance}
          value={markdown}
          onchange={handleMarkdownChange}
          onsave={() => triggerSave(true)}
          onuploadimage={handleEditorUploadImage}
        />
      {:catch error}
        <div class="editor-error-state" role="alert">
          <p>Не удалось загрузить редактор: {error.message}</p>
          <button type="button" class="btn btn-secondary" onclick={loadCodeMirrorEditor}>
            Повторить попытку
          </button>
        </div>
      {/await}
    </div>

    <!-- Asset Manager Tray -->
    <div class="editor-asset-tray-wrapper">
      <AdminAssetTray
        {pageId}
        {assets}
        {selectedAttachmentIds}
        oninsert={handleInsertFromTray}
        onupload={handleAssetTrayUpload}
        ondelete={handleAssetTrayDelete}
        onselectionchange={(ids) => (selectedAttachmentIds = ids)}
      />
    </div>
  {/if}
</div>

<!-- Conflict Resolution Modal (HTTP 409) -->
<Modal
  open={conflictModalOpen}
  title="Обнаружен конфликт версий"
  onclose={() => (conflictModalOpen = false)}
>
  <p>
    Эта страница была изменена в другом окне или на сервере. Чтобы не потерять ваши данные,
    выберите действие:
  </p>
  <div class="conflict-modal-options">
    <div class="conflict-option">
      <strong>1. Перезаписать изменениями с сервера:</strong>
      <p>Локальные изменения будут заменены версией с сервера.</p>
    </div>
    <div class="conflict-option">
      <strong>2. Принудительно сохранить мою версию:</strong>
      <p>Серверная версия будет перезаписана текстом из вашего редактора.</p>
    </div>
    <div class="conflict-option">
      <strong>3. Скачать мою версию:</strong>
      <p>Сохраните локальный файл на диск перед принятием решения.</p>
    </div>
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={downloadConflictBackup}
    >
      💾 Скачать мою версию (.md)
    </button>
    <button
      type="button"
      class="btn btn-secondary"
      onclick={resolveConflictReloadServer}
    >
      Перезаписать с сервера
    </button>
    <button
      type="button"
      class="btn btn-primary"
      onclick={resolveConflictForceSaveMyVersion}
    >
      Принудительно сохранить мою версию
    </button>
  {/snippet}
</Modal>

<!-- Unpublish Confirmation Modal -->
<Modal
  open={unpublishModalOpen}
  title="Снять страницу с публикации?"
  onclose={() => (unpublishModalOpen = false)}
>
  <p>
    Публичный доступ к статье <strong>«{title}»</strong> и её вложениям будет немедленно закрыт.
  </p>
  <p class="modal-warning-subtext">
    Черновик останется доступным вам в панели автора, но студенты не смогут открывать ссылку.
  </p>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (unpublishModalOpen = false)}
      disabled={isUnpublishing}
    >
      Отмена
    </button>
    <button
      type="button"
      class="btn btn-danger"
      onclick={confirmUnpublish}
      disabled={isUnpublishing}
    >
      {isUnpublishing ? 'Снятие...' : 'Снять с публикации'}
    </button>
  {/snippet}
</Modal>

<!-- Markdown Import Disclaimer Modal (AGENT_PLAN.md:65) -->
<Modal
  open={importModalOpen}
  title="Импорт файла Markdown"
  onclose={() => (importModalOpen = false)}
>
  <p>
    Импорт файла заменит текущий текст статьи в редакторе.
  </p>
  <div class="import-disclaimer" role="note">
    ℹ️ <strong>Внимание:</strong> локальные изображения по относительным путям (например, <code>![схема](./image.png)</code>)
    не импортируются автоматически. Пожалуйста, загрузите изображения отдельно через перетаскивание или панель вложений.
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (importModalOpen = false)}
    >
      Отмена
    </button>
    <button
      type="button"
      class="btn btn-primary"
      onclick={confirmImport}
    >
      Заменить текст
    </button>
  {/snippet}
</Modal>

<!-- Word / DOCX Import Modal -->
<Modal
  open={docxModalOpen}
  title="Импорт документа Word (.docx)"
  onclose={() => (docxModalOpen = false)}
>
  {#if pendingDocxResult}
    <div class="docx-dialog">
      <div class="docx-meta-card">
        <div class="docx-meta-row">
          <span class="meta-label">Файл:</span>
          <span class="meta-value font-mono">{docxFileName}</span>
        </div>
        {#if pendingDocxResult.title}
          <div class="docx-meta-row">
            <span class="meta-label">Заголовок:</span>
            <span class="meta-value"><strong>{pendingDocxResult.title}</strong></span>
          </div>
        {/if}
        <div class="docx-meta-row">
          <span class="meta-label">Изображения:</span>
          <span class="meta-value">
            {pendingDocxResult.imageCount > 0 ? `Найдено ${pendingDocxResult.imageCount}` : 'Без изображений'}
            {#if pendingDocxResult.uploadedImagesCount > 0}
              <span class="badge-success"> (загружено на сервер: {pendingDocxResult.uploadedImagesCount})</span>
            {/if}
          </span>
        </div>
      </div>

      {#if pendingDocxResult.title}
        <label class="docx-checkbox-row">
          <input
            type="checkbox"
            bind:checked={applyExtractedTitle}
          />
          <span>Использовать заголовок из документа как название работы: <em>«{pendingDocxResult.title}»</em></span>
        </label>
      {/if}

      <div class="docx-action-section">
        <span class="section-title">Куда вставить текст:</span>
        <div class="docx-radio-group">
          <label class="docx-radio-option">
            <input
              type="radio"
              name="docx-import-mode"
              value="replace"
              bind:group={docxImportMode}
            />
            <div>
              <strong>Заменить текущий текст</strong>
              <p>Текущее содержимое редактора будет полностью заменено текстом из файла Word</p>
            </div>
          </label>
          <label class="docx-radio-option">
            <input
              type="radio"
              name="docx-import-mode"
              value="append"
              bind:group={docxImportMode}
            />
            <div>
              <strong>Добавить в конец</strong>
              <p>Текст документа будет добавлен после текущего содержимого статьи</p>
            </div>
          </label>
        </div>
      </div>

      <div class="docx-preview-box">
        <div class="preview-title">Предпросмотр полученного Markdown:</div>
        <pre class="preview-content"><code>{pendingDocxResult.markdown.slice(0, 800)}{pendingDocxResult.markdown.length > 800 ? '\n\n... [остальной текст обрезан в окне предпросмотра]' : ''}</code></pre>
      </div>

      {#if pendingDocxResult.warnings.length > 0}
        <div class="docx-warnings-note">
          <small>ℹ️ Примечание: {pendingDocxResult.warnings.slice(0, 3).join(', ')}</small>
        </div>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (docxModalOpen = false)}
    >
      Отмена
    </button>
    <button
      type="button"
      class="btn btn-primary"
      onclick={confirmDocxImport}
    >
      Импортировать в редактор
    </button>
  {/snippet}
</Modal>

<style>
  .editor-page-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 1300px;
    margin: 0 auto;
    padding: 20px 24px 60px;
  }

  .editor-top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .bar-left,
  .bar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .back-link {
    color: var(--text-muted, #787774);
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
  }

  .back-link:hover {
    color: var(--text-primary, #37352f);
  }

  .divider {
    color: var(--border-color, #e0e0e0);
  }

  .autosave-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 4px;
    background: var(--bg-secondary, #f7f6f3);
    color: var(--text-muted, #787774);
  }

  .autosave-badge.saved {
    color: #198754;
  }

  .autosave-badge.dirty {
    color: #d97706;
  }

  .autosave-badge.saving {
    color: var(--accent-color, #2383e2);
  }

  .autosave-badge.error,
  .autosave-badge.conflict {
    background: #fce8e6;
    color: #c5221f;
  }

  .status-spinner {
    display: inline-block;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .retry-btn {
    background: transparent;
    border: 1px solid currentColor;
    color: inherit;
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 3px;
    cursor: pointer;
  }

  .draft-recovery-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    padding: 10px 16px;
    background: #fff8e1;
    border: 1px solid #ffe082;
    border-radius: 6px;
    font-size: 13px;
    color: #795548;
  }

  .banner-content {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .banner-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .page-loading-skeleton,
  .page-load-error {
    padding: 60px 20px;
    text-align: center;
    background: var(--bg-secondary, #f7f6f3);
    border-radius: 8px;
    color: var(--text-muted, #787774);
  }

  .page-meta-header {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .title-input-wrapper {
    width: 100%;
  }

  .title-input {
    width: 100%;
    font-size: 28px;
    font-weight: 700;
    border: none;
    border-bottom: 1px solid transparent;
    padding: 6px 0;
    background: transparent;
    color: var(--text-primary, #37352f);
    outline: none;
    transition: border-color 0.15s ease;
  }

  .title-input:focus {
    border-bottom-color: var(--border-color, #e0e0e0);
  }

  .meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }

  .meta-label {
    color: var(--text-muted, #787774);
  }

  .subject-select {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border-color, #e0e0e0);
    background: var(--bg-primary, #ffffff);
    color: var(--text-primary, #37352f);
    font-size: 13px;
  }

  .badges-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .badge {
    padding: 3px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
  }

  .badge-published {
    background: #d1e7dd;
    color: #0f5132;
  }

  .badge-modified {
    background: #fff3cd;
    color: #664d03;
  }

  .badge-draft {
    background: #e2e3e5;
    color: #41464b;
  }

  .revision-indicator {
    color: var(--text-muted, #787774);
    font-size: 11px;
  }

  .editor-main-container {
    min-height: 550px;
    display: flex;
    flex-direction: column;
  }

  .editor-loading-spinner {
    min-height: 400px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: var(--bg-secondary, #f7f6f3);
    border-radius: 8px;
    color: var(--text-muted, #787774);
    font-size: 14px;
  }

  .editor-error-state {
    padding: 40px 20px;
    text-align: center;
    background: #fce8e6;
    color: #c5221f;
    border-radius: 8px;
  }

  .editor-asset-tray-wrapper {
    margin-top: -16px;
  }

  .conflict-modal-options {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 16px 0;
  }

  .conflict-option {
    background: #f7f6f3;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 13px;
  }

  .conflict-option p {
    margin: 4px 0 0;
    color: #787774;
  }

  .import-disclaimer {
    margin-top: 12px;
    padding: 10px 12px;
    background: #e8f4fd;
    border: 1px solid #d2e3fc;
    border-radius: 6px;
    font-size: 13px;
    color: #0d47a1;
    line-height: 1.4;
  }

  .import-disclaimer code {
    background: rgba(0, 0, 0, 0.05);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    text-decoration: none;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .btn-sm {
    padding: 4px 8px;
    font-size: 12px;
  }

  .btn-primary {
    background: var(--accent-color, #2383e2);
    color: #ffffff;
  }

  .btn-primary:hover {
    background: #1b6fc1;
  }

  .btn-secondary {
    background: #ffffff;
    border-color: var(--border-color, #e0e0e0);
    color: var(--text-primary, #37352f);
  }

  .btn-secondary:hover {
    background: #f7f6f3;
  }

  .btn-danger {
    background: #c5221f;
    color: #ffffff;
  }

  .btn-danger:hover {
    background: #a51d1a;
  }

  /* DOCX Import Dialog Styles */
  .docx-dialog {
    display: flex;
    flex-direction: column;
    gap: 14px;
    font-size: 14px;
    color: #37352f;
  }

  .docx-meta-card {
    background: #f7f6f3;
    border: 1px solid #ebe9e4;
    border-radius: 6px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .docx-meta-row {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 13px;
  }

  .docx-meta-row .meta-label {
    color: #787774;
    min-width: 90px;
    font-weight: 500;
  }

  .font-mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
  }

  .badge-success {
    color: #0f7b6c;
    font-weight: 500;
  }

  .docx-checkbox-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
    line-height: 1.4;
  }

  .docx-checkbox-row input {
    margin-top: 2px;
  }

  .docx-action-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .docx-action-section .section-title {
    font-size: 13px;
    font-weight: 600;
    color: #37352f;
  }

  .docx-radio-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .docx-radio-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 12px;
    border: 1px solid #e9e8e5;
    border-radius: 6px;
    cursor: pointer;
    background: #ffffff;
    transition: background 0.15s, border-color 0.15s;
  }

  .docx-radio-option:hover {
    background: #fbfbfa;
    border-color: #d3d1cb;
  }

  .docx-radio-option input {
    margin-top: 3px;
  }

  .docx-radio-option strong {
    font-size: 13px;
    display: block;
    color: #37352f;
  }

  .docx-radio-option p {
    margin: 2px 0 0;
    font-size: 12px;
    color: #787774;
  }

  .docx-preview-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .docx-preview-box .preview-title {
    font-size: 12px;
    font-weight: 600;
    color: #787774;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .docx-preview-box .preview-content {
    margin: 0;
    padding: 10px 12px;
    background: #f7f6f3;
    border: 1px solid #e9e8e5;
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    max-height: 160px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: #37352f;
  }

  .docx-warnings-note {
    font-size: 12px;
    color: #d9730d;
  }
</style>
