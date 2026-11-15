<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from '../lib/router';
  import { subjects, auth, mobileSidebarOpen } from '../lib/stores';

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
