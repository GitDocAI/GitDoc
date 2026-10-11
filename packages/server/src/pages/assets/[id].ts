import type { APIRoute } from 'astro'
import { ContentSource, resolveFromRequest } from '../../lib/contentSource'

export const prerender = false

/**
 * Serves a doc asset (logo, favicon, images) from R2. Asset URLs are
 * rewritten to `/assets/{id}` by the render-cli at publish time and the
 * bytes stored at `docs/{docId}/assets/{id}`. We resolve the doc from
 * the request hostname (KV), then stream the R2 object back with its
 * stored content-type and a long immutable cache (asset ids are unique,
 * content never changes under a given id).
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime.env
  const source = new ContentSource(env.DOMAINS_KV, env.DOCS_R2)

  const mapping = await resolveFromRequest(
    request,
    source,
    env as unknown as Record<string, unknown>,
  )
  if (mapping instanceof Response) return mapping

  const id = params.id
  if (!id) return new Response('Bad request', { status: 400 })

  const obj = await env.DOCS_R2.get(`docs/${mapping.docId}/assets/${id}`)
  if (!obj) return new Response('Asset not found', { status: 404 })

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: obj.httpEtag,
    },
  })
}
