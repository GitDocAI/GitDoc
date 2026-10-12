/**
 * Search palette — Cmd/Ctrl+K modal. Queries `/api/search` (the Worker
 * proxies to content-runtime over s2s) on each keystroke, debounced.
 *
 * Footer "Ask Assistant" button delegates to the assistant panel via
 * `window.__assistantSubmit` (declared in `/assistant-panel.js`).
 */
;(function () {
  if (typeof document === 'undefined') return

  /* SVG icons used inside dynamically rendered result rows. Inline
     widths/heights so we don't depend on (scoped) CSS to size them. */
  const HASH_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>'
  const ARROW_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>'

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function openPalette() {
    const root = document.querySelector('[data-search-palette]')
    if (!root) return
    root.setAttribute('data-open', 'true')
    root.setAttribute('aria-hidden', 'false')
    // Mirror aria-hidden with `inert` so the closed palette's input +
    // buttons leave the tab order / a11y tree (a hidden dialog with
    // focusable controls is an a11y error).
    root.inert = false
    const input = root.querySelector('[data-search-input]')
    if (input) setTimeout(() => input.focus(), 60)
  }

  function closePalette() {
    const root = document.querySelector('[data-search-palette]')
    if (!root) return
    root.setAttribute('data-open', 'false')
    root.setAttribute('aria-hidden', 'true')
    root.inert = true
  }

  function renderResults(results, query) {
    const list = document.querySelector('[data-search-results]')
    if (!list) return
    list.innerHTML = ''
    let activeIdx = 0
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const a = document.createElement('a')
      a.className = 'search-palette__result'
      a.href = r.href
      a.dataset.idx = String(i)
      if (i === activeIdx) a.dataset.active = 'true'
      a.innerHTML = `
        <span class="search-palette__result-icon">${HASH_ICON}</span>
        <div class="search-palette__result-crumb">${escapeHtml(r.breadcrumb || '')}</div>
        <div class="search-palette__result-title">${escapeHtml(r.title || '')}</div>
        <div class="search-palette__result-snippet">${escapeHtml(r.snippet || '')}</div>
        <span class="search-palette__result-arrow">${ARROW_ICON}</span>
      `
      list.appendChild(a)
    }
    /* Update the Ask Assistant footer label with the current query. */
    const ask = document.querySelector('[data-search-ask]')
    const askLabel = document.querySelector('[data-search-ask-label]')
    const palette = document.querySelector('[data-search-palette]')
    if (ask && askLabel && palette && palette.dataset.assistant === 'true') {
      const q = query.trim()
      if (q) {
        ask.hidden = false
        askLabel.textContent = `Can you tell me about ${q}?`
      } else {
        ask.hidden = true
      }
    }
  }

  function getActiveIdx(list) {
    const all = list.querySelectorAll('.search-palette__result')
    for (let i = 0; i < all.length; i++) {
      if (all[i].dataset.active === 'true') return i
    }
    return -1
  }

  function setActiveIdx(list, idx) {
    const all = list.querySelectorAll('.search-palette__result')
    if (all.length === 0) return
    const clamped = Math.max(0, Math.min(all.length - 1, idx))
    for (let i = 0; i < all.length; i++) {
      if (i === clamped) {
        all[i].dataset.active = 'true'
        /* Keep the row in view when navigating with the keyboard. */
        all[i].scrollIntoView({ block: 'nearest' })
      } else {
        all[i].removeAttribute('data-active')
      }
    }
  }

  /* Hybrid search over /api/search (Worker → content-runtime s2s). The
     server resolves org/doc from the host + gates private docs; we just
     send the query and render the ranked results. `path` is the entry's
     full URL, stamped into the search index at publish time. */
  let searchSeq = 0
  let searchTimer = null

  async function runSearch(query) {
    const q = query.trim()
    if (!q) {
      renderResults([], query)
      return
    }
    const seq = ++searchSeq
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, limit: 20 }),
      })
      if (seq !== searchSeq) return // superseded by a newer keystroke
      const data = res.ok ? await res.json().catch(() => ({})) : {}
      if (seq !== searchSeq) return
      const results = (data.results || []).map((r) => ({
        href: r.path || '/',
        breadcrumb: '',
        title: r.title || '',
        snippet: (r.highlights && r.highlights[0] ? r.highlights[0] : '').replace(/<\/?mark>/g, ''),
      }))
      renderResults(results, query)
    } catch {
      if (seq === searchSeq) renderResults([], query)
    }
  }

  function debouncedSearch(query) {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => runSearch(query), 300)
  }

  /* Click delegation — open on the existing data-search-trigger
     buttons, close on backdrop or close affordance, navigate via the
     keyboard. */
  document.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return

    if (target.closest('[data-search-trigger]')) {
      e.preventDefault()
      openPalette()
      return
    }
    if (target.closest('[data-search-close]')) {
      e.preventDefault()
      closePalette()
      return
    }
    /* Hand off the current query to the assistant chat panel. */
    if (target.closest('[data-search-ask-btn]')) {
      e.preventDefault()
      const input = document.querySelector('[data-search-input]')
      const query = input ? input.value.trim() : ''
      closePalette()
      if (query && typeof window.__assistantSubmit === 'function') {
        window.__assistantSubmit(query)
      }
      return
    }
  })

  /* Input wiring — debounced query to the search API on every keystroke. */
  document.addEventListener('input', (e) => {
    const target = e.target
    if (!(target instanceof HTMLInputElement)) return
    if (!target.matches('[data-search-input]')) return
    debouncedSearch(target.value)
  })

  /* Keyboard: ⌘K / Ctrl+K opens, ESC closes, ↑/↓ move selection,
     Enter visits the active result. */
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      openPalette()
      return
    }

    const root = document.querySelector('[data-search-palette]')
    if (!root || root.getAttribute('data-open') !== 'true') return

    if (e.key === 'Escape') {
      e.preventDefault()
      closePalette()
      return
    }

    const list = document.querySelector('[data-search-results]')
    if (!list) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(list, getActiveIdx(list) + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(list, getActiveIdx(list) - 1)
    } else if (e.key === 'Enter') {
      const idx = getActiveIdx(list)
      const all = list.querySelectorAll('.search-palette__result')
      const active = idx >= 0 ? all[idx] : all[0]
      if (active && active.href) {
        e.preventDefault()
        closePalette()
        window.location.href = active.href
      }
    }
  })
})()
