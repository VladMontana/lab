<script lang="ts">
  import { toast } from '../lib/toast';
</script>

<div class="toast-container" aria-live="polite" aria-atomic="true">
  {#each $toast as item (item.id)}
    <div class="toast-item {item.type}" role="status">
      <span class="toast-icon">
        {#if item.type === 'success'}✓{/if}
        {#if item.type === 'error'}⚠{/if}
        {#if item.type === 'warning'}!{/if}
        {#if item.type === 'info'}ℹ{/if}
      </span>
      <span class="toast-text">{item.message}</span>
      <button
        type="button"
        class="toast-close"
        onclick={() => toast.dismiss(item.id)}
        aria-label="Закрыть уведомление"
      >
        ×
      </button>
    </div>
  {/each}
</div>

<style>
  .toast-container {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 380px;
    pointer-events: none;
  }

  .toast-item {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 14px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    animation: toast-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes toast-in {
    from {
      transform: translateY(12px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .toast-item.success {
    background: #0f5132;
    color: #ffffff;
  }

  .toast-item.error {
    background: #842029;
    color: #ffffff;
  }

  .toast-item.warning {
    background: #664d03;
    color: #ffffff;
  }

  .toast-item.info {
    background: #055160;
    color: #ffffff;
  }

  .toast-icon {
    font-weight: bold;
    font-size: 16px;
  }

  .toast-text {
    flex: 1;
    line-height: 1.4;
  }

  .toast-close {
    background: transparent;
    border: none;
    color: inherit;
    font-size: 18px;
    cursor: pointer;
    opacity: 0.8;
    padding: 0 4px;
    line-height: 1;
  }

  .toast-close:hover {
    opacity: 1;
  }
</style>
