import type { APIRoute } from 'astro'
import { clearSessionCookies } from '../../../lib/auth'

export const prerender = false

// "Try a different account" from /no-access. The visitor holds a valid session
// for the WRONG org, so just sending them to /login would bounce straight back
// (login.astro short-circuits when locals.session exists) and loop them onto
// /no-access. Clearing the session cookies first means /login renders its form
// fresh, where they can sign in with another account.
export const GET: APIRoute = ({ cookies, redirect }) => {
  clearSessionCookies(cookies)
  return redirect('/login', 302)
}
