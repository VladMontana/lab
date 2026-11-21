<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from '../lib/router';
  import { auth, subjects as subjectsStore } from '../lib/stores';
  import {
    api,
    type AdminPageListItem,
    type SubjectResponse,
    ApiClientError,
  } from '../lib/api';
  import { toast } from '../lib/toast';
  import Modal from '../components/Modal.svelte';

  // State
  let activeTab = $state<'pages' | 'subjects'>('pages');
  let isLoading = $state(true);

  // Pages state
  let pages = $state<AdminPageListItem[]>([]);
  let subjects = $state<SubjectResponse[]>([]);
  let selectedSubjectFilter = $state<string>('all');
  let selectedStatusFilter = $state<'all' | 'published' | 'draft' | 'modified'>('all');
  let searchQuery = $state('');

  // Modals state
  let newPageModalOpen = $state(false);
  let newPageTitle = $state('');
  let newPageSubjectId = $state('');
  let isCreatingPage = $state(false);

  let deletePageModalOpen = $state(false);
  let pageToDelete = $state<AdminPageListItem | null>(null);
  let isDeletingPage = $state(false);

  // Subject management modals
  let newSubjectModalOpen = $state(false);
  let newSubjectName = $state('');
  let isCreatingSubject = $state(false);

  let editSubjectModalOpen = $state(false);
  let subjectToEdit = $state<SubjectResponse | null>(null);
  let editSubjectName = $state('');
  let isUpdatingSubject = $state(false);

  let deleteSubjectModalOpen = $state(false);
  let subjectToDelete = $state<SubjectResponse | null>(null);
  let deleteSubjectError = $state<string | null>(null);
  let isDeletingSubject = $state(false);

  onMount(async () => {
    // 1. Auth Guard: verify author session
    try {
      const me = await api.getMe();
      if (!me) {
        router.navigate('/admin/login');
        return;
      }
    } catch {
      router.navigate('/admin/login');
      return;
    }

    await loadData();
  });

  async function loadData() {
    isLoading = true;
    try {
      const [fetchedPages, fetchedSubjects] = await Promise.all([
        api.getAdminPages(),
        api.getAdminSubjects(),
      ]);
      pages = fetchedPages;
      subjects = fetchedSubjects;
      if (subjects.length > 0 && !newPageSubjectId) {
        newPageSubjectId = subjects[0].id;
      }
    } catch (err: any) {
      if (err instanceof ApiClientError && err.isUnauthorized()) {
        router.navigate('/admin/login');
        return;
      }
      toast.error('Ошибка загрузки данных: ' + err.message);
    } finally {
      isLoading = false;
    }
  }

  // Filtered pages computation
  let filteredPages = $derived.by(() => {
    return pages.filter((p) => {
      // Subject filter
      if (selectedSubjectFilter !== 'all' && p.draft_subject_id !== selectedSubjectFilter) {
        return false;
      }

      // Status filter
      if (selectedStatusFilter === 'published' && (!p.is_published || p.revision > (p.published_revision || 0))) {
        return false;
      }
      if (selectedStatusFilter === 'draft' && p.is_published) {
        return false;
      }
      if (selectedStatusFilter === 'modified' && (!p.is_published || p.revision <= (p.published_revision || 0))) {
        return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        return p.draft_title.toLowerCase().includes(q);
      }

      return true;
    });
  });

  function getSubjectName(subjectId: string): string {
    const subj = subjects.find((s) => s.id === subjectId);
    return subj ? subj.name : '—';
  }

  // Create Page Action
  async function handleCreatePage() {
    if (!newPageTitle.trim()) {
      toast.error('Введите название работы');
      return;
    }
    if (!newPageSubjectId) {
      toast.error('Выберите предмет');
      return;
    }

    isCreatingPage = true;
    try {
      const newPage = await api.createAdminPage({
        title: newPageTitle.trim(),
        subject_id: newPageSubjectId,
      });
      toast.success('Работа успешно создана');
      newPageModalOpen = false;
      newPageTitle = '';
      router.navigate(`/admin/pages/${newPage.id}/edit`);
    } catch (err: any) {
      toast.error(err.message || 'Ошибка создания работы');
    } finally {
      isCreatingPage = false;
    }
  }

  // Delete Page Cascade Action
  function promptDeletePage(pageItem: AdminPageListItem) {
    pageToDelete = pageItem;
    deletePageModalOpen = true;
  }

  async function confirmDeletePage() {
    if (!pageToDelete) return;
    isDeletingPage = true;
    try {
      await api.deleteAdminPage(pageToDelete.id);
      pages = pages.filter((p) => p.id !== pageToDelete?.id);
      toast.success(`Работа «${pageToDelete.draft_title}» удалена`);
      deletePageModalOpen = false;
      pageToDelete = null;
      // Refresh subjects count
      subjects = await api.getAdminSubjects();
    } catch (err: any) {
      toast.error(err.message || 'Ошибка удаления работы');
    } finally {
      isDeletingPage = false;
    }
  }

  // Create Subject Action
  async function handleCreateSubject() {
    if (!newSubjectName.trim()) {
      toast.error('Введите название предмета');
      return;
    }

    isCreatingSubject = true;
    try {
      const created = await api.createAdminSubject(newSubjectName.trim());
      toast.success('Предмет успешно создан');
      newSubjectName = '';
      newSubjectModalOpen = false;
      await loadData();
      subjectsStore.load();
      if (created?.id) {
        newPageSubjectId = created.id;
      }
    } catch (err: any) {
      toast.error(err.message || 'Ошибка создания предмета');
    } finally {
      isCreatingSubject = false;
    }
  }

  // Edit Subject Action
  function promptEditSubject(subj: SubjectResponse) {
    subjectToEdit = subj;
    editSubjectName = subj.name;
    editSubjectModalOpen = true;
  }

  async function handleUpdateSubject() {
    if (!subjectToEdit || !editSubjectName.trim()) return;

    isUpdatingSubject = true;
    try {
      await api.updateAdminSubject(subjectToEdit.id, {
        name: editSubjectName.trim(),
      });
      toast.success('Предмет переименован');
      editSubjectModalOpen = false;
      subjectToEdit = null;
      await loadData();
      subjectsStore.load();
    } catch (err: any) {
      toast.error(err.message || 'Ошибка переименования предмета');
    } finally {
      isUpdatingSubject = false;
    }
  }

  // Delete Subject Action with 409 check
  function promptDeleteSubject(subj: SubjectResponse) {
    subjectToDelete = subj;
    deleteSubjectError = null;
    if (subj.page_count > 0) {
      deleteSubjectError = `В этом предмете содержатся практические работы (${subj.page_count}). Сначала переместите или удалите работы из этого предмета.`;
    }
    deleteSubjectModalOpen = true;
  }

  async function confirmDeleteSubject() {
    if (!subjectToDelete) return;
    isDeletingSubject = true;
    try {
      await api.deleteAdminSubject(subjectToDelete.id);
      toast.success(`Предмет «${subjectToDelete.name}» удалён`);
      deleteSubjectModalOpen = false;
      subjectToDelete = null;
      await loadData();
      subjectsStore.load();
    } catch (err: any) {
      if (err instanceof ApiClientError && (err.status === 409 || err.code === 'SUBJECT_NOT_EMPTY')) {
        deleteSubjectError = 'Невозможно удалить предмет: в нём содержатся практические работы. Сначала переместите или удалите работы из этого предмета.';
      } else {
        toast.error(err.message || 'Ошибка удаления предмета');
      }
    } finally {
      isDeletingSubject = false;
    }
  }

  async function handleLogout() {
    await auth.logout();
    router.navigate('/admin/login');
  }
