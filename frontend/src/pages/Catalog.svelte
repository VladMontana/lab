<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api, type PublicPageItem, type PublicSubjectItem } from '../lib/api';
  import { router } from '../lib/router';
  import { subjects } from '../lib/stores';

  let pages = $state<PublicPageItem[]>([]);
  let total = $state<number>(0);
  let loading = $state<boolean>(true);
  let error = $state<string | null>(null);

  const PAGE_LIMIT = 20;
  let offset = $derived(Number($router.query.offset) || 0);
  let currentSubjectId = $derived($router.query.subject_id || '');
  let currentQuery = $derived($router.query.q || '');

  let searchInput = $state<string>('');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Sync searchInput when URL query changes externally
  $effect(() => {
    searchInput = currentQuery;
  });

  // Re-fetch whenever query params change
  $effect(() => {
    const subId = currentSubjectId;
    const q = currentQuery;
    const off = offset;
    fetchPages(subId, q, off);
  });

  async function fetchPages(subjectId: string, q: string, off: number) {
    loading = true;
    error = null;
    try {
      const res = await api.getPublicPages({
        subject_id: subjectId || undefined,
        q: q || undefined,
        limit: PAGE_LIMIT,
        offset: off,
      });
      pages = res.items;
      total = res.total;
    } catch (err: any) {
      error = err.message || 'Ошибка загрузки материалов';
      pages = [];
      total = 0;
    } finally {
      loading = false;
    }
  }

  function handleSearchInput(e: Event) {
    const target = e.target as HTMLInputElement;
    const val = target.value;
    searchInput = val;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      const queryParams = new URLSearchParams(window.location.search);
      if (val.trim()) {
        queryParams.set('q', val.trim());
      } else {
        queryParams.delete('q');
      }
      queryParams.delete('offset'); // Reset to page 1 on new search

      const qs = queryParams.toString();
      router.navigate(qs ? `/?${qs}` : '/');
    }, 300);
  }

  function clearSearch() {
    searchInput = '';
    const queryParams = new URLSearchParams(window.location.search);
    queryParams.delete('q');
    queryParams.delete('offset');
    const qs = queryParams.toString();
    router.navigate(qs ? `/?${qs}` : '/');
  }

  function setSubjectFilter(id?: string) {
    const queryParams = new URLSearchParams(window.location.search);
    if (id) {
      queryParams.set('subject_id', id);
    } else {
      queryParams.delete('subject_id');
    }
    queryParams.delete('offset');
    const qs = queryParams.toString();
    router.navigate(qs ? `/?${qs}` : '/');
  }

  function goToPage(newOffset: number) {
    const queryParams = new URLSearchParams(window.location.search);
    if (newOffset > 0) {
      queryParams.set('offset', newOffset.toString());
    } else {
      queryParams.delete('offset');
    }
    const qs = queryParams.toString();
    router.navigate(qs ? `/?${qs}` : '/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function formatDate(isoDate: string): string {
    if (!isoDate) return '';
    try {
      const date = new Date(isoDate);
      return new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(date);
    } catch {
      return isoDate;
    }
  }

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });
</script>

<div class="catalog-page">
  <header class="catalog-header">
    <h1 class="catalog-title">Практические работы</h1>
    <p class="catalog-subtitle">
      Учебные материалы, методические указания и практические задания
    </p>

    <!-- Search Input -->
    <div class="catalog-search-wrapper">
      <span class="catalog-search-icon" aria-hidden="true">🔍</span>
      <input
        type="search"
        class="catalog-search-input"
        placeholder="Поиск по названию или содержанию работы..."
        value={searchInput}
        oninput={handleSearchInput}
        aria-label="Поиск по работам"
      />
      {#if searchInput}
        <button
          type="button"
          class="catalog-search-clear"
          onclick={clearSearch}
          aria-label="Очистить поиск"
        >
          ✕
        </button>
      {/if}
    </div>

    <!-- Subject Filters -->
    <div class="catalog-filters" role="group" aria-label="Фильтр по предметам">
      <button
        type="button"
        class="filter-pill"
        class:active={!currentSubjectId}
        onclick={() => setSubjectFilter()}
      >
        Все предметы
      </button>

      {#each $subjects as subject (subject.id)}
        <button
          type="button"
          class="filter-pill"
          class:active={currentSubjectId === subject.id}
          onclick={() => setSubjectFilter(subject.id)}
        >
          {subject.name}
        </button>
      {/each}
    </div>
  </header>

  <!-- Content State -->
  {#if loading}
    <div class="loading-container" aria-live="polite">
      <div class="loading-spinner"></div>
      <div>Загрузка публикаций...</div>
    </div>
  {:else if error}
    <div class="empty-state">
      <div class="empty-state-icon">⚠️</div>
      <div class="empty-state-title">Не удалось загрузить материалы</div>
      <p>{error}</p>
      <button
        type="button"
        class="empty-state-action"
        onclick={() => fetchPages(currentSubjectId, currentQuery, offset)}
      >
        Попробовать снова
      </button>
    </div>
  {:else if pages.length === 0}
    <div class="empty-state">
      <div class="empty-state-icon">📄</div>
      <div class="empty-state-title">
        {#if currentQuery}
          По запросу «{currentQuery}» ничего не найдено
        {:else if currentSubjectId}
          В выбранном предмете пока нет опубликованных работ
        {:else}
          Пока нет опубликованных практических работ
        {/if}
      </div>
      <p>
        {#if currentQuery || currentSubjectId}
          Попробуйте изменить параметры поиска или выбрать другой предмет.
        {:else}
          Загляните позже — новые работы скоро появятся.
        {/if}
      </p>
      {#if currentQuery || currentSubjectId}
        <button
          type="button"
          class="empty-state-action"
          onclick={() => {
            clearSearch();
            setSubjectFilter();
          }}
        >
          Сбросить фильтры
        </button>
      {/if}
    </div>
  {:else}
    <!-- Page Cards List -->
    <div class="page-list">
      {#each pages as page (page.id)}
        <a href={`/p/${page.id}`} class="page-card">
          <div class="page-card-meta">
            <span class="badge-subject">{page.subject_name}</span>
            <span>•</span>
            <time datetime={page.published_at}>{formatDate(page.published_at)}</time>
          </div>
          <h2 class="page-card-title">{page.title}</h2>
          {#if page.snippet}
            <p class="page-card-snippet">{page.snippet}</p>
          {/if}
        </a>
      {/each}
    </div>

    <!-- Pagination -->
    {#if total > PAGE_LIMIT}
      {@const currentPage = Math.floor(offset / PAGE_LIMIT) + 1}
      {@const totalPages = Math.ceil(total / PAGE_LIMIT)}
      <nav class="pagination" aria-label="Пагинация">
        <button
          type="button"
          class="pagination-btn"
          disabled={offset <= 0}
          onclick={() => goToPage(Math.max(0, offset - PAGE_LIMIT))}
        >
          ← Назад
        </button>
        <div class="pagination-info">
          Страница {currentPage} из {totalPages} (всего {total})
        </div>
        <button
          type="button"
          class="pagination-btn"
          disabled={offset + PAGE_LIMIT >= total}
          onclick={() => goToPage(offset + PAGE_LIMIT)}
        >
          Вперёд →
        </button>
      </nav>
    {/if}
  {/if}
</div>
