/**
 * Markdown Rendering & Strict Sanitization Pipeline for LabNotes.
 * Integrates markdown-it (html: false) with DOMPurify, H2/H3 TOC extraction,
 * copy buttons for code blocks, and responsive image/table wrappers.
 */

import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

// ============================================================================
// Types
// ============================================================================

export interface TocItem {
  level: 2 | 3;
  id: string;
  text: string;
}

export interface RenderResult {
  html: string;
  toc: TocItem[];
}

interface RenderEnv {
  toc: TocItem[];
  slugCounts: Record<string, number>;
}

// ============================================================================
// Unicode Slugifier
// ============================================================================

/**
 * Converts heading text to an academic URL-safe slug.
 * Supports Cyrillic (Russian), Latin letters, numbers, and hyphens.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s\-_]+/gu, '') // Keep Unicode letters, numbers, spaces, -, _
    .replace(/[\s_]+/g, '-')              // Replace spaces and underscores with hyphens
    .replace(/-+/g, '-')                  // Collapse consecutive hyphens
    .replace(/^-+|-+$/g, '') || 'heading';// Strip leading/trailing hyphens or fallback
}

/**
 * Generates an idempotent, unique slug for a heading within the current document render.
 */
function getUniqueSlug(text: string, env: RenderEnv): string {
  const base = slugify(text);
  const count = env.slugCounts[base] || 0;
  env.slugCounts[base] = count + 1;
  return count === 0 ? base : `${base}-${count}`;
}

// ============================================================================
// Markdown-It Engine Setup
// ============================================================================

const md = new MarkdownIt({
  html: false,       // STRICT: Disables raw HTML tags (<script>, <iframe>, etc. are escaped)
  xhtmlOut: false,
  breaks: true,      // Soft line breaks become <br>
  langPrefix: 'language-',
  linkify: true,     // Autoconvert URL-like text into [text](url)
  typographer: true, // Quotes, em-dashes, ellipses
});

// Custom Rule 1: H2 and H3 Headings -> Slug IDs & TOC Extraction
const defaultHeadingOpen =
  md.renderer.rules.heading_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.heading_open = function (tokens, idx, options, env: RenderEnv, self) {
  const token = tokens[idx];
  const level = parseInt(token.tag.slice(1), 10);

  if (level === 2 || level === 3) {
    const nextToken = tokens[idx + 1];
    const text = nextToken ? nextToken.content : '';
    const slug = getUniqueSlug(text, env);

    token.attrSet('id', slug);

    if (env.toc) {
      env.toc.push({
        level: level as 2 | 3,
        id: slug,
        text,
      });
    }
  }

  return defaultHeadingOpen(tokens, idx, options, env, self);
};

// Custom Rule 2: Code Blocks (Fences) -> Copy Button & Semantic Wrapper
md.renderer.rules.fence = function (tokens, idx, _options, _env, _self) {
  const token = tokens[idx];
  const info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
  const langName = info ? info.split(/\s+/g)[0] : '';
  const codeContent = md.utils.escapeHtml(token.content);

  const langClass = langName ? ` class="language-${md.utils.escapeHtml(langName)}"` : '';
  const langBadge = langName ? `<span class="code-lang-badge">${md.utils.escapeHtml(langName)}</span>` : '';

  return (
    `<div class="code-block-wrapper">` +
      `<div class="code-block-header">` +
        langBadge +
        `<button type="button" class="code-copy-btn" data-copy-btn="true" aria-label="Копировать код">` +
          `<span class="copy-icon" aria-hidden="true">📋</span>` +
          `<span class="copy-text">Копировать</span>` +
        `</button>` +
      `</div>` +
      `<pre><code${langClass}>${codeContent}</code></pre>` +
    `</div>\n`
  );
};

// Custom Rule 3: Images -> Lazy Loading, Lightbox Marker
const defaultImage =
  md.renderer.rules.image ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.image = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  token.attrSet('loading', 'lazy');
  token.attrSet('decoding', 'async');
  token.attrJoin('class', 'markdown-image');
  token.attrSet('data-lightbox', 'true');

  return defaultImage(tokens, idx, options, env, self);
};

