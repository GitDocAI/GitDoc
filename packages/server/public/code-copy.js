/*
 * Copy-to-clipboard for SSG code blocks. Pairs with the
 * `[data-code-copy]` button rendered by `renderTiptap.tsx` inside
 * every `[data-code-block]` shell. Reads the text content from the
 * shell's <pre> (Shiki HTML preserves the original source as text
 * nodes inside spans, so `pre.innerText` returns the unhighlighted
 * source). Re-binds on `astro:page-load` for view-transition nav.
 */
;(function () {
  function wire(btn) {
    if (btn.dataset.copyWired === 'true') return
    btn.dataset.copyWired = 'true'
    btn.addEventListener('click', async () => {
      var shell = btn.closest('[data-code-block]')
      var pre = shell && shell.querySelector('pre')
      var text = pre ? pre.innerText : ''
      try {
        await navigator.clipboard.writeText(text)
        btn.classList.add('is-copied')
        setTimeout(function () {
          btn.classList.remove('is-copied')
        }, 1500)
      } catch (err) {
        console.warn('[code-copy] clipboard write failed', err)
      }
    })
  }
  function wireAll() {
    document.querySelectorAll('[data-code-copy]').forEach(wire)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireAll)
  } else {
    wireAll()
  }
  document.addEventListener('astro:page-load', wireAll)
})()
