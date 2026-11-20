<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from './lib/router';
  import { auth, mobileSidebarOpen } from './lib/stores';

  import Sidebar from './components/Sidebar.svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import Toast from './components/Toast.svelte';
  import Catalog from './pages/Catalog.svelte';
  import Reader from './pages/Reader.svelte';
  import Login from './pages/Login.svelte';
  import NotFound from './pages/NotFound.svelte';

  onMount(() => {
    // 1. Initialize HTML5 history router listeners
    const cleanupRouter = router.init();

    // 2. Check author session on startup
    auth.init();

    return () => {
      cleanupRouter();
    };
  });

  function toggleMobileMenu() {
    $mobileSidebarOpen = !$mobileSidebarOpen;
  }

  function closeMobileDrawer() {
    $mobileSidebarOpen = false;
  }
</script>

<div class="app-container">
  <!-- Mobile Topbar (< 768px) -->
  <header class="mobile-topbar" aria-label="Мобильная шапка">
    <button
      type="button"
      class="mobile-menu-btn"
      onclick={toggleMobileMenu}
      aria-label="Открыть меню"
    >
      ☰
    </button>
    <a href="/" class="mobile-brand" onclick={closeMobileDrawer}>
      <img src="/book-icon.svg" alt="LabNotes" class="mobile-logo-icon" width="22" height="22" />
      <span>LabNotes</span>
    </a>
    <ThemeToggle variant="icon" />
  </header>

  <!-- Mobile Drawer Backdrop -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="drawer-backdrop"
    class:open={$mobileSidebarOpen}
    onclick={closeMobileDrawer}
    role="presentation"
  ></div>

  <!-- Persistent Desktop Sidebar & Mobile Drawer -->
  <Sidebar />

  <!-- Main Content View Area -->
  <main class="main-wrapper">
    <div
      class="content-area"
      class:content-area-wide={$router.name === 'admin-editor' || $router.name === 'admin-editor-new'}
    >
      {#if $router.name === 'catalog'}
        <Catalog />
      {:else if $router.name === 'reader'}
        <Reader />
      {:else if $router.name === 'login'}
        <Login />
      {:else if $router.name === 'admin-dashboard'}
        {#await import('./pages/AdminDashboard.svelte') then { default: AdminDashboard }}
          <AdminDashboard />
        {:catch error}
          <div class="page-load-error">Ошибка загрузки панели: {error.message}</div>
        {/await}
      {:else if $router.name === 'admin-editor' || $router.name === 'admin-editor-new'}
        {#await import('./pages/EditorPage.svelte') then { default: EditorPage }}
          <EditorPage pageId={$router.params.id} isNew={$router.name === 'admin-editor-new'} />
        {:catch error}
          <div class="page-load-error">Ошибка загрузки редактора: {error.message}</div>
        {/await}
      {:else}
        <NotFound />
      {/if}
    </div>
  </main>

  <Toast />
</div>
