<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    open?: boolean;
    title?: string;
    onclose?: () => void;
    children?: Snippet;
    footer?: Snippet;
  }

  let {
    open = false,
    title = '',
    onclose,
    children,
    footer,
  }: Props = $props();

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open && onclose) {
      onclose();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget && onclose) {
      onclose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="modal-backdrop"
    onclick={handleBackdropClick}
    role="presentation"
  >
    <div
      class="modal-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <header class="modal-header">
        <h3 id="modal-title" class="modal-title">{title}</h3>
        {#if onclose}
          <button
            type="button"
            class="modal-close-btn"
            onclick={onclose}
            aria-label="Закрыть"
          >
            ×
          </button>
        {/if}
      </header>

      <div class="modal-body">
        {@render children?.()}
      </div>

      {#if footer}
        <footer class="modal-footer">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(15, 15, 15, 0.6);
    backdrop-filter: blur(2px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .modal-dialog {
    background: var(--bg-primary, #ffffff);
    color: var(--text-primary, #37352f);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2);
    width: 100%;
    max-width: 520px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: slideUp 0.15s ease-out;
  }

  @keyframes slideUp {
    from { transform: translateY(16px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .modal-title {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
  }

  .modal-close-btn {
    background: transparent;
    border: none;
    font-size: 20px;
    line-height: 1;
    color: var(--text-muted, #787774);
    cursor: pointer;
    padding: 0 4px;
    border-radius: 4px;
  }

  .modal-close-btn:hover {
    color: var(--text-primary, #37352f);
    background: rgba(0, 0, 0, 0.05);
  }

  .modal-body {
    padding: 20px;
    overflow-y: auto;
    font-size: 14px;
    line-height: 1.5;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 12px 20px;
    border-top: 1px solid var(--border-color, #e0e0e0);
    background: var(--bg-secondary, #f7f6f3);
  }
</style>
