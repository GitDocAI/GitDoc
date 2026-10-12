import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Per-site settings owned by the OPERATOR of the server, changed at runtime
 * through the admin server (a separate port; see admin/server.ts), never baked into the docs.
 *
 *   docs repo (gitdocai.json)   what the author controls: pages, theme,
 *                               whether the assistant panel is shown, …
 *   site settings (this file)   what the operator controls: quotas, and
 *                               (soon) who may read a private site. May hold
 *                               secrets, so it never travels with the docs.
 *   environment                 defaults for the whole instance, and the
 *                               engine's own secrets.
 *
 * On a self-hosted server the operator is you (the admin panel, or curl).
 * In the hosted product the control plane writes them when a plan changes.
 *
 * Stored in DATA_DIR/_settings/<docId>.json, keyed by documentation id so a
 * hostname change keeps them. Read per request (validated against the file), so
 * a change made by the admin server applies at once, without restarting.
 */

/** `null` (or -1) means "no limit"; 0 means "none allowed". */
export interface Quota {
  /** Questions to the assistant per documentation per day / calendar month (UTC). */
  ask_per_day?: number | null
  ask_per_month?: number | null
  /** Per visitor, per minute. */
  ask_per_min_per_visitor?: number | null
  search_per_min_per_visitor?: number | null
}

/**
 * How readers prove who they are. A site with `enabled: true` is private; the
 * login page offers every provider, in order.
 *
 *   password   one shared password (a small team, a preview)
 *   oidc       any OpenID Connect provider: Okta, Entra, Auth0, Google, Keycloak…
 *   gitdocai   the hosted product's IAM (JWT verified against its JWKS)
 */
export type AuthProvider =
  | { id: string; type: 'password'; name?: string; password_hash?: string }
  | {
      id: string
      type: 'oidc'
      name?: string
      issuer: string
      client_id: string
      client_secret?: string
      scopes?: string[]
      groups_claim?: string
    }
  | { id: string; type: 'gitdocai'; name?: string; iam_url: string; issuer?: string }

export interface AuthSettings {
  enabled?: boolean
  providers?: AuthProvider[]
  /** For oidc/gitdocai identities. Empty/absent: any identity the provider vouches for. */
  allow?: { email_domains?: string[]; emails?: string[]; groups?: string[] }
  session_hours?: number
}

export interface SiteSettings {
  quota?: Quota
  auth?: AuthSettings
}

export const MASK = '***'

export const QUOTA_KEYS = [
  'ask_per_day',
  'ask_per_month',
  'ask_per_min_per_visitor',
  'search_per_min_per_visitor',
] as const

/** Instance-wide defaults (environment), used where a site sets nothing. */
export function quotaDefaults(env: Record<string, string | undefined> = process.env): Required<Quota> {
  const n = (name: string, fallback: number | null) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const v = Number(raw)
    return Number.isFinite(v) ? (v < 0 ? null : v) : fallback
  }
  return {
    ask_per_day: n('ASK_DAILY_LIMIT', 1000),
    ask_per_month: n('ASK_MONTHLY_LIMIT', null),
    ask_per_min_per_visitor: n('RATE_ASK_PER_MIN', 10),
    search_per_min_per_visitor: n('RATE_SEARCH_PER_MIN', 120),
  }
}

/** The quota in force for a site: its own values over the instance defaults. */
export async function effectiveQuota(docId: string, env = process.env): Promise<Required<Quota>> {
  const own = (await loadSettings(docId, env)).quota ?? {}
  const out = quotaDefaults(env)
  for (const k of QUOTA_KEYS) {
    if (k in own) {
      const v = own[k]
      out[k] = v === null || v === undefined || v < 0 ? null : v
    }
  }
  return out
}

function parseQuota(value: unknown): Quota {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('"quota" must be an object')
  const quota: Quota = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!(QUOTA_KEYS as readonly string[]).includes(k)) throw new Error(`unknown quota "${k}"`)
    if (v !== null && !(typeof v === 'number' && Number.isInteger(v) && v >= -1 && v <= 1_000_000_000)) {
      throw new Error(`quota "${k}" must be a whole number, or null for no limit`)
    }
    ;(quota as Record<string, number | null>)[k] = v === -1 ? null : (v as number | null)
  }
  return quota
}

const str = (v: unknown, what: string, max = 300): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`${what} must be a non-empty string`)
  return v.trim()
}
const list = (v: unknown, what: string, lower = false): string[] => {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > 500 || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200)) {
    throw new Error(`${what} must be a list of strings`)
  }
  return v.map((x: string) => (lower ? x.trim().toLowerCase() : x.trim()))
}
const url = (v: unknown, what: string): string => {
  const s = str(v, what, 500)
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error(`${what} must be a URL`)
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.localhost')
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error(`${what} must use https`)
  return s.replace(/\/+$/, '')
}

/**
 * Validate input from the admin API. `existing` supplies the secrets of
 * providers that are sent back without them (the API never shows secrets, so a
 * client that read the settings re-sends `"***"`). Throws a message fit to show.
 */
export function parseSettings(input: unknown, existing: SiteSettings = {}): SiteSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings must be a JSON object')
  const out: SiteSettings = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === 'quota') out.quota = parseQuota(value)
    else if (key === 'auth') out.auth = parseAuth(value, existing.auth)
    else throw new Error(`unknown setting "${key}"`)
  }
  return out
}

