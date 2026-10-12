import type { APIRoute } from 'astro'
import { clientKey, hit, tooMany } from '../../../lib/rateLimit'
import { loadSettings, verifyPassword } from '../../../lib/settings'
import { providerVersion, startSession } from '../../../lib/siteAuth'

export const prerender = false

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Shared-password sign-in for sites that configure a `password` provider.
export const POST: APIRoute = async ({ request, cookies, locals, url, clientAddress }) => {
  const mapping = locals.docMapping
  if (!mapping) return json({ error: 'no documentation for this host' }, 404)

  // Online guessing is the only attack on a password: keep it slow.
  const verdict = hit(`login:${mapping.docId}:${clientKey(request, clientAddress)}`, 10, 5 * 60_000)
  if (!verdict.ok) return tooMany(verdict)

  let body: { provider?: unknown; password?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid request body' }, 400)
  }
  if (typeof body.password !== 'string' || !body.password) return json({ error: 'password is required' }, 400)

  const auth = (await loadSettings(mapping.docId)).auth
  const providers = (auth?.providers ?? []).filter((p) => p.type === 'password')
  const wanted = typeof body.provider === 'string' ? providers.filter((p) => p.id === body.provider) : providers
  const match = wanted.find((p) => p.type === 'password' && verifyPassword(body.password as string, p.password_hash))
  if (!match) return json({ error: 'Incorrect password.' }, 401)

  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0].trim()
  const secure = process.env.TRUST_PROXY === 'true' && forwarded ? forwarded === 'https' : url.protocol === 'https:'
  startSession(cookies, mapping.docId, { sub: 'shared', provider: match.id }, auth, secure, providerVersion(match))
  return json({ ok: true }, 200)
}
