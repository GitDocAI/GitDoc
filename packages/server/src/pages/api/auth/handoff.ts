import type { APIRoute } from 'astro'
import { setSessionCookies } from '../../../lib/auth'

export const prerender = false

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Exchanges a single-use OAuth handoff token (issued by IAM's server-side
// Google flow and delivered to /login in the URL fragment) for session tokens,
// then stores them in httpOnly cookies. Done server-side so the access token
// never touches the browser's JS. IAM checks that the Origin header matches the
// origin that started the flow, so we forward our own origin explicitly.
export const POST: APIRoute = async ({ request, cookies, locals, url }) => {
  const env = locals.runtime.env
  if (!env.IAM_URL) return json({ error: 'auth not configured' }, 500)

  let body: { handoff?: string }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid request body' }, 400)
  }
  if (!body.handoff) return json({ error: 'handoff is required' }, 400)

  const res = await fetch(`${env.IAM_URL}/iam/api/v1/auth/oauth/google/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url.origin },
    body: JSON.stringify({ handoff: body.handoff }),
  })
  if (!res.ok) return json({ error: 'sign-in could not be completed' }, 401)

  const tokens = (await res.json()) as { access_token?: string; refresh_token?: string }
  if (!tokens.access_token) return json({ error: 'sign-in failed' }, 502)

  setSessionCookies(
    cookies,
    { access_token: tokens.access_token, refresh_token: tokens.refresh_token },
    url.protocol === 'https:',
  )
  return json({ ok: true }, 200)
}
