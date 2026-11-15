<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type PublicPageViewResponse, ApiClientError } from '../lib/api';
  import { router } from '../lib/router';
  import { renderMarkdown, handleCodeCopyClick, type TocItem } from '../lib/markdown';
  import Toc from '../components/Toc.svelte';
  import AttachmentTray from '../components/AttachmentTray.svelte';
  import Lightbox from '../components/Lightbox.svelte';

  let page = $state<PublicPageViewResponse | null>(null);
  let loading = $state<boolean>(true);
  let notFound = $state<boolean>(false);
  let error = $state<string | null>(null);

  let renderedHtml = $state<string>('');
  let tocItems = $state<TocItem[]>([]);

  // Lightbox state
  let lightboxImage = $state<{ src: string; alt: string } | null>(null);

  let pageId = $derived($router.params.id);

  $effect(() => {
    if (pageId) {
      loadPage(pageId);
    }
  });

  async function loadPage(id: string) {
    loading = true;
    notFound = false;
    error = null;
    try {
      const data = await api.getPublicPage(id);
      page = data;
      const result = renderMarkdown(data.markdown);
      renderedHtml = result.html;
      tocItems = result.toc;
      document.title = `${data.title} — LabNotes`;
    } catch (err: any) {
      if (err instanceof ApiClientError && err.isNotFound()) {
        notFound = true;
      } else {
        error = err.message || 'Ошибка загрузки работы';
      }
      page = null;
      renderedHtml = '';
      tocItems = [];
    } finally {
      loading = false;
    }
  }

  function handleBodyClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // 1. Handle Code Copy Button
    if (target.closest('[data-copy-btn]')) {
      handleCodeCopyClick(event);
      return;
    }

    // 2. Handle Lightbox on images
    if (target.matches('img[data-lightbox], .markdown-image')) {
      const img = target as HTMLImageElement;
      lightboxImage = {
        src: img.currentSrc || img.src,
        alt: img.alt || '',
      };
      return;
    }
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
</script>

<div class="reader-container">
  {#if loading}
    <div class="loading-container" aria-live="polite">
      <div class="loading-spinner"></div>
      <div>Загрузка материала...</div>
    </div>
  {:else if notFound}
    <div class="notfound-container">
      <div class="notfound-code">404</div>
      <h1 class="notfound-title">Работа не найдена</h1>
      <p class="notfound-desc">
        Запрошенная практическая работа не существует, была удалена или ещё не опубликована автором.
      </p>
      <a href="/" class="notfound-back-btn">
        <span>←</span>
        <span>Вернуться в каталог</span>
      </a>
    </div>
  {:else if error}
    <div class="empty-state">
      <div class="empty-state-icon">⚠️</div>
      <div class="empty-state-title">Не удалось открыть публикацию</div>
      <p>{error}</p>
      <button
        type="button"
        class="empty-state-action"
        onclick={() => loadPage(pageId)}
      >
        Повторить попытку
      </button>
    </div>
  {:else if page}
    <div class="reader-layout">
      <!-- Main Article Column -->
      <article class="reader-main">
        <!-- Breadcrumbs & Meta Header -->
        <header class="reader-header">
          <nav class="reader-breadcrumbs" aria-label="Навигационная цепочка">
            <a href="/">Все работы</a>
            <span>/</span>
            <a href={`/?subject_id=${page.subject_id}`}>{page.subject_name}</a>
          </nav>

          <h1 class="reader-title">{page.title}</h1>

          <div class="reader-meta">
            <span class="badge-subject">{page.subject_name}</span>
            <span>•</span>
            <time datetime={page.published_at}>Опубликовано: {formatDate(page.published_at)}</time>
          </div>
        </header>

        <!-- Sanitized Markdown Content -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="markdown-body"
          onclick={handleBodyClick}
          role="region"
          aria-label="Содержимое работы"
        >
          {@html renderedHtml}
        </div>

        <!-- Attachments -->
        {#if page.attachments && page.attachments.length > 0}
          <AttachmentTray attachments={page.attachments} />
        {/if}
      </article>

      <!-- Sticky Table of Contents Sidebar -->
      <Toc items={tocItems} />
    </div>
  {/if}
</div>

<!-- Image Lightbox Modal Overlay -->
{#if lightboxImage}
  <Lightbox
    src={lightboxImage.src}
    alt={lightboxImage.alt}
    onclose={() => (lightboxImage = null)}
  />
{/if}
