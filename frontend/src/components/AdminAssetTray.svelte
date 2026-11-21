<script lang="ts">
  import { toast } from '../lib/toast';
  import type { AssetResponse } from '../lib/api';
  import Modal from './Modal.svelte';

  interface Props {
    pageId: string;
    assets?: AssetResponse[];
    selectedAttachmentIds?: string[];
    oninsert?: (snippet: string) => void;
    onupload?: (file: File) => Promise<AssetResponse>;
    ondelete?: (assetId: string) => Promise<void>;
    onselectionchange?: (ids: string[]) => void;
  }

  let {
    pageId,
    assets = [],
    selectedAttachmentIds = [],
    oninsert,
    onupload,
    ondelete,
    onselectionchange,
  }: Props = $props();

  let fileInputEl: HTMLInputElement | null = null;
  let isUploading = $state(false);
  let deleteModalOpen = $state(false);
  let assetToDelete = $state<AssetResponse | null>(null);
  let isDeleting = $state(false);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }

  function getFileIcon(mime: string, kind: string): string {
    if (kind === 'image' || mime.startsWith('image/')) return '🖼️';
    if (mime.includes('pdf')) return '📕';
    if (mime.includes('zip') || mime.includes('compressed')) return '📦';
    if (mime.includes('word') || mime.includes('officedocument')) return '📝';
    if (mime.includes('markdown') || mime.includes('text')) return '📃';
    return '📎';
  }

  function handleTriggerUpload() {
    fileInputEl?.click();
  }

  async function handleFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const files = target.files;
    if (!files || files.length === 0 || !onupload) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Pre-flight validation
      if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
        toast.error('Формат SVG запрещен в целях безопасности');
        continue;
      }
      if (
        file.type === 'text/html' ||
        file.name.toLowerCase().endsWith('.html') ||
        file.name.toLowerCase().endsWith('.htm')
      ) {
        toast.error('Файлы HTML запрещены в целях безопасности');
        continue;
      }

      const isImage = file.type.startsWith('image/');
      const maxBytes = isImage ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
      if (file.size > maxBytes) {
        toast.error(
          `Файл «${file.name}» превышает допустимый размер (${isImage ? '10 МБ' : '50 МБ'})`
        );
        continue;
      }

      isUploading = true;
      try {
        const uploaded = await onupload(file);
        toast.success(`Файл «${uploaded.original_name}» успешно загружен`);
      } catch (err: any) {
        if (err.status === 413 || err.code === 'FILE_TOO_LARGE') {
          toast.error(`Файл «${file.name}» слишком большой (превышен лимит сервера)`);
        } else {
          toast.error(err.message || `Ошибка загрузки файла «${file.name}»`);
        }
      } finally {
        isUploading = false;
      }
    }

    target.value = '';
  }

  function handleInsert(asset: AssetResponse) {
    if (!oninsert) return;
    const isImg = asset.kind === 'image' || asset.mime.startsWith('image/');
    const snippet = isImg
      ? `![${asset.original_name}](${asset.url})\n`
      : `[${asset.original_name}](${asset.url})\n`;
    oninsert(snippet);
    toast.info('Вставлено в редактор');
  }

  async function handleCopyLink(asset: AssetResponse) {
    const isImg = asset.kind === 'image' || asset.mime.startsWith('image/');
    const snippet = isImg
      ? `![${asset.original_name}](${asset.url})`
      : `[${asset.original_name}](${asset.url})`;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(snippet);
      } else {
        const el = document.createElement('textarea');
        el.value = snippet;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      toast.success('Ссылка скопирована в буфер обмена');
    } catch {
      toast.error('Не удалось скопировать ссылку');
    }
  }

  function promptDelete(asset: AssetResponse) {
    assetToDelete = asset;
    deleteModalOpen = true;
  }

  async function confirmDelete() {
    if (!assetToDelete || !ondelete) return;
    isDeleting = true;
    try {
      await ondelete(assetToDelete.id);
      toast.success(`Файл «${assetToDelete.original_name}» удалён`);
      deleteModalOpen = false;
      assetToDelete = null;
    } catch (err: any) {
      toast.error(err.message || 'Ошибка удаления файла');
    } finally {
      isDeleting = false;
    }
  }

  function toggleAttachmentSelection(assetId: string, checked: boolean) {
    let next: string[];
    if (checked) {
      next = selectedAttachmentIds.includes(assetId)
        ? selectedAttachmentIds
        : [...selectedAttachmentIds, assetId];
    } else {
      next = selectedAttachmentIds.filter((id) => id !== assetId);
    }
    if (onselectionchange) {
      onselectionchange(next);
    }
  }
</script>

