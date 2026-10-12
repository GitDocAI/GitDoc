import type { APIRoute } from 'astro'
import { loadSettings } from '../../../../lib/settings'
import { OIDC_COOKIE, oidcStart, publicOrigin, safeReturn } from '../../../../lib/siteAuth'

export const prerender = false

// Begin an OpenID Connect sign-in: remember state, nonce and PKCE verifier in
// a short-lived signed cookie, then send the browser to the provider.
export const GET: APIRoute = async ({ request, cookies, locals, url, redirect }) => {
  const mapping = locals.docMapping
  if (!mapping) return new Response('no documentation for this host', { status: 404 })
  const id = url.searchParams.get('provider')
  const provider = (await loadSettings(mapping.docId)).auth?.providers?.find((p) => p.id === id)
  if (!provider || provider.type !== 'oidc') return new Response('unknown sign-in method', { status: 404 })

  const origin = publicOrigin(request)
  try {
    const { location, cookie } = await oidcStart(
      provider,
      mapping.docId,
      `${origin}/api/auth/oidc/callback`,
      safeReturn(url.searchParams.get('return')),
    )
    cookies.set(OIDC_COOKIE, cookie, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/auth/oidc',
      secure: origin.startsWith('https:'),
      maxAge: 600,
    })
    return redirect(location, 302)
  } catch (e) {
    console.error('oidc start failed:', (e as Error).message)
    return redirect('/login?error=provider_unavailable', 302)
  }
}
