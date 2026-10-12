import type { APIRoute } from 'astro'
import { loadSettings } from '../../../../lib/settings'
import { OIDC_COOKIE, isAllowed, oidcFinish, publicOrigin, safeReturn, startSession } from '../../../../lib/siteAuth'

export const prerender = false

// The provider sends the reader back here with `code` and `state`.
export const GET: APIRoute = async ({ request, cookies, locals, url, redirect }) => {
  const mapping = locals.docMapping
  if (!mapping) return new Response('no documentation for this host', { status: 404 })
  const origin = publicOrigin(request)
  const failed = (reason: string) => redirect(`/login?error=${reason}`, 302)

  if (url.searchParams.get('error')) return failed('access_denied')
  const auth = (await loadSettings(mapping.docId)).auth
  try {
    const done = await oidcFinish(
      cookies.get(OIDC_COOKIE)?.value,
      { code: url.searchParams.get('code'), state: url.searchParams.get('state') },
      (id) => {
        const p = auth?.providers?.find((x) => x.id === id)
        return p?.type === 'oidc' ? p : undefined
      },
      mapping.docId,
      `${origin}/api/auth/oidc/callback`,
    )
    cookies.delete(OIDC_COOKIE, { path: '/api/auth/oidc' })
    if (!isAllowed(auth?.allow, { email: done.identity.email, groups: done.identity.groups })) {
      return redirect('/no-access', 302)
    }
    startSession(cookies, mapping.docId, done.identity, auth, origin.startsWith('https:'))
    return redirect(safeReturn(done.returnTo), 302)
  } catch (e) {
    console.error('oidc callback failed:', (e as Error).message)
    cookies.delete(OIDC_COOKIE, { path: '/api/auth/oidc' })
    return failed('login_failed')
  }
}
