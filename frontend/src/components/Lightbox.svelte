<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    src: string;
    alt?: string;
    onclose: () => void;
  }

  let { src, alt = '', onclose }: Props = $props();

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose();
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="lightbox-backdrop"
  onclick={onclose}
  onkeydown={handleKeyDown}
  role="dialog"
  aria-modal="true"
  aria-label="Просмотр изображения"
  tabindex="-1"
>
  <button
    type="button"
    class="lightbox-close-btn"
    onclick={onclose}
    aria-label="Закрыть (Escape)"
  >
    ✕
  </button>

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="lightbox-container"
    onclick={(e) => e.stopPropagation()}
    role="document"
  >
    <img {src} {alt} class="lightbox-image" />
    {#if alt}
      <div class="lightbox-caption">{alt}</div>
    {/if}
  </div>
</div>
