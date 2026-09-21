/**
 * markdown.js — renders the Markdown that Novada's MCP tools return.
 *
 * Most tools answer in Markdown (headings, tables, fenced code, bullet lists),
 * so the chat and playground used to show the raw source as plain text. This
 * turns it into HTML.
 *
 * Globals:
 *   renderMarkdown(src)   — Markdown → HTML string
 *   looksLikeJson(src)    — true for a bare JSON payload, which should stay in
 *                           a <pre> instead of going through the renderer
 *
 * Security: tool output is untrusted (it carries scraped third-party content),
 * so every text run is HTML-escaped BEFORE any Markdown construct is turned
 * into a tag, no HTML from the source is ever passed through, and link hrefs
 * are restricted to http/https/mailto. `![alt](src)` renders as a link, not an
 * <img>: nothing in a tool response should be able to make the page fetch a
 * remote asset.
 *
 * The stylesheet is injected from here rather than living in shared.css because
 * chat.html is a standalone page that does not load shared.css — this way any
 * page gets both the renderer and its styles from one <script> tag.
 *
 * Supported: ATX headings, fenced code, pipe tables, ordered/unordered lists
 * (nested), blockquotes, thematic breaks, paragraphs, and inline code, bold,
 * italic, strikethrough, links and bare URLs. Deliberately not supported:
 * raw HTML, images, footnotes, setext headings, reference links.
 */

