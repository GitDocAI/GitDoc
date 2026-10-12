/**
 * Image lightbox hydration island — matches publish-web's
 * `ExpandedImageModal` behavior:
 *
 *   - wheel zoom (0.25 step, range 0.5x..4x)
 *   - drag-to-pan while zoomed
 *   - +/-/0 keyboard shortcuts
 *   - on-screen zoom buttons + scale readout
 *   - Esc / click-outside / × button to close
 *
 * Plain vanilla JS, no framework, loaded as a static asset so the
 * article HTML renders JS-free and interactivity layers on top.
 */
;(function () {
  if (typeof document === 'undefined') return

  const MIN_SCALE = 0.5
  const MAX_SCALE = 4
  const STEP = 0.25

  /* Styles live in src/lightbox.css (imported by BaseLayout) so they
     survive Astro ClientRouter view transitions. The previous
     approach — injecting <style> from JS — was wiped on every nav.
     The block below is left here as a dead branch + reference; the
     real CSS rules are in lightbox.css. */
  if (false) { // eslint-disable-line
    const style = document.createElement('style')
    /* eslint-disable */
    void `
dialog.lightbox-overlay {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: rgba(0, 0, 0, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
  animation: lightbox-fade 0.15s ease-out;
  overflow: hidden;
  touch-action: none;
  color: white;
}
dialog.lightbox-overlay::backdrop { display: none; }
.lightbox-overlay img {
  max-width: 95vw;
  max-height: 90vh;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  cursor: grab;
  user-select: none;
  -webkit-user-drag: none;
  transition: transform 0.05s linear;
  will-change: transform;
}
.lightbox-overlay img.dragging { cursor: grabbing; transition: none; }
.lightbox-overlay .lightbox-toolbar {
  position: absolute;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(8px);
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: white;
  font: 13px/1 system-ui, -apple-system, sans-serif;
  cursor: default;
}
.lightbox-overlay .lightbox-toolbar button {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: 0;
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.lightbox-overlay .lightbox-toolbar button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.2);
}
.lightbox-overlay .lightbox-toolbar button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.lightbox-overlay .lightbox-toolbar .lightbox-scale {
  min-width: 48px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.lightbox-overlay .lightbox-close {
  position: absolute;
  top: 18px;
  right: 18px;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 0;
  background: rgba(255, 255, 255, 0.12);
  color: white;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.lightbox-overlay .lightbox-close:hover { background: rgba(255, 255, 255, 0.22); }
@keyframes lightbox-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
body.lightbox-open { overflow: hidden; }
`
    /* eslint-enable */
    void style
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n))
  }

  function open(src, alt) {
    /* Use a real <dialog> + showModal() so the browser puts the
       element in the top layer — above all stacking contexts, and
       unaffected by transforms on ancestors. */
    const overlay = document.createElement('dialog')
    overlay.className = 'lightbox-overlay'
    overlay.setAttribute('aria-label', alt || 'Image preview')

    const img = document.createElement('img')
    img.src = src
    if (alt) img.alt = alt
    img.draggable = false

    const close = document.createElement('button')
    close.className = 'lightbox-close'
    close.setAttribute('aria-label', 'Close')
    close.type = 'button'
    close.innerHTML = '&times;'

    const toolbar = document.createElement('div')
    toolbar.className = 'lightbox-toolbar'
    const btnOut = document.createElement('button')
    btnOut.type = 'button'
    btnOut.setAttribute('aria-label', 'Zoom out')
    btnOut.textContent = '−'
    const scaleLabel = document.createElement('span')
    scaleLabel.className = 'lightbox-scale'
    const btnReset = document.createElement('button')
    btnReset.type = 'button'
    btnReset.setAttribute('aria-label', 'Reset zoom')
    btnReset.textContent = '⟲'
    btnReset.style.fontSize = '14px'
    const btnIn = document.createElement('button')
    btnIn.type = 'button'
    btnIn.setAttribute('aria-label', 'Zoom in')
    btnIn.textContent = '+'
    toolbar.append(btnOut, scaleLabel, btnReset, btnIn)

    overlay.append(close, img, toolbar)
    document.body.appendChild(overlay)
    document.body.classList.add('lightbox-open')
    if (typeof overlay.showModal === 'function') {
      overlay.showModal()
    } else {
      /* Safari < 15.4 fallback — pretend modal via `open` attr. */
      overlay.setAttribute('open', '')
    }

    let scale = 1
    let x = 0
    let y = 0
    let dragging = false
    let dragStartX = 0
    let dragStartY = 0

    function apply() {
      if (scale <= 1) {
        x = 0
        y = 0
      }
      img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
      img.style.cursor = scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default'
      scaleLabel.textContent = `${Math.round(scale * 100)}%`
      btnOut.disabled = scale <= MIN_SCALE
      btnIn.disabled = scale >= MAX_SCALE
    }
    apply()

    function setScale(next) {
      scale = clamp(next, MIN_SCALE, MAX_SCALE)
      apply()
    }

    /* Wheel zoom — preventDefault keeps the page underneath from
       scrolling while the lightbox is open. */
    function onWheel(e) {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -STEP : STEP
      setScale(scale + delta)
    }
    overlay.addEventListener('wheel', onWheel, { passive: false })

    /* Drag-to-pan when zoomed in. */
    function onMouseDown(e) {
      if (scale <= 1) return
      if (e.target !== img) return
      e.preventDefault()
      dragging = true
      img.classList.add('dragging')
      dragStartX = e.clientX - x
      dragStartY = e.clientY - y
    }
    function onMouseMove(e) {
      if (!dragging) return
      x = e.clientX - dragStartX
      y = e.clientY - dragStartY
      img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    }
    function onMouseUp() {
      if (!dragging) return
      dragging = false
      img.classList.remove('dragging')
      apply()
    }
    img.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    /* Stop image click from closing the overlay; keep close on the
       overlay background. */
    img.addEventListener('click', (e) => e.stopPropagation())

    function onKey(e) {
      if (e.key === 'Escape') {
        dispose()
      } else if (e.key === '+' || e.key === '=') {
        setScale(scale + STEP)
      } else if (e.key === '-') {
        setScale(scale - STEP)
      } else if (e.key === '0') {
        setScale(1)
      }
    }
    document.addEventListener('keydown', onKey)

    btnIn.addEventListener('click', (e) => { e.stopPropagation(); setScale(scale + STEP) })
    btnOut.addEventListener('click', (e) => { e.stopPropagation(); setScale(scale - STEP) })
    btnReset.addEventListener('click', (e) => { e.stopPropagation(); setScale(1) })
    /* Clicks on the toolbar shouldn't bubble to overlay (which closes). */
    toolbar.addEventListener('click', (e) => e.stopPropagation())

    close.addEventListener('click', dispose)
    overlay.addEventListener('click', dispose)

    function dispose() {
      if (typeof overlay.close === 'function') {
        try { overlay.close() } catch { /* ignore */ }
      }
      overlay.remove()
      document.body.classList.remove('lightbox-open')
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keydown', onKey)
    }

    /* `<dialog>` fires `cancel` when Esc is pressed — preventDefault
       lets our own Esc handler run instead (so we don't double-close). */
    overlay.addEventListener('cancel', (e) => {
      e.preventDefault()
      dispose()
    })
  }

  /* Event delegation — also works after Astro view transitions
     replace the DOM. */
  document.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return
    const link = target.closest('a[data-lightbox]')
    if (!link) return
    e.preventDefault()
    const href = link.getAttribute('href')
    if (!href) return
    const img = link.querySelector('img')
    open(href, img ? img.getAttribute('alt') || undefined : undefined)
  })
})()
