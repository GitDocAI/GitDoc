import type { APIRoute } from 'astro'
import { setSessionCookies } from '../../../lib/auth'

export const prerender = false

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Email/password login. Proxies to IAM and, on success, stores the issued
// tokens in httpOnly cookies — the access token never reaches the browser's
// JS, and subsequent requests are verified locally at the edge (no IAM call
// per request).
export const POST: APIRoute = async ({ request, cookies, locals, url }) => {
  const env = locals.runtime.env
  if (!env.IAM_URL) return json({ error: 'auth not configured' }, 500)

  let body: { email?: string; password?: string }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid request body' }, 400)
  }
  const { email, password } = body
  if (!email || !password) return json({ error: 'email and password are required' }, 400)

  const res = await fetch(`${env.IAM_URL}/iam/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  if (!res.ok) {
    let message = 'Invalid email or password'
    try {
      const data = (await res.json()) as { error?: string; message?: string }
      if (data?.error || data?.message) message = data.error || data.message!
    } catch {
      /* keep default */
    }
    // 4xx from IAM → surface as 401 (bad creds); anything else → upstream error.
    return json({ error: message }, res.status >= 400 && res.status < 500 ? 401 : 502)
  }

  const tokens = (await res.json()) as { access_token?: string; refresh_token?: string }
  if (!tokens.access_token) return json({ error: 'login failed' }, 502)

  setSessionCookies(
    cookies,
    { access_token: tokens.access_token, refresh_token: tokens.refresh_token },
    url.protocol === 'https:',
  )
  return json({ ok: true }, 200)
}
