import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose'
import type { AstroCookies } from 'astro'

export const SESSION_COOKIE = 'gd_session'
export const REFRESH_COOKIE = 'gd_refresh'

const ACCESS_MAX_AGE = 60 * 60 // 1h, matches IAM access-token TTL
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30 // 30d

export interface AuthEnv {
  IAM_URL?: string
  JWT_ISSUER?: string
  PUBLISH_WEB_CLIENT_ID?: string
  PUBLISH_WEB_CLIENT_SECRET?: string
}

export interface SessionClaims extends JWTPayload {
  email?: string
  name?: string
  org_id?: string
  permissions?: string[]
  // Documentation IDs this user was explicitly granted read access to (readers).
  doc_access?: string[]
}

// canAccessDoc decides whether a session may read a given doc. Public docs are
// open. For private docs the org is already enforced in verifySession, so here:
// staff (any dashboard permission) can read every doc in their org; a reader
// (no permissions) can only read docs explicitly granted via doc_access.
export function canAccessDoc(
  session: SessionClaims | null,
  mapping: { isPrivate: boolean; docId: string },
): boolean {
  if (!mapping.isPrivate) return true
  if (!session) return false
  const perms = session.permissions ?? []
  if (perms.length > 0) return true
  return (session.doc_access ?? []).includes(mapping.docId)
}

// One remote JWKS per IAM origin, cached for the life of the isolate. jose
// fetches the key set on first use and re-fetches only on an unknown kid (with
// a cooldown), so token verification is local — no IAM round trip per request.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getJWKS(iamUrl: string) {
  let jwks = jwksCache.get(iamUrl)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${iamUrl}/iam/.well-known/jwks.json`))
    jwksCache.set(iamUrl, jwks)
  }
  return jwks
}

// verifySession validates the JWT locally (signature via JWKS, issuer,
// `publish-web` audience). When `expectedOrgId` is provided it also enforces
// tenant isolation: the token's org must own the doc being served. Pass an
// empty string to skip the org check (used by the middleware to detect a
// valid session minted for a DIFFERENT org — that's a /no-access case, not
// a /login one). Returns the claims on success, null otherwise.
export async function verifySession(
  token: string,
  env: AuthEnv,
  expectedOrgId: string,
): Promise<SessionClaims | null> {
  if (!token || !env.IAM_URL) return null
  try {
    const { payload } = await jwtVerify(token, getJWKS(env.IAM_URL), {
      issuer: env.JWT_ISSUER || env.IAM_URL,
      audience: 'publish-web',
    })
    const claims = payload as SessionClaims
    if (expectedOrgId && (!claims.org_id || claims.org_id !== expectedOrgId)) return null
    return claims
  } catch {
    return null
  }
}

interface IssuedTokens {
  access_token: string
  refresh_token?: string
}

export function setSessionCookies(cookies: AstroCookies, tokens: IssuedTokens, secure: boolean): void {
  const base = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure }
  cookies.set(SESSION_COOKIE, tokens.access_token, { ...base, maxAge: ACCESS_MAX_AGE })
  if (tokens.refresh_token) {
    cookies.set(REFRESH_COOKIE, tokens.refresh_token, { ...base, maxAge: REFRESH_MAX_AGE })
  }
}

export function clearSessionCookies(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' })
  cookies.delete(REFRESH_COOKIE, { path: '/' })
}

// refreshSession trades a refresh token for a fresh access token at IAM,
// re-verifies it (incl. org match) and rotates the cookies. On a hard failure
// (expired/invalid refresh) it clears the cookies so we stop retrying; on a
// transient error it leaves them so a later request can retry. Returns the new
// claims, or null when the user must log in again.
export async function refreshSession(
  refreshToken: string,
  env: AuthEnv,
  cookies: AstroCookies,
  secure: boolean,
  expectedOrgId: string,
): Promise<SessionClaims | null> {
  if (!env.IAM_URL) return null
  let res: Response
  try {
    res = await fetch(`${env.IAM_URL}/iam/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
  } catch {
    return null // transient — keep cookies, let a later request retry
  }
  if (!res.ok) {
    clearSessionCookies(cookies)
    return null
  }
  const tokens = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string }
  if (!tokens.access_token) {
    clearSessionCookies(cookies)
    return null
  }
  const claims = await verifySession(tokens.access_token, env, expectedOrgId)
  if (!claims) {
    clearSessionCookies(cookies)
    return null
  }
  setSessionCookies(cookies, { access_token: tokens.access_token, refresh_token: tokens.refresh_token }, secure)
  return claims
}

// s2s token for calling content-runtime, minted via IAM's client_credentials
// grant and cached in-isolate until ~30s before expiry so search/ask don't hit
// IAM on every request.
let s2sCache: { token: string; exp: number } | null = null

export async function getS2SToken(env: AuthEnv): Promise<string | null> {
  const now = Date.now()
  if (s2sCache && s2sCache.exp - 30_000 > now) return s2sCache.token
  if (!env.IAM_URL || !env.PUBLISH_WEB_CLIENT_ID || !env.PUBLISH_WEB_CLIENT_SECRET) return null

  const basic = btoa(`${env.PUBLISH_WEB_CLIENT_ID}:${env.PUBLISH_WEB_CLIENT_SECRET}`)
  const res = await fetch(`${env.IAM_URL}/iam/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&audience=content-runtime',
  })
  if (!res.ok) return null
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) return null
  s2sCache = { token: data.access_token, exp: now + (data.expires_in ?? 3600) * 1000 }
  return s2sCache.token
}
