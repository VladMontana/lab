/**
 * Formatting helper utilities for CodeMirror 6 Markdown Editor.
 * Operates on EditorView and provides pure text manipulation functions.
 */

import type { EditorView } from '@codemirror/view';

/**
 * Toggles bold or italic markers around selection or at cursor.
 * @param view - CodeMirror EditorView instance
 * @param marker - Marker string ('**' for bold, '*' for italic)
 */
export function toggleWrap(view: EditorView, marker: string): void {
  const { state } = view;
  const { from, to, empty } = state.selection.main;
  const markerLen = marker.length;

  if (empty) {
    // Empty selection: insert marker + marker and place cursor in the middle
    // e.g. for bold: **** with cursor between ** and **
    view.dispatch({
      changes: { from, insert: `${marker}${marker}` },
      selection: { anchor: from + markerLen },
    });
    view.focus();
    return;
  }

  const selText = state.sliceDoc(from, to);

  // Check if selection itself starts and ends with marker
  if (selText.startsWith(marker) && selText.endsWith(marker) && selText.length >= markerLen * 2) {
    const inner = selText.slice(markerLen, selText.length - markerLen);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
  } else {
    // Check if the surrounding text is already wrapped with marker
    const before = state.sliceDoc(Math.max(0, from - markerLen), from);
    const after = state.sliceDoc(to, Math.min(state.doc.length, to + markerLen));
    if (before === marker && after === marker) {
      view.dispatch({
        changes: [
          { from: to, to: to + markerLen, insert: '' },
          { from: from - markerLen, to: from, insert: '' },
        ],
        selection: { anchor: from - markerLen, head: to - markerLen },
      });
    } else {
      // Wrap selection
      view.dispatch({
        changes: { from, to, insert: `${marker}${selText}${marker}` },
        selection: { anchor: from + markerLen, head: to + markerLen },
      });
    }
  }
  view.focus();
}

/**
 * Toggles heading level (1, 2, or 3) on current line(s).
 */
export function toggleHeading(view: EditorView, level: 1 | 2 | 3): void {
  const { state } = view;
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const prefix = '#'.repeat(level) + ' ';
  const lineText = line.text;

  const match = lineText.match(/^(#{1,6}\s*)/);
  if (match) {
    const existingPrefix = match[1];
    if (existingPrefix.trim() === '#'.repeat(level)) {
      // Toggle off: strip existing heading
      view.dispatch({
        changes: { from: line.from, to: line.from + existingPrefix.length, insert: '' },
      });
    } else {
      // Replace with new level
      view.dispatch({
        changes: { from: line.from, to: line.from + existingPrefix.length, insert: prefix },
      });
    }
  } else {
    // Prepend heading
    view.dispatch({
      changes: { from: line.from, insert: prefix },
    });
  }
  view.focus();
}

/**
 * Inserts or wraps a link [text](url).
 */
export function insertLink(view: EditorView): void {
  const { state } = view;
  const { from, to, empty } = state.selection.main;
  if (empty) {
    const template = '[текст ссылки](https://)';
    view.dispatch({
      changes: { from, insert: template },
      selection: { anchor: from + 1, head: from + 13 },
    });
  } else {
    const selText = state.sliceDoc(from, to);
    if (/^https?:\/\//i.test(selText)) {
      view.dispatch({
        changes: { from, to, insert: `[описание](${selText})` },
        selection: { anchor: from + 1, head: from + 9 },
      });
    } else {
      view.dispatch({
        changes: { from, to, insert: `[${selText}](https://)` },
        selection: { anchor: to + 3, head: to + 11 },
      });
    }
  }
  view.focus();
}

/**
 * Inserts or wraps a code block ```lang ... ```.
 */
export function insertCodeBlock(view: EditorView): void {
  const { state } = view;
  const { from, to, empty } = state.selection.main;
  if (empty) {
    const template = '```\n\n```';
    view.dispatch({
      changes: { from, insert: template },
      selection: { anchor: from + 4 },
    });
  } else {
    const selText = state.sliceDoc(from, to);
    const wrapped = `\`\`\`\n${selText}\n\`\`\``;
    view.dispatch({
      changes: { from, to, insert: wrapped },
      selection: { anchor: from + 4, head: from + 4 + selText.length },
    });
  }
  view.focus();
}

/**
 * Toggles unordered or ordered lists on selected line(s).
 */
export function toggleList(view: EditorView, type: 'ul' | 'ol'): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);

  const changes = [];
  for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
    const line = state.doc.line(lineNum);
    const text = line.text;
    const prefix = type === 'ul' ? '- ' : `${lineNum - startLine.number + 1}. `;

    const ulMatch = text.match(/^[-*]\s+/);
    const olMatch = text.match(/^\d+\.\s+/);

    if (type === 'ul' && ulMatch) {
      changes.push({ from: line.from, to: line.from + ulMatch[0].length, insert: '' });
    } else if (type === 'ol' && olMatch) {
      changes.push({ from: line.from, to: line.from + olMatch[0].length, insert: '' });
    } else if (ulMatch) {
      changes.push({ from: line.from, to: line.from + ulMatch[0].length, insert: prefix });
    } else if (olMatch) {
      changes.push({ from: line.from, to: line.from + olMatch[0].length, insert: prefix });
    } else {
      changes.push({ from: line.from, insert: prefix });
    }
  }
  view.dispatch({ changes });
  view.focus();
}

/**
 * Inserts markdown image syntax ![alt](url) at cursor or replaces selection.
 */
export function insertImage(view: EditorView, alt: string = 'Описание изображения', url: string = '/media/UUID'): void {
  const { state } = view;
  const { from, to, empty } = state.selection.main;
  const effectiveAlt = empty ? alt : state.sliceDoc(from, to);
  const template = `![${effectiveAlt}](${url})`;
  view.dispatch({
    changes: { from, to, insert: template },
    selection: { anchor: from + template.length },
  });
  view.focus();
}

/**
 * Toggles center alignment markers (-> text <-) on current line or selection.
 */
export function toggleCenter(view: EditorView): void {
  const { state } = view;
  const { from, to, empty } = state.selection.main;

  if (empty) {
    const line = state.doc.lineAt(from);
    const text = line.text;
    const match = text.match(/^\s*->\s*(.*?)\s*<-\s*$/);
    if (match) {
      // Toggle off: remove -> and <-
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: match[1] },
      });
    } else {
      // Toggle on: wrap line
      const trimmed = text.trim();
      const insert = trimmed ? `-> ${trimmed} <-` : '->  <-';
      view.dispatch({
        changes: { from: line.from, to: line.to, insert },
        selection: { anchor: trimmed ? line.from + insert.length : line.from + 3 },
      });
    }
  } else {
    const selText = state.sliceDoc(from, to);
    const match = selText.match(/^\s*->\s*(.*?)\s*<-\s*$/);
    if (match) {
      view.dispatch({
        changes: { from, to, insert: match[1] },
        selection: { anchor: from, head: from + match[1].length },
      });
    } else {
      const insert = `-> ${selText.trim()} <-`;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from, head: from + insert.length },
      });
    }
  }
  view.focus();
}