(function () {
  'use strict';

  /* ── escaping / sanitising ─────────────────────────────────────── */

  var ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return ENTITIES[c]; });
  }

  // Only these schemes become clickable. A javascript:/data:/vbscript: URL in
  // scraped output stays inert text.
  function safeHref(url) {
    var u = String(url).trim();
    return /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(u) ? u : null;
  }

  /* ── inline spans ──────────────────────────────────────────────── */

  // Code spans and links are lifted out into placeholders before the remaining
  // emphasis passes run, so emphasis markers inside a code span or a URL are
  // left alone. \u0000 is stripped from the input, so a placeholder can never
  // collide with real content.
  var MARK = '\u0000';

  function inline(src) {
    var slots = [];
    function slot(html) { slots.push(html); return MARK + (slots.length - 1) + MARK; }

    var s = String(src).replace(/`+([^`]+?)`+/g, function (_, code) {
      return slot('<code>' + esc(code) + '</code>');
    });

    s = esc(s);

    // Images first: ![alt](src) is a link, never an <img>.
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m, alt, url) {
      var href = safeHref(url);
      if (!href) return alt || m;
      return slot('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
        (alt || 'image') + '</a>');
    });

    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m, text, url) {
      var href = safeHref(url);
      if (!href) return m;
      return slot('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
        (text || href) + '</a>');
    });

    // Bare URLs — the trailing-punctuation trim keeps sentence periods and the
    // closing paren of "(see https://x.com/y)" out of the href.
    s = s.replace(/(^|[\s(<])(https?:\/\/[^\s<>"')]+)/g, function (m, pre, url) {
      var trimmed = url.replace(/[.,;:!?]+$/, '');
      var href = safeHref(trimmed);
      if (!href) return m;
      return pre + slot('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
        trimmed + '</a>') + url.slice(trimmed.length);
    });

    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
         .replace(/__([^_]+)__/g, '<strong>$1</strong>')
         .replace(/~~([^~]+)~~/g, '<del>$1</del>')
         // Single-marker emphasis only at a word boundary, so snake_case
         // identifiers and a*b stay literal.
         .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
         .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');

    return s.replace(new RegExp(MARK + '(\\d+)' + MARK, 'g'), function (_, n) { return slots[n]; });
  }

  /* ── block structure ───────────────────────────────────────────── */

  var FENCE_RE = /^ {0,3}(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/;
  var HEADING_RE = /^ {0,3}(#{1,6})\s+(.*)$/;
  var HR_RE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
  var QUOTE_RE = /^ {0,3}>\s?(.*)$/;
  var ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  var TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function isBlockStart(line) {
    return !line.trim() || FENCE_RE.test(line) || HEADING_RE.test(line) ||
      HR_RE.test(line) || QUOTE_RE.test(line) || ITEM_RE.test(line);
  }

  function cells(row) {
    return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
  }

  function alignments(sep) {
    return cells(sep).map(function (c) {
      if (/^:-+:$/.test(c)) return 'center';
      if (/^-+:$/.test(c)) return 'right';
      return null;
    });
  }

  function table(head, sep, rows) {
    var align = alignments(sep);
    function cell(tag, text, i) {
      var a = align[i] ? ' style="text-align:' + align[i] + '"' : '';
      var scope = tag === 'th' ? ' scope="col"' : '';
      return '<' + tag + scope + a + '>' + inline(text) + '</' + tag + '>';
    }
    var html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
      cells(head).map(function (c, i) { return cell('th', c, i); }).join('') +
      '</tr></thead>';
    if (rows.length) {
      html += '<tbody>' + rows.map(function (r) {
        return '<tr>' + cells(r).map(function (c, i) { return cell('td', c, i); }).join('') + '</tr>';
      }).join('') + '</tbody>';
    }
    return html + '</table></div>';
  }

  // Nested lists are rebuilt from the indent of each marker. A deeper level is
  // moved inside the preceding <li> (by dropping its just-emitted </li> and
  // restoring it when the level closes) so the markup stays valid. The </li> is
  // pushed as its own part precisely so it can be popped again.
  function list(items) {
    var parts = [];
    var stack = [];

    function open(indent, ordered, inLi) {
      stack.push({ indent: indent, ordered: ordered, inLi: inLi });
      parts.push(ordered ? '<ol class="md-list">' : '<ul class="md-list">');
    }
    function close() {
      var f = stack.pop();
      parts.push(f.ordered ? '</ol>' : '</ul>');
      if (f.inLi) parts.push('</li>');
      return f;
    }

    items.forEach(function (it) {
      while (stack.length && it.indent < stack[stack.length - 1].indent) close();
      var top = stack[stack.length - 1];
      if (!top || it.indent > top.indent) {
        var inLi = parts[parts.length - 1] === '</li>';
        if (inLi) parts.pop();
        open(it.indent, it.ordered, inLi);
      } else if (top.ordered !== it.ordered) {
        // '- a' followed by '1. b' at the same indent is two lists, not one.
        // The enclosing </li> (if any) is carried over to the new frame so it
        // is still emitted exactly once, when that frame closes.
        var f = stack.pop();
        parts.push(f.ordered ? '</ol>' : '</ul>');
        open(it.indent, it.ordered, f.inLi);
      }
      parts.push('<li>' + inline(it.text.join(' ')));
      parts.push('</li>');
    });

    while (stack.length) close();
    return parts.join('');
  }

  function renderMarkdown(src) {
    if (src === null || src === undefined) return '';
    var lines = String(src).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      var fence = line.match(FENCE_RE);
      if (fence) {
        var closeRe = new RegExp('^ {0,3}' + (fence[1][0] === '`' ? '```' : '~~~'));
        var code = [];
        i++;
        while (i < lines.length && !closeRe.test(lines[i])) { code.push(lines[i]); i++; }
        i++;  // consume the closing fence (missing one = code runs to the end)
        out.push('<pre class="md-pre"' + (fence[2] ? ' data-lang="' + esc(fence[2]) + '"' : '') +
          '><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }

      if (!line.trim()) { i++; continue; }

      if (HR_RE.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }

      var h = line.match(HEADING_RE);
      if (h) {
        var level = h[1].length;
        out.push('<h' + level + ' class="md-h md-h' + level + '">' +
          inline(h[2].replace(/\s+#+\s*$/, '')) + '</h' + level + '>');
        i++;
        continue;
      }

      // Pipe table: a header row followed by a |---|:--:| separator.
      if (line.indexOf('|') !== -1 && i + 1 < lines.length &&
          lines[i + 1].indexOf('-') !== -1 && TABLE_SEP_RE.test(lines[i + 1])) {
        var head = line, sep = lines[i + 1], rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) { rows.push(lines[i]); i++; }
        out.push(table(head, sep, rows));
        continue;
      }

      if (QUOTE_RE.test(line)) {
        var quoted = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) { quoted.push(lines[i].match(QUOTE_RE)[1]); i++; }
        out.push('<blockquote class="md-quote">' + renderMarkdown(quoted.join('\n')) + '</blockquote>');
        continue;
      }

      var item = line.match(ITEM_RE);
      if (item) {
        var items = [];
        while (i < lines.length) {
          var m = lines[i].match(ITEM_RE);
          if (m) {
            items.push({
              indent: m[1].replace(/\t/g, '    ').length,
              ordered: /\d/.test(m[2]),
              text: [m[3]],
            });
            i++;
          } else if (items.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i])) {
            items[items.length - 1].text.push(lines[i].trim());  // wrapped item text
            i++;
          } else break;
        }
        out.push(list(items));
        continue;
      }

      var para = [line];
      i++;
      while (i < lines.length && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
      // Single newlines inside a paragraph are kept as <br>: tool output uses
      // them for real line structure ("platform: x | operation: y" summaries),
      // not as soft wrapping.
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }

    return out.join('\n');
  }

  /** A bare JSON object/array — better shown as-is than pushed through Markdown. */
  function looksLikeJson(src) {
    var t = String(src === null || src === undefined ? '' : src).trim();
    return (t.charAt(0) === '{' || t.charAt(0) === '[') && t.length > 1;
  }

  /* ── styles ────────────────────────────────────────────────────── */

  var CSS = [
    '.md{white-space:normal;line-height:1.65;word-break:break-word;}',
    '.md>:first-child{margin-top:0;}',
    '.md>:last-child{margin-bottom:0;}',
    '.md p{margin:0 0 10px;}',
    '.md .md-h{font-weight:700;line-height:1.3;margin:18px 0 8px;}',
    '.md .md-h1{font-size:1.35em;}',
    '.md .md-h2{font-size:1.2em;}',
    '.md .md-h3{font-size:1.08em;}',
    '.md .md-h4,.md .md-h5,.md .md-h6{font-size:1em;}',
    // list-style is restated because a CSS reset (Tailwind's preflight, which
    // the chat and playground pages both load) strips markers from ul/ol.
    '.md .md-list{margin:0 0 10px;padding-left:22px;list-style-position:outside;}',
    '.md ul.md-list{list-style-type:disc;}',
    '.md ol.md-list{list-style-type:decimal;}',
    '.md ul.md-list ul.md-list{list-style-type:circle;}',
    '.md .md-list li{margin:3px 0;}',
    '.md .md-list .md-list{margin:3px 0 0;}',
    '.md a{color:#8b6cf0;text-decoration:underline;text-underline-offset:2px;}',
    '.md a:hover{opacity:.85;}',
    '.md strong{font-weight:700;}',
    '.md code{font-family:"IBM Plex Mono","JetBrains Mono",ui-monospace,monospace;',
    'font-size:.92em;padding:1px 5px;border-radius:4px;background:rgba(127,127,127,.2);}',
    '.md .md-pre{margin:0 0 12px;padding:12px 14px;border-radius:8px;overflow-x:auto;',
    // Translucent grey reads as "slightly offset from the surface" on both the
    // light playground panel and the dark chat thread, so the renderer needs no
    // theme-specific rules.
    'background:rgba(127,127,127,.16);border:1px solid rgba(127,127,127,.28);}',
    '.md .md-pre code{background:none;padding:0;font-size:12.5px;line-height:1.55;white-space:pre;}',
    '.md .md-table-wrap{margin:0 0 12px;overflow-x:auto;}',
    '.md .md-table{border-collapse:collapse;font-size:.95em;}',
    '.md .md-table th,.md .md-table td{border:1px solid rgba(127,127,127,.32);padding:6px 10px;',
    'text-align:left;vertical-align:top;}',
    '.md .md-table th{font-weight:650;background:rgba(127,127,127,.14);}',
    '.md .md-quote{margin:0 0 12px;padding:2px 0 2px 12px;border-left:3px solid rgba(108,64,226,.55);opacity:.92;}',
    '.md .md-hr{border:0;border-top:1px solid rgba(127,127,127,.32);margin:14px 0;}',
  ].join('');

  function injectStyles() {
    if (document.getElementById('md-styles')) return;
    var style = document.createElement('style');
    style.id = 'md-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  if (document.head) injectStyles();
  else document.addEventListener('DOMContentLoaded', injectStyles);

  window.renderMarkdown = renderMarkdown;
  window.looksLikeJson = looksLikeJson;
})();
