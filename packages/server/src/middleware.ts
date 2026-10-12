import { defineMiddleware } from 'astro:middleware'
import { ContentSource, resolveFromRequest } from './lib/contentSource'
import { verifySession, refreshSession, canAccessDoc, SESSION_COOKIE, REFRESH_COOKIE, type SessionClaims } from './lib/auth'
import type { DomainMapping } from './lib/types'
import { loadSettings } from './lib/settings'
import { SITE_COOKIE, providerVersion, readSiteSession } from './lib/siteAuth'

// The API routes that really exist. They self-gate (401 JSON, never a redirect
// — a fetch must not be bounced to an HTML login page), so the middleware
// leaves them alone. This is an exact list, NOT a `/api/` prefix: doc pages
// are served by the catch-all route and rely on this middleware for auth, so a
// prefix match would serve any private page under an `/api/…` path (a section
// called "API" is common) to anyone without a session.
const API_ROUTES = new Set([
  '/api/search',
  '/api/ask',
  '/api/mcp', // read-only MCP server; self-gates (401 JSON)
  '/api/publish', // self-hosted only; authenticated by PUBLISH_TOKEN
  '/api/sites', // self-hosted only; authenticated by PUBLISH_TOKEN
  '/api/reindex', // self-hosted only; authenticated by PUBLISH_TOKEN
  '/api/settings', // self-hosted only; authenticated by PUBLISH_TOKEN
  '/api/usage', // self-hosted only; authenticated by PUBLISH_TOKEN
  '/api/auth/login',
  '/api/auth/password',
  '/api/auth/oidc/start',
  '/api/auth/oidc/callback',
  '/api/auth/switch',
  '/api/auth/handoff',
  '/api/auth/logout',
])

// Paths that must stay reachable even on a private doc: the login page + its
// auth API, asset/SEO routes, and Astro internals.
function isBypass(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/no-access' ||
    API_ROUTES.has(pathname) ||
    // `/assets/{id}` is a single segment. Deeper paths fall through to the
    // catch-all (doc pages), so they must go through the auth gate.
    /^\/assets\/[^/]+$/.test(pathname) ||
    pathname.startsWith('/_') ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    pathname === '/llms.txt' ||
    pathname === '/favicon.ico'
  )
}

// Self-hosted (Node) has no Cloudflare adapter, so `locals.runtime` is absent.
// Provide the same shape backed by DATA_DIR; Cloudflare keeps its own.
let diskRuntime: unknown

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, locals, cookies, url } = context
  if (!(locals as { runtime?: unknown }).runtime) {
    // Dynamic: the Node-only module is never evaluated on Workers.
    diskRuntime ??= (await import('./lib/diskRuntime')).createDiskRuntime(process.env)
    ;(locals as { runtime?: unknown }).runtime = diskRuntime
  }
  const env = locals.runtime.env

  const source = new ContentSource(env.DOMAINS_KV, env.DOCS_R2)
  const resolved = await resolveFromRequest(request, source, env as unknown as Record<string, unknown>)

  // No mapping for this host → let the route render its own 404 page.
  if (resolved instanceof Response) return next()

  const mapping = resolved as DomainMapping
  locals.docMapping = mapping

  // How this site authenticates readers is its operator's setting (see
  // lib/settings.ts). A `gitdocai` provider points at the hosted IAM; without
  // one, the instance-wide IAM_URL (if any) keeps working as before.
  const siteAuth = (await loadSettings(mapping.docId)).auth
  const providers = siteAuth?.providers ?? []
  const iamProvider = providers.find((p) => p.type === 'gitdocai')
  const authEnv = iamProvider
    ? { ...env, IAM_URL: iamProvider.iam_url, JWT_ISSUER: iamProvider.issuer || iamProvider.iam_url }
    : env
  if (iamProvider) locals.runtime = { ...locals.runtime, env: authEnv as typeof env }
  locals.siteLogin = {
    providers: providers.map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name || (p.type === 'password' ? 'Password' : p.type === 'oidc' ? 'SSO' : 'GitDocAI'),
    })),
    // The email/password + Google form is the IAM's: shown when this site
    // names a gitdocai provider, or when no provider is set and IAM_URL is.
    iam: !!iamProvider || (!providers.length && !!authEnv.IAM_URL),
  }

  // Verify any session token up front (locally, via JWKS) so the content
  // routes and the search/ask API can reuse the result without re-checking.
  const versions = new Map(providers.filter((p) => p.type !== 'gitdocai').map((p) => [p.id, providerVersion(p)]))
  let session: SessionClaims | null = readSiteSession(
    cookies.get(SITE_COOKIE)?.value,
    mapping.docId,
    mapping.orgId,
    (id) => versions.get(id),
  )
  // A valid JWT minted for a DIFFERENT org. The signature/audience check
  // passed but the token's org doesn't own this doc — that user is signed
  // in to the wrong account, /login would loop them; /no-access is the
  // right destination so they can switch accounts.
  let otherOrgSession: SessionClaims | null = null
  const token = cookies.get(SESSION_COOKIE)?.value
  if (token && !session) {
    session = await verifySession(token, authEnv, mapping.orgId)
    if (!session) {
      const claims = await verifySession(token, authEnv, '')
      if (claims && claims.org_id && claims.org_id !== mapping.orgId) {
        otherOrgSession = claims
      }
    }
  }
  // Private doc with an expired/missing access token but a refresh token →
  // refresh server-side so the reader isn't bounced to login every hour.
  // Skipped when the token is valid-for-another-org, since refreshing a
  // wrong-org token just produces another wrong-org token.
  if (!session && !otherOrgSession && mapping.isPrivate) {
    const refresh = cookies.get(REFRESH_COOKIE)?.value
    if (refresh) {
      session = await refreshSession(refresh, authEnv, cookies, url.protocol === 'https:', mapping.orgId)
    }
  }
  locals.session = session
  locals.otherOrgSession = otherOrgSession

  // Private docs: content pages require a valid session AND access to THIS doc.
  // Bypass paths stay reachable; API search/ask self-gate against locals.session.
  if (mapping.isPrivate && !isBypass(url.pathname)) {
    if (!session) {
      if (otherOrgSession) {
        // Signed in to a different org — /login would just bounce them back
        // here. /no-access lets them switch accounts.
        return context.redirect('/no-access', 302)
      }
      const returnTo = url.pathname + url.search
      return context.redirect(`/login?return=${encodeURIComponent(returnTo)}`, 302)
    }
    if (!canAccessDoc(session, mapping)) {
      // Logged in but not granted this doc (e.g. a reader without a grant for it).
      // Render the themed `/no-access` page instead of a bare text response.
      return context.redirect('/no-access', 302)
    }
  }

  return next()
})
