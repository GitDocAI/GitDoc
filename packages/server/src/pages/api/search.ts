import type { APIRoute } from 'astro'
import { canAccessDoc } from '../../lib/auth'
import { emitEvent } from '../../lib/events'
import { clientKey, envInt, hit, tooMany } from '../../lib/rateLimit'
import { searchBackend } from '../../lib/search'

export const prerender = false

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Search over the doc's published pages. The middleware resolved org/doc from
// the host and verified the session; a private doc is gated here as well.
// The backend (embedded hybrid or OpenSearch) is chosen by the environment.
export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const mapping = locals.docMapping
  if (!mapping) return json({ error: 'no documentation for this host' }, 404)
  if (mapping.isPrivate) {
    if (!locals.session) return json({ error: 'unauthorized' }, 401)
    if (!canAccessDoc(locals.session, mapping)) return json({ error: 'forbidden' }, 403)
  }

  const verdict = hit(`search:${clientKey(request, clientAddress)}`, envInt('RATE_SEARCH_PER_MIN', 120), 60_000)
  if (!verdict.ok) return tooMany(verdict)

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
    emitEvent({
      type: 'search',
      org_id: mapping.orgId,
      doc_id: mapping.docId,
      query_text: query,
      result_count: results.length,
      was_answered: results.length > 0,
    })
    return json({ results, total: results.length }, 200)
  } catch (e) {
    console.error('search failed:', (e as Error).message)
    return json({ error: 'search temporarily unavailable' }, 503)
  }
}
