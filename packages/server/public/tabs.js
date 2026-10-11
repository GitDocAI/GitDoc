/*
 * Tabs switcher for the SSG. Mirrors the dashboard's TabsNodeView
 * click-to-activate behavior. The HTML emitted by renderTiptap.tsx
 * marks the initial active tab with `.is-active` on its `<button
 * data-tab-index="N">` header and renders all bodies with
 * `data-tab-body="N"` (non-active ones hidden via inline display:none).
 *
 * Re-binds on `astro:page-load` so view-transition navigations don't
 * leave dead buttons behind.
 */
;(function () {
  function wire(block) {
    if (block.dataset.tabsWired === 'true') return
    block.dataset.tabsWired = 'true'
    var headers = block.querySelectorAll('[data-tab-index]')
    var bodies = block.querySelectorAll('[data-tab-body]')
    headers.forEach(function (h) {
      h.addEventListener('click', function () {
        var idx = h.getAttribute('data-tab-index')
        headers.forEach(function (x) {
          if (x.getAttribute('data-tab-index') === idx) x.classList.add('is-active')
          else x.classList.remove('is-active')
        })
        bodies.forEach(function (b) {
          b.style.display = b.getAttribute('data-tab-body') === idx ? '' : 'none'
        })
      })
    })
  }
  function wireAll() {
    document.querySelectorAll('[data-tabs-block]').forEach(wire)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireAll)
  } else {
    wireAll()
  }
  document.addEventListener('astro:page-load', wireAll)
})()
