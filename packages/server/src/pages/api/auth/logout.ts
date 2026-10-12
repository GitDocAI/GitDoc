import type { APIRoute } from 'astro'
import { clearSessionCookies } from '../../../lib/auth'
import { clearSiteSession } from '../../../lib/siteAuth'

export const prerender = false

// Clears the session cookies and returns home. POST only: a GET that changes
// state gets fired by link prefetching (the site prefetches every visible
// link) and by anything that merely fetches the URL, which signed readers out
// on their own.
export const POST: APIRoute = async ({ cookies, redirect }) => {
  clearSessionCookies(cookies)
  clearSiteSession(cookies)
  return redirect('/', 303)
}

export const GET: APIRoute = () =>
  new Response('Use POST to sign out.', { status: 405, headers: { allow: 'POST' } })
