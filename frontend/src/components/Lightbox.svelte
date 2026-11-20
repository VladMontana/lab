<script lang="ts">
  import { onMount } from 'svelte';

  export interface LightboxItem {
    src: string;
    alt?: string;
  }

  interface Props {
    src?: string;
    alt?: string;
    images?: LightboxItem[];
    initialIndex?: number;
    onclose: () => void;
  }

  let { src = '', alt = '', images, initialIndex = 0, onclose }: Props = $props();

  // Normalize image list: support both single image and array
  let galleryImages = $derived<LightboxItem[]>(
    images && images.length > 0
      ? images
      : [{ src, alt }]
  );

  let currentIndex = $state(0);
  let slideDirection = $state<'next' | 'prev' | 'initial'>('initial');

  $effect(() => {
    currentIndex = initialIndex;
    slideDirection = 'initial';
  });

  // Keep index within bounds if gallery length changes
  $effect(() => {
    if (currentIndex >= galleryImages.length) {
      currentIndex = Math.max(0, galleryImages.length - 1);
    }
  });

  let currentImage = $derived<LightboxItem>(
    galleryImages[currentIndex] || { src: '', alt: '' }
  );

  function goToNext() {
    if (galleryImages.length <= 1) return;
    slideDirection = 'next';
    currentIndex = (currentIndex + 1) % galleryImages.length;
    preloadAdjacent();
  }

  function goToPrev() {
    if (galleryImages.length <= 1) return;
    slideDirection = 'prev';
    currentIndex = (currentIndex - 1 + galleryImages.length) % galleryImages.length;
    preloadAdjacent();
  }

  function preloadAdjacent() {
    if (galleryImages.length <= 1) return;
    const nextIdx = (currentIndex + 1) % galleryImages.length;
    const prevIdx = (currentIndex - 1 + galleryImages.length) % galleryImages.length;
    if (galleryImages[nextIdx]?.src) {
      const nextImg = new Image();
      nextImg.src = galleryImages[nextIdx].src;
    }
    if (galleryImages[prevIdx]?.src) {
      const prevImg = new Image();
      prevImg.src = galleryImages[prevIdx].src;
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      goToNext();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      goToPrev();
    }
  }

  // Mobile Touch Swipe Handling
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;

  function handleTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
  }

  function handleTouchEnd(e: TouchEvent) {
    if (e.changedTouches.length !== 1) return;
    const deltaX = e.changedTouches[0].clientX - touchStartX;
    const deltaY = e.changedTouches[0].clientY - touchStartY;
    const elapsed = Date.now() - touchStartTime;

    // Minimum swipe threshold 45px and predominantly horizontal movement
    if (Math.abs(deltaX) > 45 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4 && elapsed < 800) {
      if (deltaX < 0) {
        goToNext(); // Swipe Left -> Next Image
      } else {
        goToPrev(); // Swipe Right -> Previous Image
      }
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    preloadAdjacent();

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
  ontouchstart={handleTouchStart}
  ontouchend={handleTouchEnd}
  role="dialog"
  aria-modal="true"
  aria-label="Просмотр изображений"
  tabindex="-1"
>
  <!-- Image Counter Badge (when multiple images) -->
  {#if galleryImages.length > 1}
    <div class="lightbox-counter" aria-live="polite">
      {currentIndex + 1} / {galleryImages.length}
    </div>
  {/if}

  <!-- Close Button -->
  <button
    type="button"
    class="lightbox-close-btn"
    onclick={onclose}
    aria-label="Закрыть просмотр (Escape)"
    title="Закрыть (Escape)"
  >
    ✕
  </button>

  <!-- Previous Image Button -->
  {#if galleryImages.length > 1}
    <button
      type="button"
      class="lightbox-nav-btn prev"
      onclick={(e) => {
        e.stopPropagation();
        goToPrev();
      }}
      aria-label="Предыдущее изображение (Стрелка влево)"
      title="Предыдущее (←)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="m15 18-6-6 6-6"/>
      </svg>
    </button>
  {/if}

  <!-- Active Image Container -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="lightbox-container"
    onclick={(e) => e.stopPropagation()}
    role="document"
  >
    {#key currentImage.src}
      <img
        src={currentImage.src}
        alt={currentImage.alt || ''}
        class="lightbox-image slide-{slideDirection}"
      />
      {#if currentImage.alt}
        <div class="lightbox-caption">{currentImage.alt}</div>
      {/if}
    {/key}
  </div>

  <!-- Next Image Button -->
  {#if galleryImages.length > 1}
    <button
      type="button"
      class="lightbox-nav-btn next"
      onclick={(e) => {
        e.stopPropagation();
        goToNext();
      }}
      aria-label="Следующее изображение (Стрелка вправо)"
      title="Следующее (→)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="m9 18 6-6-6-6"/>
      </svg>
    </button>
  {/if}
</div>