function parseAuth(value: unknown, previous?: AuthSettings): AuthSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('"auth" must be an object')
  const v = value as Record<string, unknown>
  for (const k of Object.keys(v)) {
    if (!['enabled', 'providers', 'allow', 'session_hours'].includes(k)) throw new Error(`unknown auth setting "${k}"`)
  }
  const auth: AuthSettings = {}
  if (v.enabled !== undefined) {
    if (typeof v.enabled !== 'boolean') throw new Error('auth.enabled must be true or false')
    auth.enabled = v.enabled
  }
  if (v.session_hours !== undefined) {
    const h = v.session_hours
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 24 * 90) {
      throw new Error('auth.session_hours must be between 1 and 2160')
    }
    auth.session_hours = h
  }
  if (v.allow !== undefined) {
    if (!v.allow || typeof v.allow !== 'object' || Array.isArray(v.allow)) throw new Error('auth.allow must be an object')
    const a = v.allow as Record<string, unknown>
    for (const k of Object.keys(a)) {
      if (!['email_domains', 'emails', 'groups'].includes(k)) throw new Error(`unknown auth.allow "${k}"`)
    }
    auth.allow = {
      email_domains: list(a.email_domains, 'allow.email_domains', true).map((d) => d.replace(/^@/, '')),
      emails: list(a.emails, 'allow.emails', true),
      groups: list(a.groups, 'allow.groups'),
    }
  }
  if (v.providers !== undefined) {
    if (!Array.isArray(v.providers) || v.providers.length > 10) throw new Error('auth.providers must be a list of up to 10')
    const seen = new Set<string>()
    auth.providers = v.providers.map((raw: unknown, i: number): AuthProvider => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('every provider must be an object')
      const p = raw as Record<string, unknown>
      const type = p.type
      if (type !== 'password' && type !== 'oidc' && type !== 'gitdocai') {
        throw new Error('provider type must be password, oidc or gitdocai')
      }
      const id = p.id === undefined ? `${type}-${i + 1}` : str(p.id, 'provider id', 40)
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`provider id "${id}" may use a-z, 0-9 and "-"`)
      if (seen.has(id)) throw new Error(`duplicate provider id "${id}"`)
      seen.add(id)
      const name = p.name === undefined ? undefined : str(p.name, 'provider name', 60)
      const before = previous?.providers?.find((x) => x.id === id && x.type === type)

      if (type === 'password') {
        let hash: string | undefined
        if (typeof p.password === 'string' && p.password !== MASK) {
          if (p.password.length < 8 || p.password.length > 200) throw new Error('the password must have 8 to 200 characters')
          hash = hashPassword(p.password)
        } else if (before?.type === 'password') hash = before.password_hash
        if (!hash) throw new Error(`provider "${id}" needs a password`)
        return { id, type, name, password_hash: hash }
      }
      if (type === 'oidc') {
        let secret: string | undefined
        if (typeof p.client_secret === 'string' && p.client_secret !== MASK) secret = str(p.client_secret, 'client_secret', 500)
        else if (before?.type === 'oidc') secret = before.client_secret
        const scopes = p.scopes === undefined ? undefined : list(p.scopes, 'scopes')
        return {
          id,
          type,
          name: name ?? 'SSO',
          issuer: url(p.issuer, 'issuer'),
          client_id: str(p.client_id, 'client_id', 300),
          client_secret: secret,
          scopes,
          groups_claim: p.groups_claim === undefined ? undefined : str(p.groups_claim, 'groups_claim', 60),
        }
      }
      return {
        id,
        type: 'gitdocai',
        name,
        iam_url: url(p.iam_url, 'iam_url'),
        issuer: p.issuer === undefined ? undefined : str(p.issuer, 'issuer', 300),
      }
    })
  }
  if (auth.enabled && !auth.providers?.length) throw new Error('auth.enabled needs at least one provider')
  return auth
}

/** What the API shows: the same settings with secrets replaced by a mask. */
export function publicSettings(s: SiteSettings): unknown {
  const copy = JSON.parse(JSON.stringify(s)) as SiteSettings
  for (const p of copy.auth?.providers ?? []) {
    if (p.type === 'oidc' && p.client_secret) p.client_secret = MASK
    if (p.type === 'password') {
      const hasPassword = !!p.password_hash
      delete p.password_hash
      ;(p as Record<string, unknown>).password = hasPassword ? MASK : undefined
    }
  }
  return copy
}

/** scrypt, salted: `scrypt$N$r$p$salt$hash`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const N = 16384
  const hash = scryptSync(password, salt, 32, { N, r: 8, p: 1 })
  return `scrypt$${N}$8$1$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false
  const [scheme, N, r, p, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  try {
    const want = Buffer.from(hash, 'base64')
    const got = scryptSync(password, Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p) })
    return got.length === want.length && timingSafeEqual(got, want)
  } catch {
    return false
  }
}

// Settings are written by another process (the admin server), so the cache is
// validated against the file on every read: one stat, no TTL to wait out.
const cache = new Map<string, { stamp: string; value: SiteSettings }>()

function file(docId: string, env: Record<string, string | undefined>): string {
  if (!/^[\w.-]+$/.test(docId)) throw new Error('invalid doc id')
  return join(resolve(env.DATA_DIR || './data'), '_settings', `${docId}.json`)
}

export async function loadSettings(docId: string, env: Record<string, string | undefined> = process.env): Promise<SiteSettings> {
  const f = file(docId, env)
  let stamp = 'missing'
  try {
    const st = await stat(f)
    stamp = `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    /* none set */
  }
  const hit = cache.get(f)
  if (hit && hit.stamp === stamp) return hit.value
  let value: SiteSettings = {}
  if (stamp !== 'missing') {
    try {
      value = JSON.parse(await readFile(f, 'utf-8')) as SiteSettings
    } catch {
      /* unreadable: behave as unset */
    }
  }
  cache.set(f, { stamp, value })
  return value
}

export async function saveSettings(
  docId: string,
  settings: SiteSettings,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const f = file(docId, env)
  await mkdir(join(f, '..'), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, f)
  cache.delete(f)
}
