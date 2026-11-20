<script lang="ts">
  import { theme, isDark } from '../lib/theme';

  interface Props {
    variant?: 'sidebar' | 'icon';
  }

  let { variant = 'sidebar' }: Props = $props();

  function handleToggle() {
    theme.toggle();
  }
</script>

{#if variant === 'sidebar'}
  <button
    type="button"
    class="sidebar-theme-toggle"
    onclick={handleToggle}
    aria-label={$isDark ? 'Переключить на светлую тему' : 'Переключить на тёмную тему'}
    title={$isDark ? 'Тёмная тема (нажмите для переключения)' : 'Светлая тема (нажмите для переключения)'}
  >
    <span class="theme-toggle-icon" aria-hidden="true">
      {#if $isDark}
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>
        </svg>
      {:else}
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2v2"></path>
          <path d="M12 20v2"></path>
          <path d="m4.93 4.93 1.41 1.41"></path>
          <path d="m17.66 17.66 1.41 1.41"></path>
          <path d="M2 12h2"></path>
          <path d="M20 12h2"></path>
          <path d="m6.34 17.66-1.41 1.41"></path>
          <path d="m19.07 4.93-1.41 1.41"></path>
        </svg>
      {/if}
    </span>
    <span class="theme-toggle-text">{$isDark ? 'Тёмная тема' : 'Светлая тема'}</span>
  </button>
{:else}
  <button
    type="button"
    class="icon-theme-toggle"
    onclick={handleToggle}
    aria-label={$isDark ? 'Переключить на светлую тему' : 'Переключить на тёмную тему'}
    title={$isDark ? 'Тёмная тема (нажмите для переключения)' : 'Светлая тема (нажмите для переключения)'}
  >
    {#if $isDark}
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>
      </svg>
    {:else}
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="4"></circle>
        <path d="M12 2v2"></path>
        <path d="M12 20v2"></path>
        <path d="m4.93 4.93 1.41 1.41"></path>
        <path d="m17.66 17.66 1.41 1.41"></path>
        <path d="M2 12h2"></path>
        <path d="M20 12h2"></path>
        <path d="m6.34 17.66-1.41 1.41"></path>
        <path d="m19.07 4.93-1.41 1.41"></path>
      </svg>
    {/if}
  </button>
{/if}

<style>
  .sidebar-theme-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.88rem;
    font-weight: 500;
    transition: background-color var(--transition-fast), color var(--transition-fast);
    text-align: left;
    margin-bottom: 8px;
  }

  .sidebar-theme-toggle:hover {
    background-color: var(--bg-hover);
    color: var(--text-primary);
  }

  .theme-toggle-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
  }

  .theme-toggle-text {
    flex: 1;
  }

  .icon-theme-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    transition: background-color var(--transition-fast);
  }

  .icon-theme-toggle:hover {
    background-color: var(--bg-hover);
  }
</style>
