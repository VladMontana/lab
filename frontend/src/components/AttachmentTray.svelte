<script lang="ts">
  import type { PublicAttachmentItem } from '../lib/api';

  interface Props {
    attachments: PublicAttachmentItem[];
  }

  let { attachments }: Props = $props();

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 Б';
    const k = 1024;
    const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const formatted = parseFloat((bytes / Math.pow(k, i)).toFixed(1));
    return `${formatted} ${sizes[i]}`;
  }

  function getFileIcon(mime: string, name: string): string {
    const ext = name.split('.').pop()?.toLowerCase();
    if (mime.includes('pdf') || ext === 'pdf') return '📕';
    if (mime.includes('zip') || ext === 'zip' || ext === 'tar' || ext === 'gz') return '📦';
    if (mime.includes('word') || ext === 'docx' || ext === 'doc') return '📝';
    if (mime.includes('text') || ext === 'txt' || ext === 'md') return '📃';
    return '📎';
  }
</script>

{#if attachments && attachments.length > 0}
  <section class="attachment-tray" aria-label="Вложения">
    <h3 class="attachment-tray-title">
      <span>📎</span>
      <span>Прикреплённые файлы ({attachments.length})</span>
    </h3>
    <div class="attachment-list">
      {#each attachments as att (att.id)}
        <a
          href={att.url}
          download={att.original_name}
          class="attachment-card"
          title={`Скачать ${att.original_name}`}
        >
          <span class="attachment-icon">{getFileIcon(att.mime, att.original_name)}</span>
          <div class="attachment-info">
            <div class="attachment-name">{att.original_name}</div>
            <div class="attachment-size">{formatBytes(att.byte_size)}</div>
          </div>
          <span class="attachment-download-icon" aria-hidden="true">⬇</span>
        </a>
      {/each}
    </div>
  </section>
{/if}
