import type { APIRoute } from 'astro'
import { getS2SToken, canAccessDoc } from '../../lib/auth'
import { ContentSource } from '../../lib/contentSource'

export const prerender = false

interface DocHeader {
  config?: { assistant?: { custom_instructions?: string } }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Keep prior turns bounded and well-shaped before forwarding — the browser is
// untrusted, and the model context (and bill) shouldn't grow without limit.
function sanitizeHistory(raw: unknown): { role: string; content: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { role: string; content: string }[] = []
  for (const item of raw.slice(-10)) {
    if (!item || typeof item !== 'object') continue
    const role = (item as Record<string, unknown>).role
    const content = (item as Record<string, unknown>).content
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue
    const trimmed = content.trim()
    if (!trimmed) continue
    out.push({ role, content: trimmed.slice(0, 4000) })
  }
  return out
}

// RAG question-answering over the doc's content. Same gate + s2s flow as
// /api/search.
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env
  const mapping = locals.docMapping
  if (!mapping) return json({ error: 'no documentation for this host' }, 404)
  if (mapping.isPrivate) {
    if (!locals.session) return json({ error: 'unauthorized' }, 401)
    if (!canAccessDoc(locals.session, mapping)) return json({ error: 'forbidden' }, 403)
  }

  let body: { question?: string; version_id?: string; history?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid request body' }, 400)
  }
  if (!body.question) return json({ error: 'question is required' }, 400)

  const history = sanitizeHistory(body.history)

  if (!env.CONTENT_RUNTIME_URL) return json({ error: 'assistant not configured' }, 500)
  const token = await getS2SToken(env)
  if (!token) return json({ error: 'assistant temporarily unavailable' }, 503)

  const source = new ContentSource(env.DOMAINS_KV, env.DOCS_R2)
  const doc = await source.readJson<DocHeader>(source.documentationKey(mapping))
  const customInstructions = doc?.config?.assistant?.custom_instructions?.trim() || undefined

  const res = await fetch(`${env.CONTENT_RUNTIME_URL}/content/docs/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      // Real visitor IP for GCP-side rate limiting — content-runtime sees
      // this Worker's egress IP otherwise, not the actual caller.
      'x-forwarded-client-ip': request.headers.get('cf-connecting-ip') || '',
      // Country/region for the question event content-runtime reports —
      // it never sees the raw request, only this Worker does.
      'x-visitor-country': locals.runtime.cf?.country || '',
      'x-visitor-region': locals.runtime.cf?.region || '',
    },
    body: JSON.stringify({
      organization_id: mapping.orgId,
      documentation_id: mapping.docId,
      question: body.question,
      version_id: body.version_id,
      history,
      custom_instructions: customInstructions,
    }),
  })
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}
