/**
 * Worker-safe HTML post-processors. These operate purely on a rendered
 * HTML string (regex/string scanning, no DOM, no node:fs) so they can
 * run inside the Cloudflare Worker SSR path — unlike `staticContent.ts`,
 * which reads the local `content/` dir at module load and therefore
 * can't be imported into the Worker bundle.
 *
 * `staticContent.ts` keeps its own copies for the (legacy) SSG build;
 * once that path is deleted these become the single source.
 */

export interface TocHeading {
  level: number
  text: string
  id: string
}

/**
 * Worker-side asset URL resolver. Passthrough for now — the HTML the
 * uploader writes to R2 is already pre-rendered with final asset URLs,
 * and logo/favicon URLs in the doc config are served from wherever the
 * asset pipeline points. The SSG build's `normalizeAssetUrl` rewrote
 * against a local asset manifest (node:fs); that has no meaning in the
 * Worker, so we leave URLs untouched until asset serving is wired.
 */
export function normalizeAssetUrl(url: string | undefined | null): string | undefined {
  return url ?? undefined
}

/**
 * Pull every right-panel <aside> out of the article HTML. Returns the
 * HTML with the panels removed plus the concatenated inner HTML of each
 * panel (rendered separately in the right rail).
 *
 * Regex-based: the markup is fully controlled by `renderTiptap.tsx`, so
 * the shape is known and a parser would be overkill.
 */
export function extractRightPanels(
  html: string,
): { html: string; panelsHtml: string } {
  if (!html) return { html, panelsHtml: '' }
  const re = /<aside\s+class="right-panel"[^>]*data-right-panel="?[^>]*>([\s\S]*?)<\/aside>/g
  const panels: string[] = []
  const stripped = html.replace(re, (_match, inner) => {
    panels.push(String(inner))
    return ''
  })
  return { html: stripped, panelsHtml: panels.join('') }
}

/**
 * Walk rendered article HTML and:
 *   1. Drop any h1/h2/h3 inside a nested component block (card-block,
 *      accordion, tabs, info-block, update-entry) so the TOC shows only
 *      the page's own outline.
 *   2. Slug-ify each remaining heading's text into a stable id.
 *   3. Rewrite the HTML so each kept heading carries that id — letting
 *      anchor links + scroll-spy work without client-side DOM mutation.
 *
 * Returns the rewritten HTML plus the ordered heading list.
 */
export function extractHeadings(html: string): { html: string; headings: TocHeading[] } {
  if (!html) return { html, headings: [] }

  const skipMarkers = [
    'card-block',
    'accordion-block',
    'tabs-block',
    'info-block',
    'update-entry',
  ]
  const skipRanges: Array<[number, number]> = []
  for (const marker of skipMarkers) {
    const classRe = new RegExp(`class\\s*=\\s*["'][^"']*\\b${marker}\\b[^"']*["']`, 'g')
    let m: RegExpExecArray | null
    while ((m = classRe.exec(html)) !== null) {
      const openLt = html.lastIndexOf('<', m.index)
      if (openLt < 0) continue
      const tagName = (html.slice(openLt + 1).match(/^[a-zA-Z][a-zA-Z0-9]*/) || [''])[0] || ''
      if (!tagName) continue
      const openRe = new RegExp(`<${tagName}\\b`, 'g')
      const closeRe = new RegExp(`</${tagName}\\s*>`, 'g')
      openRe.lastIndex = openLt + 1
      closeRe.lastIndex = openLt + 1
      let depth = 1
      let end = -1
      while (depth > 0) {
        const o = openRe.exec(html)
        const c = closeRe.exec(html)
        if (!c) break
        if (o && o.index < c.index) {
          depth++
          closeRe.lastIndex = o.index + 1
        } else {
          depth--
          if (depth === 0) end = c.index + c[0].length
          openRe.lastIndex = c.index + 1
        }
      }
      if (end > openLt) skipRanges.push([openLt, end])
    }
  }
  const insideSkip = (pos: number) =>
    skipRanges.some(([a, b]) => pos >= a && pos < b)

  const headings: TocHeading[] = []
  const seen = new Set<string>()
  const decodeEntities = (s: string): string =>
    s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
  const slugify = (text: string): string => {
    const base =
      text
        .toLowerCase()
        .replace(/<[^>]+>/g, '')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'section'
    if (!seen.has(base)) return base
    let i = 2
    while (seen.has(`${base}-${i}`)) i++
    return `${base}-${i}`
  }

  const out = html.replace(
    /<(h[123])\b([^>]*)>([\s\S]*?)<\/\1>/g,
    (match, tag: string, attrs: string, inner: string, offset: number) => {
      if (insideSkip(offset)) return match
      const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()
      if (!text) return match
      const level = parseInt(tag.slice(1), 10)
      const existingId = /\bid\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]
      const id = existingId ?? slugify(text)
      seen.add(id)
      headings.push({ level, text, id })
      if (existingId) return match
      return `<${tag}${attrs} id="${id}">${inner}</${tag}>`
    },
  )

  return { html: out, headings }
}
