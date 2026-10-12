/**
 * Mobile sidebar drawer toggle.
 *
 * Below 1024px the sidebar becomes a slide-in drawer. This script
 * flips `data-sidebar-open` on the page wrapper (whichever element
 * carries `[data-arrangement]`) so the CSS in sidebar.css can drive
 * the transform + backdrop visibility.
 *
 * Both the hamburger button and the backdrop carry
 * `[data-sidebar-toggle]` — clicking either flips the state.
 * Closes on ESC and after route navigation.
 */
;(function () {
  if (typeof document === 'undefined') return

  function getWrapper() {
    return document.querySelector('[data-arrangement]')
  }

  function isOpen() {
    const w = getWrapper()
    return w?.getAttribute('data-sidebar-open') === 'true'
  }

  function open() {
    const w = getWrapper()
    if (!w) return
    w.setAttribute('data-sidebar-open', 'true')
    /* Lock body scroll while the drawer is open so the backdrop
       behaves like a true modal layer. */
    document.documentElement.style.overflow = 'hidden'
  }

  function close() {
    const w = getWrapper()
    if (!w) return
    w.setAttribute('data-sidebar-open', 'false')
    document.documentElement.style.overflow = ''
  }

  function toggle() {
    if (isOpen()) close()
    else open()
  }

  /* Single delegated click handler — survives ClientRouter swaps.
     Handles both the sidebar drawer and the navbar's mobile kebab
     dropdown since they share the same lifecycle (open/close on
     mobile only, survive navigation). */
  document.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return
    if (target.closest('[data-sidebar-toggle]')) {
      e.preventDefault()
      toggle()
      return
    }

    /* Kebab toggle — flips a `hidden` class on the dropdown content. */
    const kebab = target.closest('[data-cta-menu-toggle]')
    if (kebab) {
      e.preventDefault()
      const menu = kebab.closest('[data-cta-menu]')?.querySelector('[data-cta-menu-content]')
      if (menu) menu.classList.toggle('hidden')
      /* Toggling `flex` so the dropdown lays out vertically; the
         baseline class includes `flex-col`. */
      if (menu) menu.classList.toggle('flex')
      return
    }

    /* Click outside the menu closes it. */
    const openMenu = document.querySelector('[data-cta-menu-content].flex')
    if (openMenu && !target.closest('[data-cta-menu]')) {
      openMenu.classList.remove('flex')
      openMenu.classList.add('hidden')
    }
  })

  function closeKebab() {
    const menu = document.querySelector('[data-cta-menu-content]')
    if (menu) {
      menu.classList.remove('flex')
      menu.classList.add('hidden')
    }
  }

  /* ESC closes the drawer + kebab. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (isOpen()) {
      e.preventDefault()
      close()
    }
    closeKebab()
  })

  /* Auto-close after Astro view-transition navigation — the new page
     would otherwise still show the drawer/kebab open even though
     the user selected something. */
  document.addEventListener('astro:after-swap', () => {
    if (isOpen()) close()
    closeKebab()
  })

  /* Auto-close when the viewport grows past the drawer breakpoint,
     so the user doesn't end up with a stuck "open" attribute on
     desktop. */
  const mq = window.matchMedia('(min-width: 1024px)')
  function handleMq(e) {
    if (e.matches && isOpen()) close()
  }
  if (mq.addEventListener) mq.addEventListener('change', handleMq)
  else if (mq.addListener) mq.addListener(handleMq)
})()
