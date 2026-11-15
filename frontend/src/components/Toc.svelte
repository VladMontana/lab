<script lang="ts">
  import { onMount } from 'svelte';
  import type { TocItem } from '../lib/markdown';

  interface Props {
    items: TocItem[];
  }

  let { items }: Props = $props();

  let activeId = $state<string>('');

  onMount(() => {
    if (!items || items.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            activeId = entry.target.id;
            break;
          }
        }
      },
      {
        rootMargin: '0px 0px -70% 0px',
        threshold: 0,
      }
    );

    // Observe each heading in the document
    for (const item of items) {
      const el = document.getElementById(item.id);
      if (el) {
        observer.observe(el);
      }
    }

    return () => {
      observer.disconnect();
    };
  });

  function handleTocClick(e: MouseEvent, id: string) {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
      activeId = id;
      window.history.replaceState(null, '', `#${id}`);
    }
  }
</script>

{#if items && items.length > 0}
  <aside class="toc-wrapper" aria-label="Содержание статьи">
    <div class="toc-header">Содержание</div>
    <ul class="toc-list">
      {#each items as item (item.id)}
        <li class="toc-item level-{item.level}">
          <a
            href={`#${item.id}`}
            class="toc-link"
            class:active={activeId === item.id}
            onclick={(e) => handleTocClick(e, item.id)}
            title={item.text}
          >
            {item.text}
          </a>
        </li>
      {/each}
    </ul>
  </aside>
{/if}
