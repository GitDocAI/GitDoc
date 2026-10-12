import type { APIRoute } from 'astro'
import { clearSessionCookies } from '../../../lib/auth'
import { clearSiteSession } from '../../../lib/siteAuth'

export const prerender = false

// Clears the session cookies and bounces home. Supports GET so a plain
// "Log out" link works, and POST for programmatic calls.
const handler: APIRoute = async ({ cookies, redirect }) => {
  clearSessionCookies(cookies)
  clearSiteSession(cookies)
  return redirect('/', 303)
}

export const GET = handler
export const POST = handler