// Custom Rule 4: Links -> External links open in new tab safely
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const hrefIdx = token.attrIndex('href');
  if (hrefIdx >= 0 && token.attrs) {
    const href = token.attrs[hrefIdx][1];
    if (/^https?:\/\//i.test(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Custom Rule 5: Tables -> Wrap in overflow-x scroll container
const defaultTableOpen =
  md.renderer.rules.table_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

const defaultTableClose =
  md.renderer.rules.table_close ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.table_open = function (tokens, idx, options, env, self) {
  return '<div class="table-wrapper">' + defaultTableOpen(tokens, idx, options, env, self);
};

md.renderer.rules.table_close = function (tokens, idx, options, env, self) {
  return defaultTableClose(tokens, idx, options, env, self) + '</div>';
};

// Custom Rule 6: Text Alignment & Academic Figure Captions
md.core.ruler.push('text_align', function (state) {
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type === 'paragraph_open' || token.type === 'heading_open') {
      const inlineToken = state.tokens[i + 1];
      if (inlineToken && inlineToken.type === 'inline' && inlineToken.children) {
        const text = inlineToken.content.trim();

        // 1. Center alignment marker: -> text <-
        if (/^->\s*.+?\s*<-$/.test(text)) {
          token.attrJoin('class', 'text-center');
          const first = inlineToken.children[0];
          if (first && first.type === 'text') {
            first.content = first.content.replace(/^\s*->\s*/, '');
          }
          const last = inlineToken.children[inlineToken.children.length - 1];
          if (last && last.type === 'text') {
            last.content = last.content.replace(/\s*<-\s*$/, '');
          }
        }
        // 2. Right alignment marker: -> text
        else if (/^->\s*.+/.test(text) && !text.endsWith('<-')) {
          token.attrJoin('class', 'text-right');
          const first = inlineToken.children[0];
          if (first && first.type === 'text') {
            first.content = first.content.replace(/^\s*->\s*/, '');
          }
        }
        // 3. Academic figure captions: "Рисунок 1...", "Рис. 1..."
        else if (token.type === 'paragraph_open' && /^\s*(?:Рисунок|Рис\.?)\s*\d+/i.test(text)) {
          token.attrJoin('class', 'caption-center');
        }
      }
    }
  }
});

// ============================================================================
// Strict DOMPurify Sanitization Options
// ============================================================================

const DOMPURIFY_CONFIG = {
  // Disallow any tag that could execute code or manipulate framing/metadata
  FORBID_TAGS: [
    'script',
    'iframe',
    'object',
    'embed',
    'base',
    'meta',
    'style',
    'form',
    'input',
    'textarea',
    'select',
    'link',
    'applet',
  ],

  // Disallow any event handler or inline styling
  FORBID_ATTR: [
    'style',
    'onerror',
    'onload',
    'onclick',
    'onmouseover',
    'onfocus',
    'onblur',
    'onmouseenter',
    'onmouseleave',
    'formaction',
    'action',
  ],

  // Permitted tags for rich academic typography
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'blockquote',
    'pre', 'code',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a', 'img',
    'strong', 'b', 'em', 'i', 'del', 's', 'sub', 'sup', 'mark',
    'div', 'span', 'button', 'center',
  ],

  // Permitted attributes
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title',
    'id', 'class',
    'target', 'rel',
    'loading', 'decoding',
    'type', 'aria-label', 'aria-hidden',
    'data-lightbox', 'data-copy-btn',
  ],

  // Extra attributes to explicitly permit on elements
  ADD_ATTR: ['loading', 'decoding', 'data-lightbox', 'data-copy-btn', 'target', 'rel'],

  // Prevent DOM clobbering attacks
  SANITIZE_DOM: true,

  // Return sanitized HTML string
  RETURN_DOM_FRAGMENT: false as const,
  RETURN_DOM: false as const,
};

