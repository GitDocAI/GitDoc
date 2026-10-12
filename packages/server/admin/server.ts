/**
 * The administration server: a second port, separate from the one readers use,
 * for whoever operates this installation. It serves a small web UI and the
 * JSON API behind it:
 *
 *   /                        the UI (onboarding, sites, access, quotas, connect)
 *   /admin/api/*             what the UI needs (session cookie)
 *   /api/settings|usage|reindex|sites
 *                            the operator API (session cookie, or a Bearer
 *                            PUBLISH_TOKEN for automation such as a control plane)
 *
 * It is bound to 127.0.0.1 unless ADMIN_HOST says otherwise, so by default it
 * is not reachable from the network at all. First visit asks for a password
 * (proving control of the server by the PUBLISH_TOKEN); there is no default.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hit } from '../src/lib/rateLimit'
import { searchBackend } from '../src/lib/search'
import { ensureAllIndexed, reindexSite } from '../src/lib/search/reindex'
import {
  effectiveQuota,
  hashPassword,
  loadSettings,
  parseSettings,
  publicSettings,
  saveSettings,
  verifyPassword,
} from '../src/lib/settings'
import { eventSinks } from '../src/lib/events'
import { sign, unsign } from '../src/lib/siteAuth'
import { readUsage } from '../src/lib/usage'
// @ts-expect-error bundled as text by the build (see scripts/assemble-engine.mjs)
import page from './ui.html'
// @ts-expect-error bundled as text by the build
import logoOnDark from './assets/logo-on-dark.svg'
// @ts-expect-error bundled as text by the build
import logoOnLight from './assets/logo-on-light.svg'
// @ts-expect-error bundled as text by the build
import mark from './assets/mark.svg'

const IMAGES: Record<string, string> = {
  '/logo-on-dark.svg': logoOnDark,
  '/logo-on-light.svg': logoOnLight,
  '/mark.svg': mark,
}

const env = process.env
const dataDir = () => resolve(env.DATA_DIR || './data')
const COOKIE = 'gd_admin'
const SESSION_SECONDS = 8 * 3600

// ------------------------------------------------------------------ helpers ---

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const json = typeof body !== 'string'
  res.writeHead(status, {
    'content-type': json ? 'application/json' : 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(json ? JSON.stringify(body) : body)
}

async function readBody(req: IncomingMessage, max = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > max) throw new Error('request too large')
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')
  return raw ? JSON.parse(raw) : {}
}

const cookieOf = (req: IncomingMessage, name: string) =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1]

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// ----------------------------------------------------- the admin password ---

const passwordFile = () => join(dataDir(), '_secrets', 'admin.json')

let envHash: string | null = null
const currentHash = () => {
  try {
    return (JSON.parse(readFileSync(passwordFile(), 'utf-8')) as { password_hash: string }).password_hash
  } catch {
    if (env.ADMIN_PASSWORD) return (envHash ??= hashPassword(env.ADMIN_PASSWORD))
    return null
  }
}

function savePassword(password: string): void {
  const f = passwordFile()
  mkdirSync(join(f, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(f, JSON.stringify({ password_hash: hashPassword(password), created_at: new Date().toISOString() }) + '\n', {
    mode: 0o600,
  })
}

// ------------------------------------------------------------- authorization ---

type Who = 'user' | 'machine' | null

function who(req: IncomingMessage): Who {
  const expected = env.PUBLISH_TOKEN
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  if (expected && bearer && safeEqual(bearer, expected)) return 'machine'
  const s = unsign<{ a: number; exp: number }>(cookieOf(req, COOKIE))
  if (s && s.a === 1 && s.exp > Date.now() / 1000) return 'user'
  return null
}

// ----------------------------------------------------------------- data ---

interface Mapping {
  orgId: string
  docId: string
  isPrivate: boolean
}

async function domains(): Promise<Record<string, Mapping>> {
  try {
    return JSON.parse(await readFile(join(dataDir(), '_domains', 'index.json'), 'utf-8'))
  } catch {
    return {}
  }
}

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as T
  } catch {
    return null
  }
}

async function describeSite(hostname: string, m: Mapping) {
  const docs = join(dataDir(), 'docs', m.docId)
  const header = await readJson<{ name?: string }>(join(docs, 'documentation.json'))
  const pages = await readJson<unknown[]>(join(docs, 'pages-index.json'))
  const settings = await loadSettings(m.docId)
  const embedded = await readJson<{ dim?: number; model?: string; docs?: unknown[] }>(
    join(dataDir(), '_search', `${m.docId}.json`),
  )
  let backend = 'embedded'
  try {
    backend = searchBackend().name
  } catch {
    backend = 'misconfigured'
  }
  return {
    hostname,
    name: header?.name ?? '',
    docId: m.docId,
    pages: pages?.length ?? 0,
    private: m.isPrivate || !!settings.auth?.enabled,
    auth: { enabled: !!settings.auth?.enabled, providers: (settings.auth?.providers ?? []).map((p) => p.type) },
    quota: await effectiveQuota(m.docId),
    usage: await readUsage(m.docId, env, new Date(), true),
    search: {
      backend,
      indexed: backend === 'embedded' ? (embedded?.docs?.length ?? 0) : null,
      vectors: backend === 'embedded' ? !!embedded?.dim : null,
      model: backend === 'embedded' ? embedded?.model || null : null,
    },
  }
}

function instance() {
  let backend = 'embedded'
  let error: string | undefined
  try {
    backend = searchBackend().name
  } catch (e) {
    error = (e as Error).message
  }
  return {
    ai: {
      configured: !!env.AI_URL,
      host: env.AI_URL ? new URL(env.AI_URL).host : null,
      chatModel: env.AI_CHAT_MODEL || null,
      embeddingModel: env.AI_EMBEDDING_MODEL || null,
    },
    search: { backend, error, opensearchHost: env.OPENSEARCH_URL ? new URL(env.OPENSEARCH_URL).host : null },
    events: eventSinks(env).join(', ') || 'off',
    trustProxy: env.TRUST_PROXY === 'true',
    publishEnabled: !!env.PUBLISH_TOKEN,
    publicUrl: env.PUBLIC_URL || null,
  }
}

// ---------------------------------------------------------------- routing ---

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://admin')
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return send(res, 200, page, { 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'" })
  }

  if (method === 'GET' && IMAGES[path]) {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' })
    return void res.end(IMAGES[path])
  }

  // --- session --------------------------------------------------------------
  if (path === '/admin/api/state' && method === 'GET') {
    return send(res, 200, { needsSetup: !currentHash(), authenticated: who(req) === 'user', publicUrl: env.PUBLIC_URL || null })
  }
  if (path === '/admin/api/setup' && method === 'POST') {
    if (currentHash()) return send(res, 409, { error: 'this server already has an admin password' })
    if (!hit('admin-setup', 10, 300_000).ok) return send(res, 429, { error: 'too many attempts' })
    const b = (await readBody(req)) as { token?: string; password?: string }
    if (!env.PUBLISH_TOKEN) return send(res, 400, { error: 'set PUBLISH_TOKEN on the server first: it proves you control it' })
    if (typeof b.token !== 'string' || !safeEqual(b.token.trim(), env.PUBLISH_TOKEN)) {
      return send(res, 401, { error: 'that is not this server’s PUBLISH_TOKEN' })
    }
    if (typeof b.password !== 'string' || b.password.length < 10 || b.password.length > 200) {
      return send(res, 400, { error: 'the password must have 10 to 200 characters' })
    }
    savePassword(b.password)
    return startSession(res)
  }
  if (path === '/admin/api/login' && method === 'POST') {
    if (!hit('admin-login', 10, 300_000).ok) return send(res, 429, { error: 'too many attempts, wait a few minutes' })
    const b = (await readBody(req)) as { password?: string }
    if (typeof b.password !== 'string' || !verifyPassword(b.password, currentHash() ?? undefined)) {
      return send(res, 401, { error: 'Incorrect password.' })
    }
    return startSession(res)
  }
  if (path === '/admin/api/logout' && method === 'POST') {
    return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` })
  }

  // --- everything below needs a session or the machine token -----------------
  const caller = who(req)
  if (!caller) return send(res, 401, { error: 'unauthorized' })
  // A cookie rides along on cross-site requests; a custom header does not.
  if (caller === 'user' && method !== 'GET' && req.headers['x-gitdoc-admin'] !== '1') {
    return send(res, 403, { error: 'missing X-GitDoc-Admin header' })
  }

  if (path === '/admin/api/instance' && method === 'GET') return send(res, 200, instance())
  if (path === '/admin/api/token' && method === 'GET') {
    if (caller !== 'user') return send(res, 403, { error: 'sessions only' })
    return send(res, 200, { token: env.PUBLISH_TOKEN ?? null })
  }
  if (path === '/admin/api/password' && method === 'POST') {
    if (caller !== 'user') return send(res, 403, { error: 'sessions only' })
    const b = (await readBody(req)) as { current?: string; password?: string }
    if (typeof b.current !== 'string' || !verifyPassword(b.current, currentHash() ?? undefined)) {
      return send(res, 401, { error: 'the current password is not right' })
    }
    if (typeof b.password !== 'string' || b.password.length < 10 || b.password.length > 200) {
      return send(res, 400, { error: 'the password must have 10 to 200 characters' })
    }
    savePassword(b.password)
    return send(res, 200, { ok: true })
  }

  if (path === '/api/sites' && method === 'GET') {
    const idx = await domains()
    return send(res, 200, { sites: await Promise.all(Object.entries(idx).map(([h, m]) => describeSite(h, m))) })
  }

  if (path === '/api/settings' || path === '/api/usage' || path === '/api/reindex') {
    const hostname = url.searchParams.get('hostname')
    const idx = await domains()
    if (path === '/api/reindex' && method === 'POST') {
      const targets = hostname ? [hostname] : Object.keys(idx)
      const sites: Record<string, unknown> = {}
      for (const h of targets) {
        try {
          sites[h] = await reindexSite(h)
        } catch (e) {
          sites[h] = { error: (e as Error).message }
        }
      }
      const failed = Object.values(sites).some((s) => (s as { error?: string }).error)
      return send(res, failed ? 500 : 200, { ok: !failed, sites })
    }
    if (!hostname) return send(res, 400, { error: 'hostname is required' })
    const m = idx[hostname]
    if (!m) return send(res, 404, { error: `no site is published for ${hostname}` })
    if (path === '/api/usage' && method === 'GET') return send(res, 200, await readUsage(m.docId, env, new Date(), true))
    if (path === '/api/settings' && method === 'GET') {
      return send(res, 200, {
        settings: publicSettings(await loadSettings(m.docId)),
        effective: { quota: await effectiveQuota(m.docId) },
      })
    }
    if (path === '/api/settings' && method === 'PUT') {
      let settings
      try {
        settings = parseSettings(await readBody(req), await loadSettings(m.docId))
      } catch (e) {
        return send(res, 400, { error: (e as Error).message })
      }
      await saveSettings(m.docId, settings)
      return send(res, 200, {
        ok: true,
        settings: publicSettings(settings),
        effective: { quota: await effectiveQuota(m.docId) },
      })
    }
  }
  return send(res, 404, { error: 'not found' })
}

function startSession(res: ServerResponse) {
  const value = sign({ a: 1, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })
  return send(res, 200, { ok: true }, {
    'set-cookie': `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
  })
}

// ----------------------------------------------------------------- start ---

const server = createServer((req, res) => {
  handle(req, res).catch((e: Error) => {
    if (!res.headersSent) send(res, e.message === 'request too large' ? 413 : 500, { error: e.message })
  })
})
const port = Number(env.ADMIN_PORT || 8081)
const host = env.ADMIN_HOST || '127.0.0.1'
server.listen(port, host, () => {
  console.log(`gitdoc admin on http://${host}:${port}`)
  // Whatever was published without an index (older build, files written
  // directly) is ingested now, in the background, instead of on first search.
  void ensureAllIndexed(env)
})