<section class="asset-tray-container" aria-label="Панель медиафайлов и вложений">
  <div class="asset-tray-header">
    <div class="header-title">
      <span class="icon">📎</span>
      <h4>Файлы и вложения ({assets.length})</h4>
    </div>
    <div class="header-actions">
      <input
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,.pdf,.docx,.txt,.md,.zip"
        class="hidden-input"
        bind:this={fileInputEl}
        onchange={handleFileSelected}
        style="display: none;"
      />
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        onclick={handleTriggerUpload}
        disabled={isUploading}
      >
        {isUploading ? '⏳ Загрузка...' : '+ Прикрепить файл'}
      </button>
    </div>
  </div>

  {#if assets.length === 0}
    <div class="empty-tray-notice">
      <p>Нет прикреплённых файлов. Загрузите изображения (до 10 МБ) или документы (до 50 МБ).</p>
    </div>
  {:else}
    <div class="asset-grid">
      {#each assets as asset (asset.id)}
        <div class="asset-card" class:is-image={asset.kind === 'image'}>
          <div class="asset-preview">
            {#if asset.kind === 'image' || asset.mime.startsWith('image/')}
              <img src={asset.url} alt={asset.original_name} class="asset-thumbnail" loading="lazy" />
            {:else}
              <span class="file-icon">{getFileIcon(asset.mime, asset.kind)}</span>
            {/if}
          </div>

          <div class="asset-details">
            <span class="asset-name" title={asset.original_name}>{asset.original_name}</span>
            <span class="asset-meta">{formatBytes(asset.byte_size)}</span>

            {#if asset.kind === 'attachment'}
              <label class="publish-checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedAttachmentIds.includes(asset.id)}
                  onchange={(e) =>
                    toggleAttachmentSelection(asset.id, (e.target as HTMLInputElement).checked)}
                />
                <span>В публикацию</span>
              </label>
            {/if}
          </div>

          <div class="asset-card-actions">
            <button
              type="button"
              class="card-btn"
              title="Вставить в текст Markdown"
              onclick={() => handleInsert(asset)}
            >
              Вставить
            </button>
            <button
              type="button"
              class="card-btn"
              title="Копировать Markdown-ссылку"
              onclick={() => handleCopyLink(asset)}
            >
              Копировать
            </button>
            <button
              type="button"
              class="card-btn danger"
              title="Удалить файл"
              onclick={() => promptDelete(asset)}
            >
              ✕
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<!-- Delete Confirmation Modal -->
<Modal
  open={deleteModalOpen}
  title="Удаление файла"
  onclose={() => (deleteModalOpen = false)}
>
  <p>
    Вы уверены, что хотите удалить файл <strong>{assetToDelete?.original_name}</strong>?
  </p>
  <p class="modal-warning-subtext">
    Если файл используется в тексте работы, ссылка на него перестанет открываться.
  </p>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (deleteModalOpen = false)}
      disabled={isDeleting}
    >
      Отмена
    </button>
    <button
      type="button"
      class="btn btn-danger"
      onclick={confirmDelete}
      disabled={isDeleting}
    >
      {isDeleting ? 'Удаление...' : 'Удалить'}
    </button>
  {/snippet}
</Modal>

<style>
  .asset-tray-container {
    border-top: 1px solid var(--border-color, #e0e0e0);
    background: var(--bg-secondary, #f7f6f3);
    padding: 16px;
    border-radius: 0 0 8px 8px;
  }

  .asset-tray-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .header-title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-title h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .empty-tray-notice {
    padding: 20px;
    text-align: center;
    color: var(--text-muted, #787774);
    font-size: 13px;
    background: var(--bg-primary, #ffffff);
    border: 1px dashed var(--border-color, #e0e0e0);
    border-radius: 6px;
  }

  .empty-tray-notice p {
    margin: 0;
  }

  .asset-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }

  .asset-card {
    background: var(--bg-primary, #ffffff);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: box-shadow 0.15s ease, border-color 0.15s ease;
  }

  .asset-card:hover {
    border-color: var(--border-dark);
    box-shadow: var(--shadow-sm);
  }

  .asset-preview {
    height: 90px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .asset-thumbnail {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .file-icon {
    font-size: 32px;
  }

  .asset-details {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
  }

  .asset-name {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-primary, #37352f);
  }

  .asset-meta {
    color: var(--text-muted, #787774);
    font-size: 11px;
  }

  .publish-checkbox-label {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 4px;
    font-size: 11px;
    cursor: pointer;
    color: var(--text-primary, #37352f);
  }

  .asset-card-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: auto;
    border-top: 1px solid var(--border-color, #f0f0f0);
    padding-top: 6px;
  }

  .card-btn {
    flex: 1;
    font-size: 11px;
    padding: 3px 6px;
    background: var(--bg-secondary, #f5f5f5);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-primary, #37352f);
    transition: background 0.15s ease;
  }

  .card-btn:hover {
    background: var(--bg-hover, #e8e8e8);
  }

  .card-btn.danger {
    flex: 0 0 24px;
    color: var(--color-danger, #c5221f);
  }

  .card-btn.danger:hover {
    background: var(--color-danger-bg, #fce8e6);
    border-color: var(--color-danger, #fad2cf);
  }

  .modal-warning-subtext {
    font-size: 12px;
    color: var(--text-muted, #787774);
    margin-top: 6px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn-sm {
    padding: 4px 8px;
    font-size: 12px;
  }

  .btn-secondary {
    background: var(--bg-secondary, #f7f6f3);
    border-color: var(--border-dark, #e0e0e0);
    color: var(--text-primary, #37352f);
  }

  .btn-secondary:hover {
    background: var(--bg-hover, #efeeea);
    border-color: var(--text-secondary, #787774);
  }

  .btn-danger {
    background: var(--color-danger, #c5221f);
    border-color: var(--color-danger, #c5221f);
    color: var(--text-inverse, #ffffff);
  }

  .btn-danger:hover {
    opacity: 0.92;
  }
</style>