function getPurifier(): any {
  if (DOMPurify && typeof DOMPurify.sanitize === 'function') {
    return DOMPurify;
  }
  if (typeof window !== 'undefined' && typeof DOMPurify === 'function') {
    try {
      const initialized = (DOMPurify as any)(window);
      if (initialized && typeof initialized.sanitize === 'function') {
        return initialized;
      }
    } catch {
      // Ignore initialization errors in unusual environments
    }
  }
  return null;
}

// Preprocess explicit HTML center/align tags into markdown alignment markers
function preprocessAlignment(source: string): string {
  return source
    .replace(/<center>([\s\S]*?)<\/center>/gi, (_match, inner) => {
      return inner
        .split('\n')
        .map((line: string) => (line.trim() ? `-> ${line.trim()} <-` : ''))
        .join('\n');
    })
    .replace(/<(?:div|p)\s+align=["']center["']>([\s\S]*?)<\/(?:div|p)>/gi, (_match, inner) => {
      return inner
        .split('\n')
        .map((line: string) => (line.trim() ? `-> ${line.trim()} <-` : ''))
        .join('\n');
    })
    .replace(/<(?:div|p)\s+align=["']right["']>([\s\S]*?)<\/(?:div|p)>/gi, (_match, inner) => {
      return inner
        .split('\n')
        .map((line: string) => (line.trim() ? `-> ${line.trim()}` : ''))
        .join('\n');
    });
}

// ============================================================================
// Public Markdown Pipeline Export
// ============================================================================

/**
 * Renders Markdown into safe, sanitized HTML and extracts H2/H3 Table of Contents.
 *
 * @param markdown - Raw Markdown string from database or draft editor.
 * @returns RenderResult containing safe `html` and structured `toc`.
 */
export function renderMarkdown(markdown: string): RenderResult {
  if (!markdown || !markdown.trim()) {
    return { html: '', toc: [] };
  }

  const env: RenderEnv = {
    toc: [],
    slugCounts: {},
  };

  // 1. Preprocess alignment tags and render through markdown-it
  const preprocessed = preprocessAlignment(markdown);
  const rawHtml = md.render(preprocessed, env);

  // 2. Pass through DOMPurify with strict XSS neutralization rules
  const purifier = getPurifier();
  const sanitizedHtml =
    purifier && typeof purifier.sanitize === 'function'
      ? ((purifier.sanitize(rawHtml, DOMPURIFY_CONFIG) as unknown) as string)
      : rawHtml;

  return {
    html: sanitizedHtml,
    toc: env.toc,
  };
}

// ============================================================================
// Event Delegation Helpers for Reader.svelte
// ============================================================================

/**
 * Attaches clipboard copy functionality to rendered code blocks via event delegation.
 */
export function handleCodeCopyClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const btn = target?.closest<HTMLButtonElement>('[data-copy-btn]');
  if (!btn) return;

  const wrapper = btn.closest('.code-block-wrapper');
  const codeEl = wrapper?.querySelector('pre code');
  if (!codeEl) return;

  const codeText = codeEl.textContent || '';

  const showCopiedFeedback = () => {
    const textSpan = btn.querySelector('.copy-text');
    const iconSpan = btn.querySelector('.copy-icon');
    if (textSpan) textSpan.textContent = 'Скопировано!';
    if (iconSpan) iconSpan.textContent = '✅';
    btn.classList.add('copied');

    setTimeout(() => {
      if (textSpan) textSpan.textContent = 'Копировать';
      if (iconSpan) iconSpan.textContent = '📋';
      btn.classList.remove('copied');
    }, 2000);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(codeText).then(
      () => {
        showCopiedFeedback();
      },
      () => {
        fallbackCopy(codeText, showCopiedFeedback);
      }
    );
  } else {
    fallbackCopy(codeText, showCopiedFeedback);
  }
}

function fallbackCopy(text: string, onSuccess: () => void): void {
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.width = '2em';
    textArea.style.height = '2em';
    textArea.style.padding = '0';
    textArea.style.border = 'none';
    textArea.style.outline = 'none';
    textArea.style.boxShadow = 'none';
    textArea.style.background = 'transparent';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    if (successful) {
      onSuccess();
    }
  } catch (err) {
    console.error('Fallback clipboard copy failed:', err);
  }
}
