import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AstroCookies } from 'astro'
import type { SessionClaims } from './auth'
import type { AuthProvider, AuthSettings } from './settings'

/**
 * Reader authentication that belongs to the engine (as opposed to the hosted
 * product's IAM, which lib/auth.ts verifies): a signed session cookie issued
 * after a shared password or an OpenID Connect login.
 *
 * The cookie carries who the reader is and for which documentation; it is
 * HMAC-signed with a key that never leaves the server (SESSION_SECRET, or one
 * generated into DATA_DIR/_secrets on first use).
 */

export const SITE_COOKIE = 'gd_site'
export const OIDC_COOKIE = 'gd_oidc'
const DEFAULT_SESSION_HOURS = 24

// ------------------------------------------------------------------ secret ---

let secretCache: { key: string; value: Buffer } | undefined

function secret(env: Record<string, string | undefined> = process.env): Buffer {
  if (env.SESSION_SECRET) return createHash('sha256').update(env.SESSION_SECRET).digest()
  const file = join(resolve(env.DATA_DIR || './data'), '_secrets', 'session.key')
  if (secretCache?.key === file) return secretCache.value
  const read = () => {
    const v = Buffer.from(readFileSync(file, 'utf-8').trim(), 'hex')
    if (v.length !== 32) throw new Error('bad key')
    return v
  }
  let value: Buffer | undefined
  try {
    value = read()
  } catch {
    // First use. The public server and the admin server share this file and
    // may both get here at once: create it exclusively, and whoever loses the
    // race reads the winner's key instead of keeping a different one.
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 5 && !value; attempt++) {
      try {
        const fresh = randomBytes(32)
        writeFileSync(file, fresh.toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
        value = fresh
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        try {
          value = read()
        } catch {
          /* the winner is still writing: try again */
        }
      }
    }
    if (!value) throw new Error('could not establish the session key')
  }
  secretCache = { key: file, value }
  return value
}

// ----------------------------------------------------------- signed values ---

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** `payload.signature`, both base64url. */
export function sign(payload: unknown, env = process.env): string {
  const body = b64(JSON.stringify(payload))
  return `${body}.${b64(createHmac('sha256', secret(env)).update(body).digest())}`
}

