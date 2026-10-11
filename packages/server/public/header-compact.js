/**
 * Responsive density guard for the header.
 *
 * The "navbar_left" / "navbar_center" presets render every section
 * tab inline in the navbar. With enough sections (or a wide right
 * cluster of CTAs) the row stops fitting on desktop.
 *
 * Instead of swapping to the mobile layout, we progressively shrink
 * the chrome:
 *   1. Reset to no density (full pills + normal tab size).
 *   2. If it overflows → `data-header-density="compact"` collapses
 *      the search + Ask AI pills to icon-only.
 *   3. If it still overflows → `data-header-density="dense"` also
 *      tightens the inline tab list (font, padding, gap).
 *
 * Measurement runs at load, on resize, and via a ResizeObserver on
 * the header grid. Between density steps we wait one animation
 * frame so the layout actually reflects the applied size before
 * re-measuring.
 */
;(function () {
  if (typeof document === 'undefined') return

  const ATTR = 'data-header-density'
  const LEVELS = [null, 'compact', 'dense']
  /* Cushion between the cluster widths and the available row width.
     Accounts for the inter-column gaps of the grid and gives the
     row a little breathing space before we escalate. */
  const GAP = 48

  let ro = null
  let resizeBound = false
  let running = false
  let queued = false

  function getWrapper() {
    return document.querySelector('[data-arrangement]')
  }

  function getGrid() {
    return document.querySelector('[data-header-grid]')
  }

  function applyLevel(level) {
    const wrapper = getWrapper()
    if (!wrapper) return
    if (level) wrapper.setAttribute(ATTR, level)
    else wrapper.removeAttribute(ATTR)
  }

  function overflows() {
    const grid = getGrid()
    if (!grid) return false
    const left = grid.querySelector('[data-header-left]')
    const center = grid.querySelector('[data-header-center]')
    const right = grid.querySelector('[data-header-right]')
    /* scrollWidth reports the content's natural extent because every
       inline tab + right-cluster pill uses `whitespace-nowrap`. */
    const needed =
      (left ? left.scrollWidth : 0) +
      (center ? center.scrollWidth : 0) +
      (right ? right.scrollWidth : 0)
    return needed + GAP > grid.clientWidth
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }

  async function escalate() {
    /* Coalesce overlapping calls — the ResizeObserver and resize
       event both fire during a drag. Without coalescing they'd
       interleave and fight over the density attribute. */
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      do {
        queued = false
        const wrapper = getWrapper()
        if (!wrapper) return

        /* Below the desktop breakpoint the regular `lg:` Tailwind
           utilities already render the mobile chrome — no need to
           shrink anything. Clear the attr so the page doesn't stay
           locked in dense mode if the user shrinks past 1024px and
           then back up to a width where everything fits. */
        if (window.innerWidth < 1024) {
          applyLevel(null)
          continue
        }

        /* Walk the density ladder: reset, measure, escalate until it
           fits or we run out of levels. */
        for (let i = 0; i < LEVELS.length; i++) {
          applyLevel(LEVELS[i])
          await nextFrame()
          if (!overflows()) break
        }
      } while (queued)
    } finally {
      running = false
    }
  }

  function setup() {
    /* Tear down stale observers before re-attaching — the header DOM
       is swapped on Astro view-transitions, so the previous grid
       node is gone. */
    if (ro) {
      ro.disconnect()
      ro = null
    }

    const grid = getGrid()
    if (grid && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => escalate())
      ro.observe(grid)
    }

    if (!resizeBound) {
      window.addEventListener('resize', escalate)
      resizeBound = true
    }

    escalate()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup)
  } else {
    setup()
  }

  document.addEventListener('astro:page-load', setup)
})()
