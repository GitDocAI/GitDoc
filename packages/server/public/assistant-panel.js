/**
 * Assistant side-panel toggle.
 *
 * Single source of truth for the panel state — toggling `data-open`
 * on `[data-assistant-panel]`. CSS handles the slide-in animation and
 * (for `full-width` arrangement) the page wrapper's right padding via
 * `:has()`. ESC closes; clicks on the close button close.
 *
 * The panel element is `transition:persist`ed, so ClientRouter navigations
 * keep it (open/closed, messages, draft) instead of re-rendering it empty. The
 * transcript and open state are also kept in sessionStorage, so they survive
 * a full page load (a link that is not a client-side navigation, a reload).
 */
;(function () {
  if (typeof document === 'undefined') return

  /* Prior turns kept in memory so follow-up questions ("and how do I
     configure it?") carry context. Only the trailing window is sent to the
     backend; cleared with the conversation. */
  let conversation = []

  /* What the panel shows, kept in sessionStorage (per tab, gone when the tab
     closes): [{role: 'user'|'ai', text, sources?}] plus whether it is open. */
  const STORE_KEY = 'gitdocai.assistant.v1'
  let transcript = []
  let wasOpen = false
  function loadStore() {
    try {
      const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null')
      if (raw && Array.isArray(raw.items)) {
        transcript = raw.items.slice(-40)
        wasOpen = raw.open === true
      }
    } catch {}
  }
  function saveStore() {
    try {
      sessionStorage.setItem(
        STORE_KEY,
        JSON.stringify({ open: wasOpen, items: transcript.slice(-40) }),
      )
    } catch {}
  }
  loadStore()

  /* section_id → {href, title}, embedded once per page by [...all].astro.
     Resolves each answer's Sources to the section that supported it —
     see the KB landing's own (entry-level, more expensive) version for
     why this one stops at section granularity. */
  /* Read live: the sections JSON is per page and replaced on every
     ClientRouter swap, while this script (and the panel) persist. */
  function sectionsById() {
    const map = {}
    try {
      const el = document.querySelector('[data-assistant-sections]')
      if (el && el.textContent) {
        for (const s of JSON.parse(el.textContent)) map[s.id] = s
      }
    } catch {}
    return map
  }

  function openPanel() {
    const panel = document.querySelector('[data-assistant-panel]')
    if (!panel) return
    panel.setAttribute('data-open', 'true')
    panel.setAttribute('aria-hidden', 'false')
    // Mirror aria-hidden: a hidden dialog with focusable controls is an
    // a11y error. `inert` takes the children out of the tab order + a11y
    // tree while closed.
    panel.inert = false
    wasOpen = true
    saveStore()
    const textarea = panel.querySelector('[data-assistant-textarea]')
    if (textarea) setTimeout(() => textarea.focus(), 220)
  }

  function closePanel() {
    const panel = document.querySelector('[data-assistant-panel]')
    if (!panel) return
    panel.setAttribute('data-open', 'false')
    panel.setAttribute('aria-hidden', 'true')
    panel.inert = true
    wasOpen = false
    saveStore()
  }

  function toggleExpand() {
    const panel = document.querySelector('[data-assistant-panel]')
    if (!panel) return
    const expanded = panel.getAttribute('data-expanded') === 'true'
    panel.setAttribute('data-expanded', expanded ? 'false' : 'true')
  }

  function clearMessages() {
    const list = document.querySelector('[data-assistant-messages]')
    if (!list) return
    conversation = []
    transcript = []
    saveStore()
    list.innerHTML =
      '<div class="assistant-panel__empty"><p>Ask anything about the docs.</p><p class="assistant-panel__hint">Press <kbd>⌥I</kbd> to toggle this panel.</p></div>'
  }

  /* Markdown rendering is shared with the KB landing — see /md.js. Accessed
     lazily (only at render time, on user interaction) so load order between
     the two deferred scripts doesn't matter. */
  const escapeHtml = (s) => window.GitDocAIMarkdown.escapeHtml(s)
  const renderMarkdown = (t) => window.GitDocAIMarkdown.render(t)

  /* Inline icon SVGs for the AI message footer. We only ship a Copy
     button for now — thumbs/regenerate are noise without real backend
     wiring. The check icon flashes for ~1.5s after a successful copy. */
  const ICON = {
    copy:
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    check:
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  }

  const THINKING_HTML =
    '<div class="assistant-msg__body assistant-thinking" aria-live="polite" aria-label="Thinking">' +
    '<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>' +
    '</div>'

  /* Renders the "Sources" chip row under an answer — deduped by title
     (several chunks from the same page shouldn't repeat), each linking to
     the section that supported it. Returns '' when nothing resolved. */
  function renderSourcesHtml(sources) {
    if (!sources || !sources.length) return ''
    const seen = new Set()
    const chips = []
    const byId = sectionsById()
    for (const s of sources) {
      const key = s.title || s.section_id || ''
      if (!key || seen.has(key)) continue
      seen.add(key)
      const sec = s.section_id ? byId[s.section_id] : undefined
      const label = escapeHtml(s.title || sec?.title || 'Source')
      chips.push(
        sec?.href
          ? `<a class="assistant-source" href="${sec.href}">${label}</a>`
          : `<span class="assistant-source">${label}</span>`,
      )
    }
    if (!chips.length) return ''
    return `<div class="assistant-sources"><span class="assistant-sources__label">Sources</span>${chips.join('')}</div>`
  }

  function appendMessage(role, text, opts) {
    const list = document.querySelector('[data-assistant-messages]')
    if (!list) return
    /* Drop the empty state on the first real message. */
    const empty = list.querySelector('.assistant-panel__empty')
    if (empty) empty.remove()
    const el = document.createElement('div')
    el.className = `assistant-msg assistant-msg--${role}`

    if (role === 'ai' && opts && opts.pending) {
      el.innerHTML = THINKING_HTML
    } else if (role === 'ai') {
      /* AI reply: plain prose + a single Copy chip. The chip carries
         the message text on a data attribute so the click handler can
         read it without re-querying the DOM. */
      el.innerHTML = `
        <div class="assistant-msg__body">${renderMarkdown(text)}</div>
        <div class="assistant-msg__actions">
          <button type="button" class="assistant-msg__action" data-msg-copy aria-label="Copy reply" title="Copy reply"><span class="assistant-msg__action-icon">${ICON.copy}</span><span class="assistant-msg__action-label">Copy</span></button>
        </div>
        ${renderSourcesHtml(opts && opts.sources)}
      `
      const copyBtn = el.querySelector('[data-msg-copy]')
      if (copyBtn) copyBtn.setAttribute('data-msg-text', text)
      window.__gitdocaiRenderMermaid?.()
    } else {
      el.innerHTML = escapeHtml(text).replace(/\n/g, '<br>')
    }

    list.appendChild(el)
    /* Pin to the bottom so the latest exchange is in view. */
    list.scrollTop = list.scrollHeight
    return el
  }

  /* Swap a pending "Thinking…" message in place for the real answer —
     rebuilds the whole bubble since the pending state has no body/copy
     structure to patch in place. */
  function updateAiMessage(el, text, sources) {
    if (!el) return
    el.innerHTML = `
      <div class="assistant-msg__body">${renderMarkdown(text)}</div>
      <div class="assistant-msg__actions">
        <button type="button" class="assistant-msg__action" data-msg-copy aria-label="Copy reply" title="Copy reply"><span class="assistant-msg__action-icon">${ICON.copy}</span><span class="assistant-msg__action-label">Copy</span></button>
      </div>
      ${renderSourcesHtml(sources)}
    `
    const copyBtn = el.querySelector('[data-msg-copy]')
    if (copyBtn) copyBtn.setAttribute('data-msg-text', text)
    window.__gitdocaiRenderMermaid?.()
    const list = document.querySelector('[data-assistant-messages]')
    if (list) list.scrollTop = list.scrollHeight
  }

  async function submitQuestion(text) {
    const trimmed = text.trim()
    if (!trimmed) return
    openPanel()
    appendMessage('user', trimmed)
    transcript.push({ role: 'user', text: trimmed })
    saveStore()
    const pending = appendMessage('ai', '', { pending: true })
    /* Snapshot prior turns BEFORE this question; cap the window sent. */
    const history = conversation.slice(-8)
    /* Read live (not cached at load) so it reflects whichever version the
       visitor is actually on right now, including after a ClientRouter
       navigation to a different version's page. Pins RAG search to that
       version instead of searching across the whole doc's versions. */
    const versionId = document
      .querySelector('[data-assistant-panel]')
      ?.getAttribute('data-assistant-version-id') || undefined
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: trimmed, history, version_id: versionId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = data.error || 'Sorry, I could not answer that right now.'
        updateAiMessage(pending, msg)
        transcript.push({ role: 'ai', text: msg })
        saveStore()
        return
      }
      const answer = data.answer || 'No answer was returned.'
      updateAiMessage(pending, answer, data.sources)
      transcript.push({ role: 'ai', text: answer, sources: data.sources })
      saveStore()
      conversation.push({ role: 'user', content: trimmed })
      conversation.push({ role: 'assistant', content: answer })
    } catch {
      updateAiMessage(pending, 'Network error. Please try again.')
      transcript.push({ role: 'ai', text: 'Network error. Please try again.' })
      saveStore()
    }
  }

  /* Exposed for other islands (search palette, floating bar) so they
     can hand off a query to the same conversation surface. */
  window.__assistantSubmit = submitQuestion

  /* Global click delegation — survives ClientRouter swaps and matches
     the Ask AI button regardless of which preset rendered it. */
  document.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return

    if (target.closest('[data-ask-ai]')) {
      e.preventDefault()
      const panel = document.querySelector('[data-assistant-panel]')
      if (panel && panel.getAttribute('data-open') === 'true') closePanel()
      else openPanel()
      return
    }
    if (target.closest('[data-assistant-close]')) {
      e.preventDefault()
      closePanel()
      return
    }
    if (target.closest('[data-assistant-expand]')) {
      e.preventDefault()
      toggleExpand()
      return
    }
    if (target.closest('[data-assistant-clear]')) {
      e.preventDefault()
      clearMessages()
      return
    }

    /* Copy chip under each AI reply. Updates only the inner icon +
       label so the chip's pressed state stays smooth; restores after
       a short delay. */
    const copyBtn = target.closest('[data-msg-copy]')
    if (copyBtn) {
      e.preventDefault()
      const text = copyBtn.getAttribute('data-msg-text') ?? ''
      const iconSlot = copyBtn.querySelector('.assistant-msg__action-icon')
      const labelSlot = copyBtn.querySelector('.assistant-msg__action-label')
      const restore = () => {
        copyBtn.classList.remove('is-copied')
        if (iconSlot) iconSlot.innerHTML = ICON.copy
        if (labelSlot) labelSlot.textContent = 'Copy'
      }
      const flash = () => {
        copyBtn.classList.add('is-copied')
        if (iconSlot) iconSlot.innerHTML = ICON.check
        if (labelSlot) labelSlot.textContent = 'Copied'
        setTimeout(restore, 1500)
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(flash).catch(restore)
      } else {
        /* Older browsers fall back to a hidden textarea + execCommand. */
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy'); flash() } catch { restore() }
        document.body.removeChild(ta)
      }
      return
    }
  })

  /* Form submissions — the floating bar and the panel's own textarea
     share the same handler: open the panel (if needed), append the
     user message, append the canned AI reply, clear the input. */
  document.addEventListener('submit', (e) => {
    const form = e.target
    if (!(form instanceof HTMLFormElement)) return

    if (form.matches('[data-assistant-floating-form]')) {
      e.preventDefault()
      const input = form.querySelector('[data-assistant-floating-input]')
      if (!input) return
      submitQuestion(input.value)
      input.value = ''
      input.blur()
      return
    }

    if (form.matches('[data-assistant-form]')) {
      e.preventDefault()
      const textarea = form.querySelector('[data-assistant-textarea]')
      if (!textarea) return
      submitQuestion(textarea.value)
      textarea.value = ''
      return
    }
  })

  /* Enter on the panel's textarea submits (Shift+Enter inserts a
     newline). Mirrors the canonical chat-input UX. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    const target = e.target
    if (!(target instanceof HTMLTextAreaElement)) return
    if (!target.matches('[data-assistant-textarea]')) return
    e.preventDefault()
    submitQuestion(target.value)
    target.value = ''
  })

  /* ESC closes the panel. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const panel = document.querySelector('[data-assistant-panel]')
    if (panel && panel.getAttribute('data-open') === 'true') {
      e.preventDefault()
      closePanel()
    }
  })

  /* ⌥I shortcut to toggle the panel — matches the kbd hint shown in
     the Ask AI pill (and the panel's empty-state hint). */
  document.addEventListener('keydown', (e) => {
    if (!(e.altKey && (e.key === 'i' || e.key === 'I' || e.code === 'KeyI')))
      return
    const panel = document.querySelector('[data-assistant-panel]')
    if (!panel) return
    e.preventDefault()
    if (panel.getAttribute('data-open') === 'true') closePanel()
    else openPanel()
  })

  /* Put back what the visitor had: the transcript (when the panel is empty,
     e.g. after a full page load) and the open state. With the persisted
     panel, a ClientRouter navigation finds the messages already there and
     only the open state is re-applied. */
  function restore() {
    const panel = document.querySelector('[data-assistant-panel]')
    const list = document.querySelector('[data-assistant-messages]')
    if (!panel || !list) return
    if (transcript.length && !list.querySelector('.assistant-msg')) {
      for (const m of transcript) {
        appendMessage(m.role, m.text, m.role === 'ai' ? { sources: m.sources } : undefined)
      }
      conversation = transcript
        .filter((m) => !(m.role === 'ai' && /^(Sorry, I could not|Network error)/.test(m.text)))
        .map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text }))
    }
    if (wasOpen && panel.getAttribute('data-open') !== 'true') {
      panel.setAttribute('data-open', 'true')
      panel.setAttribute('aria-hidden', 'false')
      panel.inert = false
    }
  }

  /* The persisted panel keeps the previous page's attributes; the new page
     (still in the incoming document) knows which version it is on. */
  let nextVersionId
  document.addEventListener('astro:before-swap', (e) => {
    const incoming = e.newDocument && e.newDocument.querySelector('[data-assistant-panel]')
    nextVersionId = incoming ? incoming.getAttribute('data-assistant-version-id') : undefined
  })
  document.addEventListener('astro:after-swap', () => {
    const panel = document.querySelector('[data-assistant-panel]')
    if (!panel) return
    if (nextVersionId) panel.setAttribute('data-assistant-version-id', nextVersionId)
    else panel.removeAttribute('data-assistant-version-id')
  })

  document.addEventListener('astro:page-load', restore)
  restore()
})()
