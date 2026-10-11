import type { APIRoute } from 'astro'
import { ContentSource, resolveFromRequest, type PageIndexEntry } from '../lib/contentSource'

export const prerender = false

/**
 * Per-doc sitemap. Reads the flat `pages-index.json` written by the
 * render-cli and emits absolute URLs against the request origin (so each
 * hostname gets a sitemap for itself). Private docs aren't crawlable, so
 * we 404 rather than leak their structure.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env
  const source = new ContentSource(env.DOMAINS_KV, env.DOCS_R2)
  const mapping = await resolveFromRequest(
    request,
    source,
    env as unknown as Record<string, unknown>,
  )
  if (mapping instanceof Response || mapping.isPrivate) {
    return new Response('Not found', { status: 404 })
  }

  const pages = (await source.readJson<PageIndexEntry[]>(source.pagesIndexKey(mapping))) ?? []
  const origin = new URL(request.url).origin

  // Homepage first, then every indexed page at its canonical path.
  const locs = ['/', ...pages.map((p) => p.path)]
  const lastmodByPath = new Map(pages.map((p) => [p.path, p.lastmod]))

  const urls = locs
    .map((path) => {
      const lastmod = toIsoDate(lastmodByPath.get(path))
      return (
        '<url>' +
        `<loc>${escapeXml(origin + path)}</loc>` +
        (lastmod ? `<lastmod>${lastmod}</lastmod>` : '') +
        '</url>'
      )
    })
    .join('')

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls +
    '</urlset>'

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}

function toIsoDate(value: string | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