</script>

<div class="admin-dashboard-container">
  <!-- Dashboard Header -->
  <header class="dashboard-header">
    <div class="header-left">
      <h2>Панель преподавателя</h2>
      <span class="user-greeting">
        👤 {$auth.user?.username || 'admin'}
      </span>
    </div>

    <div class="header-right">
      <button
        type="button"
        class="btn btn-primary"
        onclick={() => (newPageModalOpen = true)}
      >
        + Новая работа
      </button>
      <button
        type="button"
        class="btn btn-secondary"
        onclick={handleLogout}
      >
        Выйти
      </button>
    </div>
  </header>

  <!-- Navigation Tabs -->
  <nav class="dashboard-tabs" aria-label="Разделы панели">
    <button
      type="button"
      class="tab-btn"
      class:active={activeTab === 'pages'}
      onclick={() => (activeTab = 'pages')}
    >
      📓 Практические работы ({pages.length})
    </button>
    <button
      type="button"
      class="tab-btn"
      class:active={activeTab === 'subjects'}
      onclick={() => (activeTab = 'subjects')}
    >
      📚 Предметы ({subjects.length})
    </button>
  </nav>

  {#if isLoading}
    <div class="loading-state" role="status">
      <span class="spinner">⏳</span>
      <span>Загрузка данных панели...</span>
    </div>
  {:else if activeTab === 'pages'}
    <!-- Pages Management Tab -->
    <section class="tab-content" aria-label="Список практических работ">
      <!-- Filters and Search Toolbar -->
      <div class="filter-toolbar">
        <div class="search-box">
          <input
            type="search"
            class="search-input"
            placeholder="Поиск по названию..."
            bind:value={searchQuery}
          />
        </div>

        <div class="filters-row">
          <div class="filter-item">
            <label for="subj-filter">Предмет:</label>
            <select id="subj-filter" class="select-control" bind:value={selectedSubjectFilter}>
              <option value="all">Все предметы</option>
              {#each subjects as subj}
                <option value={subj.id}>{subj.name}</option>
              {/each}
            </select>
          </div>

          <div class="filter-item">
            <label for="status-filter">Статус:</label>
            <select id="status-filter" class="select-control" bind:value={selectedStatusFilter}>
              <option value="all">Все статусы</option>
              <option value="published">Опубликованные</option>
              <option value="draft">Черновики</option>
              <option value="modified">Есть изменения</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Pages List -->
      {#if filteredPages.length === 0}
        <div class="empty-state">
          <p>Работы не найдены.</p>
          <button
            type="button"
            class="btn btn-primary"
            onclick={() => (newPageModalOpen = true)}
          >
            Создать первую работу
          </button>
        </div>
      {:else}
        <div class="pages-table-wrapper">
          <table class="pages-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Предмет</th>
                <th>Статус</th>
                <th>Ревизия</th>
                <th>Обновлено</th>
                <th class="actions-col">Действия</th>
              </tr>
            </thead>
            <tbody>
              {#each filteredPages as p (p.id)}
                <tr>
                  <td class="page-title-cell">
                    <a href="/admin/pages/{p.id}/edit" class="page-title-link">
                      {p.draft_title}
                    </a>
                  </td>
                  <td>
                    <span class="subject-tag">{getSubjectName(p.draft_subject_id)}</span>
                  </td>
                  <td>
                    {#if p.is_published && p.revision === p.published_revision}
                      <span class="badge badge-published">Опубликовано</span>
                    {:else if p.is_published && p.revision > (p.published_revision || 0)}
                      <span class="badge badge-modified">Есть изменения</span>
                    {:else}
                      <span class="badge badge-draft">Черновик</span>
                    {/if}
                  </td>
                  <td class="revision-cell">рев. {p.revision}</td>
                  <td class="date-cell">
                    {new Date(p.updated_at).toLocaleDateString()}
                  </td>
                  <td class="actions-cell">
                    <a
                      href="/admin/pages/{p.id}/edit"
                      class="action-btn edit"
                      title="Редактировать работу"
                    >
                      ✏️ Редактировать
                    </a>
                    {#if p.is_published}
                      <a
                        href="/p/{p.id}"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="action-btn view"
                        title="Просмотреть публичную версию"
                      >
                        👁 Открыть
                      </a>
                    {/if}
                    <button
                      type="button"
                      class="action-btn delete"
                      title="Удалить работу"
                      onclick={() => promptDeletePage(p)}
                    >
                      🗑️
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {:else if activeTab === 'subjects'}
    <!-- Subjects Management Tab -->
    <section class="tab-content" aria-label="Список предметов">
      <div class="subjects-header-row">
        <h3>Предметы и дисциплины</h3>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onclick={() => (newSubjectModalOpen = true)}
        >
          + Добавить предмет
        </button>
      </div>

      <div class="subjects-list">
        {#each subjects as subj (subj.id)}
          <div class="subject-card">
            <div class="subject-info">
              <span class="subject-name">{subj.name}</span>
              <span class="subject-count">
                {subj.page_count} {subj.page_count === 1 ? 'работа' : 'работ'}
              </span>
            </div>

            <div class="subject-actions">
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                onclick={() => promptEditSubject(subj)}
              >
                Переименовать
              </button>
              <button
                type="button"
                class="btn btn-danger btn-sm"
                onclick={() => promptDeleteSubject(subj)}
              >
                Удалить
              </button>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<!-- New Page Modal -->
<Modal
  open={newPageModalOpen}
  title="Создать практическую работу"
  onclose={() => (newPageModalOpen = false)}
>
  <form onsubmit={(e) => { e.preventDefault(); handleCreatePage(); }}>
    <div class="form-group">
      <label for="new-title">Название работы:</label>
      <input
        id="new-title"
        type="text"
        class="form-control"
        placeholder="Например: Лабораторная работа 1"
        bind:value={newPageTitle}
        maxlength="200"
        required
      />
    </div>

    <div class="form-group">
      <div class="field-header-row">
        <label for="new-subject">Предмет:</label>
        <button
          type="button"
          class="btn-text-action"
          onclick={() => {
            newPageModalOpen = false;
            newSubjectModalOpen = true;
          }}
        >
          + Создать новый предмет
        </button>
      </div>

      {#if subjects.length === 0}
        <div class="no-subjects-notice">
          <p>⚠️ У вас пока нет созданных предметов.</p>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            onclick={() => {
              newPageModalOpen = false;
              newSubjectModalOpen = true;
            }}
          >
            + Создать предмет
          </button>
        </div>
      {:else}
        <select id="new-subject" class="form-control" bind:value={newPageSubjectId} required>
          {#each subjects as subj}
            <option value={subj.id}>{subj.name}</option>
          {/each}
        </select>
      {/if}
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (newPageModalOpen = false)}
      disabled={isCreatingPage}
    >
      Отмена
    </button>
    <button
      type="button"
      class="btn btn-primary"
      onclick={handleCreatePage}
      disabled={isCreatingPage || !newPageTitle.trim()}
    >
      {isCreatingPage ? 'Создание...' : 'Создать работу'}
    </button>
  {/snippet}
</Modal>

<!-- Delete Page Modal -->
<Modal
  open={deletePageModalOpen}
  title="Удалить практическую работу?"
  onclose={() => (deletePageModalOpen = false)}
>
  <p>
    Вы действительно хотите удалить работу <strong>«{pageToDelete?.draft_title}»</strong>?
  </p>
  <div class="alert alert-danger">
    ⚠️ Будут безвозвратно удалены черновик работы, публичная версия и все прикреплённые к ней файлы.
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (deletePageModalOpen = false)}
      disabled={isDeletingPage}
    >
      Отмена
    </button>
    <button
      type="button"
      class="btn btn-danger"
      onclick={confirmDeletePage}
      disabled={isDeletingPage}
    >
      {isDeletingPage ? 'Удаление...' : 'Да, удалить'}
    </button>
  {/snippet}
</Modal>

<!-- New Subject Modal -->
<Modal
  open={newSubjectModalOpen}
  title="Добавить новый предмет"
  onclose={() => (newSubjectModalOpen = false)}
>
  <form onsubmit={(e) => { e.preventDefault(); handleCreateSubject(); }}>
    <div class="form-group">
      <label for="new-subj-name">Название предмета:</label>
      <input
        id="new-subj-name"
        type="text"
        class="form-control"
        placeholder="Например: Операционные системы"
        bind:value={newSubjectName}
        maxlength="100"
        required
      />
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (newSubjectModalOpen = false)}
      disabled={isCreatingSubject}
    >
      Отмена
    </button>
    <button
      type="button"
      class="btn btn-primary"
      onclick={handleCreateSubject}
      disabled={isCreatingSubject || !newSubjectName.trim()}
    >
      {isCreatingSubject ? 'Создание...' : 'Добавить'}
    </button>
  {/snippet}
</Modal>

<!-- Edit Subject Modal -->
<Modal
  open={editSubjectModalOpen}
  title="Переименовать предмет"
  onclose={() => (editSubjectModalOpen = false)}
>
  <form onsubmit={(e) => { e.preventDefault(); handleUpdateSubject(); }}>
    <div class="form-group">
      <label for="edit-subj-name">Название предмета:</label>
      <input
        id="edit-subj-name"
        type="text"
        class="form-control"
        bind:value={editSubjectName}
        maxlength="100"
        required
      />
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (editSubjectModalOpen = false)}
      disabled={isUpdatingSubject}
    >
      Отмена
    </button>
    <button
      type="button"
      class="btn btn-primary"
      onclick={handleUpdateSubject}
      disabled={isUpdatingSubject || !editSubjectName.trim()}
    >
      {isUpdatingSubject ? 'Сохранение...' : 'Сохранить'}
    </button>
  {/snippet}
</Modal>

<!-- Delete Subject Modal (Feature 19 & 409 friendly handling) -->
<Modal
  open={deleteSubjectModalOpen}
  title="Удаление предмета"
  onclose={() => (deleteSubjectModalOpen = false)}
>
  {#if deleteSubjectError}
    <div class="alert alert-warning" role="alert">
      ⚠️ {deleteSubjectError}
    </div>
  {:else}
    <p>
      Вы действительно хотите удалить предмет <strong>«{subjectToDelete?.name}»</strong>?
    </p>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (deleteSubjectModalOpen = false)}
      disabled={isDeletingSubject}
    >
      {deleteSubjectError ? 'Понятно' : 'Отмена'}
    </button>
    {#if !deleteSubjectError}
      <button
        type="button"
        class="btn btn-danger"
        onclick={confirmDeleteSubject}
        disabled={isDeletingSubject}
      >
        {isDeletingSubject ? 'Удаление...' : 'Удалить'}
      </button>
    {/if}
  {/snippet}
</Modal>

<style>
  .admin-dashboard-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 20px 60px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .dashboard-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .header-left h2 {
    margin: 0 0 4px;
    font-size: 24px;
    font-weight: 700;
  }

  .user-greeting {
    font-size: 13px;
    color: var(--text-muted, #787774);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .dashboard-tabs {
    display: flex;
    gap: 8px;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .tab-btn {
    padding: 8px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-muted, #787774);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .tab-btn:hover {
    color: var(--text-primary, #37352f);
  }

  .tab-btn.active {
    color: var(--accent-color, #2383e2);
    border-bottom-color: var(--accent-color, #2383e2);
  }

  .loading-state,
  .empty-state {
    padding: 60px 20px;
    text-align: center;
    background: var(--bg-secondary, #f7f6f3);
    border-radius: 8px;
    color: var(--text-muted, #787774);
  }

  .empty-state p {
    margin: 0 0 16px;
    font-size: 15px;
  }

  .filter-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
  }

  .search-box {
    flex: 1;
    min-width: 200px;
  }

  .search-input {
    width: 100%;
    max-width: 320px;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--border-color, #e0e0e0);
    background: var(--bg-primary, #ffffff);
    color: var(--text-primary, #37352f);
    font-size: 13px;
  }

  .filters-row {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }

  .filter-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }

  .select-control {
    padding: 5px 10px;
    border-radius: 4px;
    border: 1px solid var(--border-color, #e0e0e0);
    background: var(--bg-primary, #ffffff);
    color: var(--text-primary, #37352f);
    font-size: 13px;
  }

  .pages-table-wrapper {
    overflow-x: auto;
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 8px;
    background: var(--bg-primary, #ffffff);
  }

  .pages-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    text-align: left;
  }

  .pages-table th,
  .pages-table td {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-color, #f0f0f0);
  }

  .pages-table th {
    background: var(--bg-secondary, #f7f6f3);
    color: var(--text-muted, #787774);
    font-weight: 600;
  }

  .page-title-cell {
    font-weight: 500;
  }

  .page-title-link {
    color: var(--text-primary, #37352f);
    text-decoration: none;
  }

  .page-title-link:hover {
    color: var(--accent, #2383e2);
    text-decoration: underline;
  }

  .subject-tag {
    background: var(--bg-tertiary, #f0f0f0);
    color: var(--text-secondary, #37352f);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12px;
  }

  .badge {
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
  }

  .badge-published {
    background: var(--color-success-bg, #d1e7dd);
    color: var(--color-success, #0f5132);
  }

  .badge-modified {
    background: var(--color-warning-bg, #fff3cd);
    color: var(--color-warning, #664d03);
  }

  .badge-draft {
    background: var(--bg-tertiary, #e2e3e5);
    color: var(--text-muted, #41464b);
  }

  .revision-cell,
  .date-cell {
    color: var(--text-muted, #787774);
    font-size: 12px;
  }

  .actions-col {
    text-align: right;
  }

  .actions-cell {
    text-align: right;
    white-space: nowrap;
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    text-decoration: none;
    border: 1px solid transparent;
    background: transparent;
  }

  .action-btn.edit {
    color: var(--accent-color, #2383e2);
  }

  .action-btn.edit:hover {
    background: var(--accent-light, rgba(35, 131, 226, 0.08));
  }

  .action-btn.view {
    color: var(--color-success, #27ae60);
  }

  .action-btn.view:hover {
    background: var(--color-success-bg, rgba(39, 174, 96, 0.18));
  }

  .action-btn.delete {
    color: var(--color-danger, #eb5757);
  }

  .action-btn.delete:hover {
    background: var(--color-danger-bg, rgba(235, 87, 87, 0.18));
  }

  .subjects-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .subjects-header-row h3 {
    margin: 0;
    font-size: 16px;
  }

  .subjects-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .subject-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--bg-primary, #ffffff);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 6px;
  }

  .subject-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .subject-name {
    font-weight: 500;
    font-size: 14px;
  }

  .subject-count {
    color: var(--text-muted, #787774);
    font-size: 12px;
  }

  .subject-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }

  .form-group label {
    font-size: 13px;
    font-weight: 500;
  }

  .form-control {
    width: 100%;
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid var(--border-color, #e0e0e0);
    background: var(--bg-primary, #ffffff);
    color: var(--text-primary, #37352f);
    font-size: 14px;
  }

  .alert {
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.4;
    margin: 10px 0;
  }

  .alert-danger {
    background: var(--color-danger-bg, #fce8e6);
    color: var(--color-danger, #c5221f);
  }

  .alert-warning {
    background: var(--color-warning-bg, #fff8e1);
    color: var(--color-warning, #795548);
    border: 1px solid var(--border-color, #ffe082);
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
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .btn-sm {
    padding: 4px 8px;
    font-size: 12px;
  }

  .btn-primary {
    background: var(--accent-color, #2383e2);
    border-color: var(--accent-color, #2383e2);
    color: var(--text-inverse, #ffffff);
  }

  .btn-primary:hover {
    background: var(--accent-hover, #1b6fc1);
    border-color: var(--accent-hover, #1b6fc1);
  }

  .btn-secondary {
    background: var(--bg-secondary, #f7f6f3);
    border-color: var(--border-dark, #e0e0e0);
    color: var(--text-primary, #37352f);
  }

  .btn-secondary:hover {
    background: var(--bg-hover, #efeeea);
    border-color: var(--text-secondary, #787774);
  }

  .btn-danger {
    background: var(--color-danger, #c5221f);
    border-color: var(--color-danger, #c5221f);
    color: var(--text-inverse, #ffffff);
  }

  .btn-danger:hover {
    opacity: 0.92;
  }

  .field-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .btn-text-action {
    background: none;
    border: none;
    color: var(--accent-color, #2383e2);
    font-size: 12px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }

  .btn-text-action:hover {
    color: var(--accent-hover, #1b6fc1);
  }

  .no-subjects-notice {
    padding: 10px 12px;
    background: var(--color-warning-bg, #fff8e1);
    border: 1px solid var(--border-color, #ffe082);
    color: var(--color-warning, #795548);
    border-radius: 6px;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .no-subjects-notice p {
    margin: 0;
    color: #795548;
  }
</style>
