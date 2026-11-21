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
  let lightboxData = $state<{
    images: Array<{ src: string; alt: string }>;
    initialIndex: number;
  } | null>(null);

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
      const clickedImg = target as HTMLImageElement;
      const container = target.closest('.reader-body, .markdown-body') || document;
      const allImages = Array.from(
        container.querySelectorAll<HTMLImageElement>('img[data-lightbox], .markdown-image')
      );
      const images = allImages.map((img) => ({
        src: img.currentSrc || img.src,
        alt: img.alt || '',
      }));
      const initialIndex = allImages.indexOf(clickedImg);

      lightboxData = {
        images: images.length > 0 ? images : [{ src: clickedImg.currentSrc || clickedImg.src, alt: clickedImg.alt || '' }],
        initialIndex: initialIndex >= 0 ? initialIndex : 0,
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

        <!-- Article Footer / Platform Attribution -->
        <footer class="reader-footer-attribution">
          <div class="attribution-inner">
            <span class="platform-name">LabNotes</span>
            <span class="attribution-dot">•</span>
            <a
              href="https://github.com/VladMontana"
              target="_blank"
              rel="noopener noreferrer"
              class="attribution-link"
              title="Профиль разработчика на GitHub"
            >
              <svg class="github-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path fill="currentColor" d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              <span>Разработчик: <strong>VladMontana</strong></span>
            </a>
          </div>
        </footer>
      </article>

      <!-- Sticky Table of Contents Sidebar -->
      <Toc items={tocItems} />
    </div>
  {/if}
</div>

<!-- Image Lightbox Modal Overlay -->
{#if lightboxData}
  <Lightbox
    images={lightboxData.images}
    initialIndex={lightboxData.initialIndex}
    onclose={() => (lightboxData = null)}
  />
{/if}
