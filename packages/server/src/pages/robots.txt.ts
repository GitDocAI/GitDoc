import type { APIRoute } from 'astro'
import { ContentSource, resolveFromRequest } from '../lib/contentSource'

export const prerender = false

/**
 * Real robots.txt. Without this the catch-all returns the doc HTML for
 * `/robots.txt`, which crawlers parse as ~191 invalid directives. We
 * resolve the doc from the request hostname: private docs (or hosts with
 * no mapping) disallow all crawling; public docs allow it.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env
  const source = new ContentSource(env.DOMAINS_KV, env.DOCS_R2)
  const mapping = await resolveFromRequest(
    request,
    source,
    env as unknown as Record<string, unknown>,
  )

  const disallow = mapping instanceof Response || mapping.isPrivate
  const body = disallow
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\n\nSitemap: ${new URL(request.url).origin}/sitemap.xml\n`

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}
