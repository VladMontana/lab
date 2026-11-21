<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from '../lib/router';
  import { subjects, auth, mobileSidebarOpen } from '../lib/stores';
  import ThemeToggle from './ThemeToggle.svelte';

  onMount(() => {
    subjects.load();
  });

  function closeMobileDrawer() {
    $mobileSidebarOpen = false;
  }

  function handleSubjectClick(id?: string) {
    closeMobileDrawer();
    if (id) {
      router.navigate(`/?subject_id=${encodeURIComponent(id)}`);
    } else {
      router.navigate('/');
    }
  }

  function handleLogout() {
    closeMobileDrawer();
    auth.logout();
  }
</script>

<aside class="sidebar" class:open={$mobileSidebarOpen} aria-label="Боковое меню">
  <div class="sidebar-header">
    <a href="/" class="sidebar-logo" onclick={closeMobileDrawer}>
      <img src="/book-icon.svg" alt="LabNotes" class="sidebar-logo-icon" width="22" height="22" />
      <span>LabNotes</span>
    </a>
    <button
      type="button"
      class="sidebar-close-btn"
      onclick={closeMobileDrawer}
      aria-label="Закрыть меню"
    >
      ✕
    </button>
  </div>

  <nav class="sidebar-nav">
    <div class="sidebar-section-title">Материалы</div>
    <a
      href="/"
      class="sidebar-link"
      class:active={$router.name === 'catalog' && !$router.query.subject_id}
      onclick={(e) => {
        e.preventDefault();
        handleSubjectClick();
      }}
    >
      <span class="sidebar-link-content">
        <span>📚</span>
        <span>Все работы</span>
      </span>
    </a>

    {#if $subjects.length > 0}
      <div class="sidebar-section-title">Предметы</div>
      {#each $subjects as subject (subject.id)}
        <a
          href={`/?subject_id=${subject.id}`}
          class="sidebar-link"
          class:active={$router.name === 'catalog' && $router.query.subject_id === subject.id}
          onclick={(e) => {
            e.preventDefault();
            handleSubjectClick(subject.id);
          }}
        >
          <span class="sidebar-link-content" title={subject.name}>
            <span>📁</span>
            <span>{subject.name}</span>
          </span>
          <span class="sidebar-count-badge">{subject.page_count}</span>
        </a>
      {/each}
    {/if}
  </nav>

  <div class="sidebar-footer">
    <ThemeToggle variant="sidebar" />

    <a
      href="https://github.com/VladMontana"
      target="_blank"
      rel="noopener noreferrer"
      class="sidebar-author-badge"
      title="Профиль разработчика на GitHub"
    >
      <svg class="github-svg" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path fill="currentColor" d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
      </svg>
      <span class="badge-text">Разработчик: <strong>VladMontana</strong></span>
      <span class="external-arrow">↗</span>
    </a>

    {#if $auth.isAuthenticated && $auth.user}
      <div class="author-session-info">
        <a href="/admin" class="author-admin-link" onclick={closeMobileDrawer}>
          <span>⚙️</span>
          <span>Панель автора</span>
        </a>
        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; margin-top: 6px;">
          <span class="author-username" title={$auth.user.username}>
            <span>👤</span>
            <span>{$auth.user.username}</span>
          </span>
          <button type="button" class="author-logout-btn" onclick={handleLogout}>
            Выйти
          </button>
        </div>
      </div>
    {:else}
      <a href="/admin/login" class="author-link" onclick={closeMobileDrawer}>
        <span>🔑</span>
        <span>Вход для автора</span>
      </a>
    {/if}
  </div>
</aside>