export function unsign<T>(value: string | undefined, env = process.env): T | null {
  if (!value) return null
  const [body, mac] = value.split('.')
  if (!body || !mac) return null
  const want = createHmac('sha256', secret(env)).update(body).digest()
  const got = Buffer.from(mac, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- sessions ---

interface SitePayload {
  v: 1
  doc: string
  prv: string
  /** Changes when the provider's credentials do, which ends its sessions. */
  ver: string
  sub: string
  email?: string
  name?: string
  exp: number
}

export interface Identity {
  /** Stable id from the provider (OIDC `sub`), or `shared` for the password. */
  sub: string
  email?: string
  name?: string
  provider: string
}

export function startSession(
  cookies: AstroCookies,
  docId: string,
  who: Identity,
  auth: AuthSettings | undefined,
  secure: boolean,
  version = '',
): void {
  const hours = auth?.session_hours ?? DEFAULT_SESSION_HOURS
  const payload: SitePayload = {
    v: 1,
    doc: docId,
    prv: who.provider,
    ver: version,
    sub: who.sub,
    email: who.email,
    name: who.name,
    exp: Math.floor(Date.now() / 1000) + hours * 3600,
  }
  cookies.set(SITE_COOKIE, sign(payload), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: hours * 3600,
  })
}

/**
 * The session of this cookie, as the claims the rest of the server understands
 * (see canAccessDoc): a reader granted this one documentation. A cookie issued
 * for another documentation, or expired, is no session.
 */
export function readSiteSession(
  value: string | undefined,
  docId: string,
  orgId: string,
  versionOf: (providerId: string) => string | undefined,
): SessionClaims | null {
  const p = unsign<SitePayload>(value)
  if (!p || p.v !== 1 || p.doc !== docId || p.exp < Date.now() / 1000) return null
  // Removed provider, or a changed password: the session ends.
  if (versionOf(p.prv) !== p.ver) return null
  return { sub: p.sub, email: p.email, name: p.name, org_id: orgId, permissions: [], doc_access: [docId] }
}

export function clearSiteSession(cookies: AstroCookies): void {
  cookies.delete(SITE_COOKIE, { path: '/' })
}

/** Version tag of a provider's credentials, so changing them ends its sessions. */
export function providerVersion(p: AuthProvider): string {
  return p.type === 'password' ? createHash('sha256').update(p.password_hash ?? '').digest('hex').slice(0, 12) : ''
}

// ----------------------------------------------------------- access rules ---

/** Does the identity satisfy `allow`? No rules means any identity the provider vouches for. */
export function isAllowed(
  allow: AuthSettings['allow'],
  who: { email?: string; groups?: string[] },
): boolean {
  const domains = allow?.email_domains ?? []
  const emails = allow?.emails ?? []
  const groups = allow?.groups ?? []
  if (!domains.length && !emails.length && !groups.length) return true
  const email = who.email?.toLowerCase()
  if (email) {
    if (emails.includes(email)) return true
    if (domains.includes(email.split('@')[1] ?? '')) return true
  }
  return !!who.groups?.some((g) => groups.includes(g))
}

// -------------------------------------------------------------------- OIDC ---

type Oidc = Extract<AuthProvider, { type: 'oidc' }>

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

const discoveryCache = new Map<string, { exp: number; value: Discovery }>()

async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer)
  if (hit && hit.exp > Date.now()) return hit.value
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`)
  const d = (await res.json()) as Discovery
  if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new Error('incomplete OIDC discovery document')
  if (d.issuer.replace(/\/+$/, '') !== issuer) throw new Error('OIDC issuer mismatch')
  discoveryCache.set(issuer, { exp: Date.now() + 3_600_000, value: d })
  return d
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

interface Transaction {
  s: string // state
  n: string // nonce
  v: string // PKCE verifier
  p: string // provider id
  r: string // where to go afterwards
  d: string // documentation id
  exp: number
}

/** Where to send the browser to log in; also the transaction cookie value. */
export async function oidcStart(
  p: Oidc,
  docId: string,
  redirectUri: string,
  returnTo: string,
): Promise<{ location: string; cookie: string }> {
  const d = await discover(p.issuer)
  const verifier = randomBytes(32).toString('base64url')
  const tx: Transaction = {
    s: randomBytes(16).toString('base64url'),
    n: randomBytes(16).toString('base64url'),
    v: verifier,
    p: p.id,
    r: returnTo,
    d: docId,
    exp: Math.floor(Date.now() / 1000) + 600,
  }
  const u = new URL(d.authorization_endpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', p.client_id)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('scope', (p.scopes?.length ? p.scopes : ['openid', 'email', 'profile']).join(' '))
  u.searchParams.set('state', tx.s)
  u.searchParams.set('nonce', tx.n)
  u.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
  u.searchParams.set('code_challenge_method', 'S256')
  return { location: u.toString(), cookie: sign(tx) }
}

export interface OidcResult {
  identity: Identity & { groups: string[] }
  returnTo: string
  providerId: string
}

/** Finish the login: check state, exchange the code, verify the ID token. */
export async function oidcFinish(
  cookie: string | undefined,
  params: { code?: string | null; state?: string | null },
  providerFor: (id: string) => Oidc | undefined,
  docId: string,
  redirectUri: string,
): Promise<OidcResult> {
  const tx = unsign<Transaction>(cookie)
  if (!tx || tx.exp < Date.now() / 1000 || tx.d !== docId) throw new Error('the sign-in expired; try again')
  const given = Buffer.from(params.state ?? '')
  const want = Buffer.from(tx.s)
  if (!params.code || given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new Error('the sign-in could not be verified; try again')
  }
  const p = providerFor(tx.p)
  if (!p) throw new Error('that sign-in method is no longer available')
  const d = await discover(p.issuer)

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: redirectUri,
    client_id: p.client_id,
    code_verifier: tx.v,
  })
  if (p.client_secret) form.set('client_secret', p.client_secret)
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`the identity provider refused the sign-in (${res.status})`)
  const tokens = (await res.json()) as { id_token?: string }
  if (!tokens.id_token) throw new Error('the identity provider returned no ID token')

  let jwks = jwksCache.get(d.jwks_uri)
  if (!jwks) jwksCache.set(d.jwks_uri, (jwks = createRemoteJWKSet(new URL(d.jwks_uri))))
  const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: d.issuer, audience: p.client_id })
  if (payload.nonce !== tx.n) throw new Error('the sign-in could not be verified; try again')

  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined
  if (payload.email_verified === false) throw new Error('the email address is not verified at the identity provider')
  if (!email) throw new Error('the identity provider did not share an email address')
  const claim = payload[p.groups_claim || 'groups']
  const groups = Array.isArray(claim) ? claim.filter((g): g is string => typeof g === 'string') : typeof claim === 'string' ? [claim] : []
  return {
    identity: {
      sub: String(payload.sub),
      email,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      provider: p.id,
      groups,
    },
    returnTo: tx.r,
    providerId: p.id,
  }
}

// ------------------------------------------------------------------ misc ---

/** The origin the visitor sees, honouring the proxy only when told to. */
export function publicOrigin(request: Request, env = process.env): string {
  const u = new URL(request.url)
  const host = request.headers.get('host') || u.host
  let proto = u.protocol.replace(':', '')
  if (env.TRUST_PROXY === 'true') {
    const fwd = request.headers.get('x-forwarded-proto')?.split(',')[0].trim()
    if (fwd === 'http' || fwd === 'https') proto = fwd
  }
  return `${proto}://${host}`
}

/** Same-origin paths only: no open redirect through `?return=`. */
export function safeReturn(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : '/'
}
