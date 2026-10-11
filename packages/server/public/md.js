/**
 * Shared, dependency-free Markdown → HTML for AI replies. HTML is escaped so
 * raw model HTML never gets through, then a safe subset of Markdown + a few
 * rich blocks (aligned with docgen's COMPONENT_REFERENCE) are applied.
 * Underscore emphasis is intentionally NOT supported — it would mangle
 * snake_case identifiers common in technical docs.
 *
 * Rich blocks the assistant may emit (see the QA system prompt):
 *   - Callouts (GitHub alerts):  > [!TIP] / [!NOTE] / [!INFO] / [!WARNING] / [!DANGER]
 *   - Cards:  <Card title="…" icon="pi pi-star" href="…">body</Card>
 *   - GFM tables
 *   - Code fences (```lang); ```mermaid renders as a diagram via the page island
 *   - Inline images ![alt](https://…) — URLs only
 *   - Embedded video:  :::video https://youtu.be/…  (YouTube / Vimeo / Loom)
 *
 * Exposed on `window.GitDocAIMarkdown` so the assistant side-panel and the KB
 * landing render answers identically without bundling.
 */
;(function () {
  if (typeof window === 'undefined') return

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  const linkUrl = (url) => (/^(https?:|mailto:|\/)/i.test(url) ? url : '#')
  const imgUrl = (url) => (/^(https?:|\/)/i.test(url) ? url : '')

  // GitHub-alert type → our callout variant (docgen emits TIP/NOTE/INFO/WARNING/DANGER).
  const CALLOUT_ALIAS = {
    tip: 'tip', note: 'note', info: 'info', important: 'info',
    warning: 'warning', caution: 'warning', danger: 'danger', success: 'success',
  }

  function calloutIcon(type) {
    const a = '<svg class="gd-callout__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    switch (type) {
      case 'warning':
      case 'danger':
        return a + '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
      case 'tip':
        return a + '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>'
      case 'success':
        return a + '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
      default: // info / note
        return a + '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    }
  }

  // Only allowlisted providers get an iframe; anything else falls back to a link.
  function videoEmbed(rawUrl) {
    let src = ''
    try {
      const u = new URL(rawUrl)
      const host = u.hostname.replace(/^www\./, '')
      if (host === 'youtube.com' || host === 'm.youtube.com') {
        const id = u.searchParams.get('v')
        if (id) src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id)
      } else if (host === 'youtu.be') {
        const id = u.pathname.slice(1)
        if (id) src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id)
      } else if (host === 'vimeo.com') {
        const id = u.pathname.split('/').filter(Boolean)[0]
        if (id && /^\d+$/.test(id)) src = 'https://player.vimeo.com/video/' + id
      } else if (host === 'loom.com') {
        const parts = u.pathname.split('/').filter(Boolean)
        const id = parts[parts.length - 1]
        if (id) src = 'https://www.loom.com/embed/' + encodeURIComponent(id)
      }
    } catch {
      /* fall through to link */
    }
    if (src) {
      return `<div class="gd-md-video"><iframe src="${src}" frameborder="0" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`
    }
    const safe = linkUrl(rawUrl)
    return `<p><a href="${safe}" target="_blank" rel="noopener noreferrer">${escapeHtml(rawUrl)}</a></p>`
  }

  // <Card> renders to our own light card — icon classes are validated against
  // the icon libraries the site already loads (pi/fa/mi/hi). Extracted before
  // escaping (JSX angle-brackets would otherwise be mangled).
  function renderCard(attrs, body) {
    const get = (k) => {
      const m = attrs.match(new RegExp(k + '\\s*=\\s*"([^"]*)"'))
      return m ? m[1] : ''
    }
    const title = get('title')
    const iconRaw = get('icon').trim()
    const href = get('href')
    const icon = /^(pi pi-|fa fa-|mi-|hi-)[\w\- ]+$/.test(iconRaw)
      ? `<i class="gd-card__icon ${iconRaw}" aria-hidden="true"></i>`
      : ''
    const head = (icon || title)
      ? `<div class="gd-card__head">${icon}${title ? `<span class="gd-card__title">${escapeHtml(title)}</span>` : ''}</div>`
      : ''
    const inner = `${head}<div class="gd-card__body">${renderMarkdown(body.trim())}</div>`
    if (href) return `<a class="gd-card" href="${linkUrl(href)}">${inner}</a>`
    return `<div class="gd-card">${inner}</div>`
  }

  function renderInline(s) {
    const codeSpans = []
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      codeSpans.push(c)
      return `@@CODE${codeSpans.length - 1}@@`
    })
    // Images before links so the leading `!` isn't consumed by the link rule.
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
      const safe = imgUrl(url)
      return safe ? `<img class="gd-md-img" src="${safe}" alt="${alt}" loading="lazy">` : ''
    })
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      const safe = linkUrl(url)
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
    })
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    s = s.replace(/@@CODE(\d+)@@/g, (_, i) => `<code>${codeSpans[Number(i)]}</code>`)
    return s
  }

  const splitRow = (l) =>
    l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

  /* Operates on already-escaped lines (so callouts can recurse without
     double-escaping). `blocks` holds pre-extracted raw HTML (cards) keyed by
     @@BLOCK<n>@@ placeholders. */
  function renderBlocks(lines, blocks) {
    const out = []
    let listType = null
    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`)
        listType = null
      }
    }
    let i = 0
    while (i < lines.length) {
      const line = lines[i]

      // Pre-extracted block (e.g. a Card) — emit raw, not wrapped in <p>.
      if (/^@@BLOCK\d+@@$/.test(line.trim())) {
        closeList()
        out.push(line.trim())
        i++
        continue
      }

      // Embedded video — checked before the generic callout rule.
      const video = line.match(/^:::video\s+(\S+)\s*$/)
      if (video) {
        closeList()
        out.push(videoEmbed(video[1]))
        i++
        continue
      }

      // Fenced code (```lang); mermaid becomes a diagram node.
      const fence = line.match(/^```(\w*)/)
      if (fence) {
        closeList()
        const lang = (fence[1] || '').toLowerCase()
        const code = []
        i++
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          code.push(lines[i])
          i++
        }
        i++
        out.push(
          lang === 'mermaid'
            ? `<pre class="mermaid">${code.join('\n')}</pre>`
            : `<pre><code>${code.join('\n')}</code></pre>`
        )
        continue
      }

      // Blockquotes / GitHub-style callouts. `>` was escaped to `&gt;`.
      // Allow leading whitespace before `&gt;` — LLMs sometimes copy the
      // indentation of bullet-item examples in the system prompt and emit
      // `  > [!WARNING]`, which used to fall through to paragraph rendering.
      // Also strip ALL whitespace after `&gt;` (not just one space) so
      // double-spaced markers like `>  [!TIP]` still match the alert regex.
      if (/^\s*&gt;/.test(line)) {
        closeList()
        const quoted = []
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*&gt;\s*/, ''))
          i++
        }
        // Find the first non-empty quoted line for the [!TYPE] probe — some
        // models emit a blank `>` before the marker. Trailing `:` on the
        // marker (e.g. `[!WARNING]:`) is also tolerated since it's a common
        // variation outside the strict GitHub spec.
        const firstIdx = quoted.findIndex((q) => q.trim().length > 0)
        const probe = firstIdx >= 0 ? quoted[firstIdx] : ''
        const alert = probe.match(/^\[!(\w+)\]:?\s*$/i)
        if (alert) {
          const type = CALLOUT_ALIAS[alert[1].toLowerCase()] || 'note'
          out.push(
            `<div class="gd-callout gd-callout--${type}">${calloutIcon(type)}<div class="gd-callout__body">${renderBlocks(quoted.slice(firstIdx + 1), blocks)}</div></div>`
          )
        } else {
          out.push(`<blockquote>${renderBlocks(quoted, blocks)}</blockquote>`)
        }
        continue
      }

      // GFM table — header row followed by a |---|---| separator.
      if (
        line.includes('|') &&
        i + 1 < lines.length &&
        /^[\s|:-]+$/.test(lines[i + 1]) &&
        lines[i + 1].includes('-')
      ) {
        closeList()
        const header = splitRow(line)
        i += 2
        const rows = []
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(splitRow(lines[i]))
          i++
        }
        let html = '<div class="gd-md-table-wrap"><table class="gd-md-table"><thead><tr>'
        for (const h of header) html += `<th>${renderInline(h)}</th>`
        html += '</tr></thead><tbody>'
        for (const r of rows) {
          html += '<tr>'
          for (let c = 0; c < header.length; c++) html += `<td>${renderInline(r[c] ?? '')}</td>`
          html += '</tr>'
        }
        html += '</tbody></table></div>'
        out.push(html)
        continue
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/)
      if (h) {
        closeList()
        const lvl = Math.min(h[1].length, 4)
        out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`)
        i++
        continue
      }
      if (/^(---|\*\*\*|___)\s*$/.test(line)) {
        closeList()
        out.push('<hr>')
        i++
        continue
      }
      const ul = line.match(/^\s*[-*+]\s+(.*)$/)
      if (ul) {
        if (listType !== 'ul') {
          closeList()
          out.push('<ul>')
          listType = 'ul'
        }
        out.push(`<li>${renderInline(ul[1])}</li>`)
        i++
        continue
      }
      const ol = line.match(/^\s*\d+\.\s+(.*)$/)
      if (ol) {
        if (listType !== 'ol') {
          closeList()
          out.push('<ol>')
          listType = 'ol'
        }
        out.push(`<li>${renderInline(ol[1])}</li>`)
        i++
        continue
      }
      if (line.trim() === '') {
        closeList()
        i++
        continue
      }
      closeList()
      const para = [line]
      i++
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^@@BLOCK\d+@@$/.test(lines[i].trim()) &&
        !/^```/.test(lines[i]) &&
        !/^:::/.test(lines[i]) &&
        !/^\s*&gt;/.test(lines[i]) &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !/^\s*[-*+]\s/.test(lines[i]) &&
        !/^\s*\d+\.\s/.test(lines[i]) &&
        !/^(---|\*\*\*|___)\s*$/.test(lines[i])
      ) {
        para.push(lines[i])
        i++
      }
      out.push(`<p>${renderInline(para.join('<br>'))}</p>`)
    }
    closeList()
    return out.join('\n')
  }

  function renderMarkdown(text) {
    // Pull JSX cards out before escaping (their angle-brackets/attrs would be
    // mangled otherwise), leaving placeholders the block parser passes through.
    const blocks = []
    const pre = text.replace(/<Card\b([^>]*)>([\s\S]*?)<\/Card>/g, (_, attrs, body) => {
      blocks.push(renderCard(attrs, body))
      return `\n@@BLOCK${blocks.length - 1}@@\n`
    })
    const html = renderBlocks(escapeHtml(pre).split('\n'), blocks)
    return html.replace(/@@BLOCK(\d+)@@/g, (_, i) => blocks[Number(i)] ?? '')
  }

  window.GitDocAIMarkdown = { render: renderMarkdown, escapeHtml: escapeHtml }
})()
