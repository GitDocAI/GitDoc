import type { APIRoute } from 'astro'
import { getS2SToken, canAccessDoc } from '../../lib/auth'

export const prerender = false

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Hybrid search over the doc's published content. The Worker resolves org/doc
// from the host (middleware), gates private docs against the verified session,
// then calls content-runtime with an s2s token. content-runtime only accepts
// s2s callers, so the browser can never reach it directly.
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env
  const mapping = locals.docMapping
  if (!mapping) return json({ error: 'no documentation for this host' }, 404)
  if (mapping.isPrivate) {
    if (!locals.session) return json({ error: 'unauthorized' }, 401)
    if (!canAccessDoc(locals.session, mapping)) return json({ error: 'forbidden' }, 403)
  }

  let body: { query?: string; version_id?: string; limit?: number }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid request body' }, 400)
  }
  if (!body.query) return json({ error: 'query is required' }, 400)

  if (!env.CONTENT_RUNTIME_URL) return json({ error: 'search not configured' }, 500)
  const token = await getS2SToken(env)
  if (!token) return json({ error: 'search temporarily unavailable' }, 503)

  const res = await fetch(`${env.CONTENT_RUNTIME_URL}/content/docs/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      // Real visitor IP for GCP-side rate limiting — content-runtime sees
      // this Worker's egress IP otherwise, not the actual caller.
      'x-forwarded-client-ip': request.headers.get('cf-connecting-ip') || '',
      // Country/region for the search event content-runtime reports —
      // it never sees the raw request, only this Worker does.
      'x-visitor-country': locals.runtime.cf?.country || '',
      'x-visitor-region': locals.runtime.cf?.region || '',
    },
    body: JSON.stringify({
      organization_id: mapping.orgId,
      documentation_id: mapping.docId,
      query: body.query,
      version_id: body.version_id,
      limit: body.limit,
    }),
  })
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}
