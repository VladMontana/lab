<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EditorState } from '@codemirror/state';
  import {
    EditorView,
    lineNumbers,
    highlightActiveLineGutter,
    highlightSpecialChars,
    drawSelection,
    dropCursor,
    highlightActiveLine,
    keymap,
    placeholder as cmPlaceholder,
  } from '@codemirror/view';
  import {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
    undo,
    redo,
  } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';

  import { renderMarkdown, handleCodeCopyClick, type RenderResult } from '../lib/markdown';
  import {
    toggleWrap,
    toggleHeading,
    insertLink,
    insertCodeBlock,
    toggleList,
  } from './editorUtils';

  // Svelte 5 Props Interface
  interface Props {
    value?: string;
    placeholder?: string;
    viewMode?: 'editor' | 'preview' | 'split';
    disabled?: boolean;
    onchange?: (value: string) => void;
    onsave?: () => void;
    onuploadimage?: (file: File) => Promise<{ id: string; url: string; name: string }>;
  }

  let {
    value = '',
    placeholder = 'Введите текст практической работы в формате Markdown...',
    viewMode = 'split',
    disabled = false,
    onchange,
    onsave,
    onuploadimage,
  }: Props = $props();

  // Component State
  let currentViewMode = $state<'editor' | 'preview' | 'split'>('split');
  let editorContainerEl: HTMLDivElement | null = null;
  let fileInputEl: HTMLInputElement | null = null;
  let view: EditorView | null = null;
  let isInternalChange = false;
  let uploadError = $state<string | null>(null);
  let isUploading = $state<boolean>(false);
  let isDraggingOver = $state<boolean>(false);

  // Sync external viewMode changes
  $effect(() => {
    currentViewMode = viewMode;
  });

  // Render markdown for preview pane
  let previewData = $derived<RenderResult>(renderMarkdown(value));

  // Notion-inspired CodeMirror Theme
  const editorTheme = EditorView.theme({
    '&': {
      height: '100%',
      minHeight: '400px',
      fontSize: '15px',
      backgroundColor: 'var(--bg-primary, #ffffff)',
      color: 'var(--text-primary, #37352f)',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'var(--font-mono, "SFMono-Regular", Menlo, Monaco, Consolas, monospace)',
      lineHeight: '1.6',
    },
    '.cm-content': {
      padding: '16px 12px',
      caretColor: 'var(--accent-color, #2383e2)',
    },
    '.cm-line': {
      padding: '0 4px',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-secondary, #f7f6f3)',
      color: 'var(--text-muted, #787774)',
      borderRight: '1px solid var(--border-color, #e0e0e0)',
      userSelect: 'none',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(35, 131, 226, 0.04)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(35, 131, 226, 0.08)',
      color: 'var(--accent-color, #2383e2)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
  });

  onMount(() => {
    if (!editorContainerEl) return;

    // Custom Keymap including Hotkeys
    const customKeymap = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          if (onsave) onsave();
          return true; // Prevent default browser "Save page as" dialog
        },
      },
      {
        key: 'Mod-b',
        run: (v) => {
          toggleWrap(v, '**');
          return true;
        },
      },
      {
        key: 'Mod-i',
        run: (v) => {
          toggleWrap(v, '*');
          return true;
        },
      },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]);

    // DOM Event Handlers for Image Paste and Drop inside CodeMirror
    const eventHandlers = EditorView.domEventHandlers({
      paste(event, currentView) {
        const items = event.clipboardData?.items;
        if (!items) return false;

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file && onuploadimage) {
              event.preventDefault();
              handleImageUpload(file, currentView);
              return true;
            }
          }
        }
        return false; // Allow standard text paste
      },
      dragover(event) {
        if (event.dataTransfer?.types.includes('Files')) {
          event.preventDefault();
          isDraggingOver = true;
          return true;
        }
        return false;
      },
      dragleave(event) {
        isDraggingOver = false;
        return false;
      },
      drop(event, currentView) {
        isDraggingOver = false;
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;

        const file = files[0];
        if (file.type.startsWith('image/') && onuploadimage) {
          event.preventDefault();
          const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY });
          handleImageUpload(file, currentView, pos ?? undefined);
          return true;
        }
        return false;
      },
    });

    const startState = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping, // Feature 28: Word wrap
        bracketMatching(),
        highlightActiveLine(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        cmPlaceholder(placeholder),
        editorTheme,
        customKeymap,
        eventHandlers,
        EditorState.readOnly.of(disabled),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            isInternalChange = true;
            const newDoc = update.state.doc.toString();
            if (onchange) {
              onchange(newDoc);
            }
            isInternalChange = false;
          }
        }),
      ],
    });

    view = new EditorView({
      state: startState,
      parent: editorContainerEl,
    });
  });

  // Sync value from outside if modified externally (e.g. initial load or conflict revert)
  $effect(() => {
    const val = value;
    if (view && !isInternalChange) {
      const currentDoc = view.state.doc.toString();
      if (val !== currentDoc) {
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: val },
        });
      }
    }
  });

  onDestroy(() => {
    // Feature 29 / AGENT_PLAN 147: Clean up CodeMirror on unmount to prevent leaks
    if (view) {
      view.destroy();
      view = null;
    }
  });

  // Upload handler for pasted / dropped / picked images
  async function handleImageUpload(file: File, currentView: EditorView, dropPos?: number) {
    if (!onuploadimage) return;
    isUploading = true;
    uploadError = null;
    try {
      const res = await onuploadimage(file);
      const insertPos = dropPos !== undefined ? dropPos : currentView.state.selection.main.from;
      const mdSnippet = `![${res.name || file.name}](${res.url})\n`;
      currentView.dispatch({
        changes: { from: insertPos, insert: mdSnippet },
        selection: { anchor: insertPos + mdSnippet.length },
      });
      currentView.focus();
    } catch (err: any) {
      uploadError = err.message || 'Ошибка загрузки изображения';
    } finally {
      isUploading = false;
    }
  }

  // File Picker Trigger
  function triggerFilePicker() {
    fileInputEl?.click();
  }

  function handleFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const files = target.files;
    if (files && files.length > 0 && view) {
      handleImageUpload(files[0], view);
    }
    target.value = ''; // Reset input
  }

  // Public Methods exposed to parent component
  export function insertText(text: string) {
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
  }

  export function focusEditor() {
    view?.focus();
  }
