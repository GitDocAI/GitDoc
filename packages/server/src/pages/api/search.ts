import type { APIRoute } from 'astro'
import { canAccessDoc } from '../../lib/auth'
import { searchBackend } from '../../lib/search'

export const prerender = false

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Search over the doc's published pages. The middleware resolved org/doc from
// the host and verified the session; a private doc is gated here as well.
// The backend (embedded BM25 or OpenSearch) is chosen by the environment.
export const POST: APIRoute = async ({ request, locals }) => {
  const mapping = locals.docMapping
  if (!mapping) return json({ error: 'no documentation for this host' }, 404)
  if (mapping.isPrivate) {
    if (!locals.session) return json({ error: 'unauthorized' }, 401)
    if (!canAccessDoc(locals.session, mapping)) return json({ error: 'forbidden' }, 403)
  }

  let body: { query?: unknown; version_id?: unknown; limit?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid request body' }, 400)
  }
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 300) : ''
  if (!query) return json({ error: 'query is required' }, 400)

  try {
    const results = await searchBackend().search(
      { orgId: mapping.orgId, docId: mapping.docId },
      {
        query,
        versionId: typeof body.version_id === 'string' ? body.version_id : undefined,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
      },
    )
    return json({ results, total: results.length }, 200)
  } catch (e) {
    console.error('search failed:', (e as Error).message)
    return json({ error: 'search temporarily unavailable' }, 503)
  }
}
