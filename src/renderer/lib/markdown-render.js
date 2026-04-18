'use strict';

/**
 * Minimal, safe markdown-to-DOM renderer for release notes.
 *
 * Builds the output tree with document.createElement + textContent
 * only — never innerHTML — so any HTML (including <script>) in the
 * source becomes literal text.  Supports a deliberately narrow
 * subset of markdown that covers what we actually write in
 * changelog/*.md files:
 *
 *   - `## heading`          → <h4>
 *   - `### heading`         → <h5>
 *   - `- item` / `* item`   → <ul><li>
 *   - blank line            → paragraph break
 *   - `**bold**`            → <strong>
 *   - `` `code` ``          → <code>
 *   - `*italic*`            → <em>
 *   - `[text](url)`         → <a> (url shown as tooltip; not clickable)
 *
 * HTML comments, tables, <details>/<summary>, images and horizontal
 * rules are skipped — they appear in the release body but don't
 * belong in a small in-app preview.
 */

function isHtmlCommentStart(line) {
  return /^\s*<!--/.test(line);
}
function isHtmlCommentEnd(line) {
  return /-->/.test(line);
}
function isDetailsStart(line) {
  return /<details[\s>]/i.test(line);
}
function isDetailsEnd(line) {
  return /<\/details>/i.test(line);
}

/**
 * Append inline-formatted text to `el`.  Handles **bold**, *italic*,
 * `code`, and [link](url) — nested formatting is not supported.
 */
function appendInline(el, text) {
  // Token regex matches (in order of priority): bold, code, italic, link
  const regex = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\n]+\))|(\*[^*\n]+\*)/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const tok = match[0];
    let node;
    if (tok.startsWith('**')) {
      node = document.createElement('strong');
      node.textContent = tok.slice(2, -2);
    } else if (tok.startsWith('`')) {
      node = document.createElement('code');
      node.textContent = tok.slice(1, -1);
    } else if (tok.startsWith('[')) {
      // [text](url) — render as styled span so clicks don't navigate
      // inside the Electron renderer.  Users use the "View full
      // release notes" button to open the GitHub page.
      const closeBracket = tok.indexOf(']');
      const label = tok.slice(1, closeBracket);
      const url = tok.slice(closeBracket + 2, -1);
      node = document.createElement('span');
      node.className = 'md-link';
      node.textContent = label;
      node.title = url;
    } else {
      node = document.createElement('em');
      node.textContent = tok.slice(1, -1);
    }
    el.appendChild(node);
    lastIndex = match.index + tok.length;
  }
  if (lastIndex < text.length) {
    el.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

/**
 * Render markdown into `parentEl`, replacing its existing children.
 */
export function renderMarkdown(source, parentEl) {
  if (!parentEl) return;
  parentEl.innerHTML = '';
  if (!source) return;

  const lines = source.split('\n');
  let currentList = null;
  let currentPara = null;
  let skipMultiline = null; // 'comment' | 'details' | null

  const flushPara = () => {
    currentPara = null;
    currentList = null;
  };

  for (const rawLine of lines) {
    // Multi-line skip blocks (comments, details)
    if (skipMultiline === 'comment') {
      if (isHtmlCommentEnd(rawLine)) skipMultiline = null;
      continue;
    }
    if (skipMultiline === 'details') {
      if (isDetailsEnd(rawLine)) skipMultiline = null;
      continue;
    }
    if (isHtmlCommentStart(rawLine) && !isHtmlCommentEnd(rawLine)) {
      skipMultiline = 'comment';
      continue;
    }
    if (isDetailsStart(rawLine) && !isDetailsEnd(rawLine)) {
      skipMultiline = 'details';
      continue;
    }
    // Single-line HTML comment or details
    if (isHtmlCommentStart(rawLine) || isDetailsStart(rawLine)) continue;

    const line = rawLine.trimEnd();

    // Blank line — ends current paragraph/list
    if (!line.trim()) {
      flushPara();
      continue;
    }

    // Skip tables (lines starting with `|`) and horizontal rules
    if (/^\s*\|/.test(line) || /^---+\s*$/.test(line) || /^___+\s*$/.test(line)) {
      flushPara();
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{2,6})\s+(.+)$/);
    if (headingMatch) {
      flushPara();
      const level = headingMatch[1].length;
      const tag = level <= 2 ? 'h4' : 'h5';
      const h = document.createElement(tag);
      appendInline(h, headingMatch[2].trim());
      parentEl.appendChild(h);
      continue;
    }

    // List item
    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (listMatch) {
      currentPara = null;
      if (!currentList) {
        currentList = document.createElement('ul');
        parentEl.appendChild(currentList);
      }
      const li = document.createElement('li');
      appendInline(li, listMatch[1]);
      currentList.appendChild(li);
      continue;
    }

    // Blockquote — render as <p> with quote class
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushPara();
      const p = document.createElement('p');
      p.className = 'md-quote';
      appendInline(p, quoteMatch[1]);
      parentEl.appendChild(p);
      continue;
    }

    // Regular paragraph line — append to current para or start new
    currentList = null;
    if (!currentPara) {
      currentPara = document.createElement('p');
      parentEl.appendChild(currentPara);
    } else {
      currentPara.appendChild(document.createTextNode(' '));
    }
    appendInline(currentPara, line.trim());
  }
}