</script>

<div class="codemirror-wrapper" class:drag-active={isDraggingOver}>
  <!-- Formatting Toolbar -->
  <header class="editor-toolbar" role="toolbar" aria-label="Панель форматирования Markdown">
    <div class="toolbar-group">
      <button
        type="button"
        class="toolbar-btn"
        title="Заголовок 1 (H1)"
        aria-label="Заголовок 1"
        onclick={() => view && toggleHeading(view, 1)}
      >
        H1
      </button>
      <button
        type="button"
        class="toolbar-btn"
        title="Заголовок 2 (H2)"
        aria-label="Заголовок 2"
        onclick={() => view && toggleHeading(view, 2)}
      >
        H2
      </button>
      <button
        type="button"
        class="toolbar-btn"
        title="Заголовок 3 (H3)"
        aria-label="Заголовок 3"
        onclick={() => view && toggleHeading(view, 3)}
      >
        H3
      </button>
    </div>

    <div class="toolbar-divider" role="separator"></div>

    <div class="toolbar-group">
      <button
        type="button"
        class="toolbar-btn font-bold"
        title="Жирный (Ctrl+B)"
        aria-label="Жирный текст"
        onclick={() => view && toggleWrap(view, '**')}
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        class="toolbar-btn font-italic"
        title="Курсив (Ctrl+I)"
        aria-label="Курсивный текст"
        onclick={() => view && toggleWrap(view, '*')}
      >
        <em>I</em>
      </button>
      <button
        type="button"
        class="toolbar-btn"
        title="Вставить ссылку"
        aria-label="Вставить ссылку"
        onclick={() => view && insertLink(view)}
      >
        🔗
      </button>
    </div>

    <div class="toolbar-divider" role="separator"></div>

    <div class="toolbar-group">
      <button
        type="button"
        class="toolbar-btn"
        title="Маркированный список"
        aria-label="Маркированный список"
        onclick={() => view && toggleList(view, 'ul')}
      >
        •≡
      </button>
      <button
        type="button"
        class="toolbar-btn"
        title="Нумерованный список"
        aria-label="Нумерованный список"
        onclick={() => view && toggleList(view, 'ol')}
      >
        1.≡
      </button>
      <button
        type="button"
        class="toolbar-btn"
        title="Блок кода"
        aria-label="Блок кода"
        onclick={() => view && insertCodeBlock(view)}
      >
        &lt;/&gt;
      </button>
      <button
        type="button"
        class="toolbar-btn"
        title="Вставить изображение"
        aria-label="Вставить изображение"
        onclick={triggerFilePicker}
      >
        🖼️
      </button>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        class="hidden-file-input"
        bind:this={fileInputEl}
        onchange={handleFileSelected}
        style="display: none;"
      />
    </div>

    <div class="toolbar-divider" role="separator"></div>

    <div class="toolbar-group">
      <button
        type="button"
        class="toolbar-btn"
        title="Отменить (Ctrl+Z)"
        aria-label="Отменить действие"
        onclick={() => view && undo(view)}
      >
        ↩️
      </button>
      <button
        type="button"
        class="toolbar-btn"
        title="Повторить (Ctrl+Y)"
        aria-label="Повторить действие"
        onclick={() => view && redo(view)}
      >
        ↪️
      </button>
    </div>

    <!-- Spacer -->
    <div class="toolbar-spacer"></div>

    <!-- View Mode Toggles -->
    <div class="toolbar-group view-mode-toggles" role="group" aria-label="Режимы отображения">
      <button
        type="button"
        class="toolbar-btn mode-btn"
        class:active={currentViewMode === 'editor'}
        title="Только редактор"
        onclick={() => (currentViewMode = 'editor')}
      >
        Редактор
      </button>
      <button
        type="button"
        class="toolbar-btn mode-btn"
        class:active={currentViewMode === 'split'}
        title="Разделенный экран (рядом)"
        onclick={() => (currentViewMode = 'split')}
      >
        Рядом
      </button>
      <button
        type="button"
        class="toolbar-btn mode-btn"
        class:active={currentViewMode === 'preview'}
        title="Только предпросмотр"
        onclick={() => (currentViewMode = 'preview')}
      >
        Предпросмотр
      </button>
    </div>
  </header>

  <!-- Upload Notification Banner -->
  {#if isUploading}
    <div class="upload-status-banner">
      <span class="spinner-sm">⏳</span>
      <span>Загрузка изображения...</span>
    </div>
  {/if}
  {#if uploadError}
    <div class="upload-error-banner" role="alert">
      <span>❌ {uploadError}</span>
      <button type="button" class="close-btn" onclick={() => (uploadError = null)}>×</button>
    </div>
  {/if}

  <!-- Main Split / Single Panes Container -->
  <div class="editor-panes mode-{currentViewMode}">
    <!-- CodeMirror Editor Pane -->
    <div
      class="editor-pane"
      class:hidden={currentViewMode === 'preview'}
      bind:this={editorContainerEl}
    ></div>

    <!-- Live Markdown Preview Pane -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="preview-pane markdown-body"
      class:hidden={currentViewMode === 'editor'}
      onclick={handleCodeCopyClick}
      role="region"
      aria-label="Предпросмотр Markdown"
    >
      {#if previewData.html}
        {@html previewData.html}
      {:else}
        <div class="empty-preview-placeholder">
          <p>Предпросмотр появится здесь после ввода текста...</p>
        </div>
      {/if}
    </div>
  </div>

  {#if isDraggingOver}
    <div class="drop-overlay">
      <div class="drop-message">Перетащите изображение сюда для загрузки</div>
    </div>
  {/if}
</div>

<style>
  .codemirror-wrapper {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 500px;
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 8px;
    background: var(--bg-primary, #ffffff);
    overflow: hidden;
  }

  .codemirror-wrapper.drag-active {
    border-color: var(--accent-color, #2383e2);
  }

  .drop-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(35, 131, 226, 0.12);
    border: 2px dashed var(--accent-color, #2383e2);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    z-index: 10;
  }

  .drop-message {
    padding: 12px 24px;
    background: #ffffff;
    border-radius: 6px;
    font-weight: 600;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    color: var(--accent-color, #2383e2);
  }

  .editor-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 12px;
    background: var(--bg-secondary, #f7f6f3);
    border-bottom: 1px solid var(--border-color, #e0e0e0);
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .toolbar-divider {
    width: 1px;
    height: 20px;
    background: var(--border-color, #e0e0e0);
    margin: 0 4px;
  }

  .toolbar-spacer {
    flex: 1;
  }

  .toolbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    height: 28px;
    padding: 0 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text-primary, #37352f);
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .toolbar-btn:hover {
    background: rgba(0, 0, 0, 0.05);
  }

  .toolbar-btn:focus-visible {
    outline: 2px solid var(--accent-color, #2383e2);
  }

  .mode-btn {
    font-size: 12px;
    padding: 0 8px;
  }

  .mode-btn.active {
    background: var(--bg-primary, #ffffff);
    border-color: var(--border-color, #d0d0d0);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    font-weight: 600;
  }

  .upload-status-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #e8f4fd;
    color: #1a73e8;
    font-size: 13px;
    border-bottom: 1px solid #d2e3fc;
  }

  .upload-error-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: #fce8e6;
    color: #c5221f;
    font-size: 13px;
    border-bottom: 1px solid #fad2cf;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 16px;
    cursor: pointer;
    color: inherit;
  }

  .editor-panes {
    display: grid;
    flex: 1;
    min-height: 400px;
    position: relative;
    overflow: hidden;
  }

  /* Mode: Split side-by-side */
  .editor-panes.mode-split {
    grid-template-columns: 1fr 1fr;
  }

  /* Mode: Editor only */
  .editor-panes.mode-editor {
    grid-template-columns: 1fr;
  }

  /* Mode: Preview only */
  .editor-panes.mode-preview {
    grid-template-columns: 1fr;
  }

  .editor-pane {
    height: 100%;
    overflow: auto;
    border-right: 1px solid var(--border-color, #e0e0e0);
  }

  .editor-pane.hidden {
    display: none;
  }

  .preview-pane {
    height: 100%;
    overflow-y: auto;
    padding: 24px 32px;
    background: var(--bg-primary, #ffffff);
  }

  .preview-pane.hidden {
    display: none;
  }

  .empty-preview-placeholder {
    color: var(--text-muted, #787774);
    font-style: italic;
    padding: 32px 0;
    text-align: center;
  }

  /* Responsive Mobile Collapse: On narrow screens (< 768px), collapse Split to single pane */
  @media (max-width: 768px) {
    .editor-panes.mode-split {
      grid-template-columns: 1fr;
    }

    .editor-panes.mode-split .preview-pane {
      display: none; /* Mobile collapse to single pane */
    }

    .view-mode-toggles .mode-btn[title*="Разделенный"] {
      display: none; /* Hide Split toggle on narrow screen */
    }
  }
</style>
