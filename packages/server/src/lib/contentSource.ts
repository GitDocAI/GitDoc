import type { DomainMapping } from './types'
import type { BucketLike, KVLike } from './storage'

/**
 * Worker-side content source. Reads directly from KV + R2 bindings.
 * Paths mirror the content-runtime API shape 1:1 so the React app's
 * existing services (documentation.service.ts) keep working unchanged
 * — only the data now comes from R2 instead of a live backend.
 *
 * R2 layout written by the render-cli. Keyed by docId only — doc IDs
 * are globally unique UUIDs, so orgId adds no disambiguation:
 *   docs/{docId}/documentation.json
 *   docs/{docId}/versions.json
 *   docs/{docId}/versions/{versionId}/sections.json
 *   docs/{docId}/versions/{versionId}/sections/{sectionId}/tree.json
 *   docs/{docId}/versions/{versionId}/sections/{sectionId}/entries/{entryId}.json
 */
// In-isolate cache for R2 reads. Public pages are served straight from the
// Cloudflare edge cache (Worker never runs), but PRIVATE pages can't be cached
// — the assembled HTML gates on per-request auth (`no-store`). That left every
// private navigation re-running the SSR path: ~4 serial R2 round-trips
// (documentation → versions → sections → tree → entry html), which is the
// second-or-so lag readers feel on each page change.
//
// The underlying R2 objects, though, are identical for every user and only
// change on publish, so caching them here is safe (auth already ran in the
// middleware before any read) and turns a warm private navigation into ~0 R2
// reads. The viewport prefetch helps even more: its request reaches the Worker
// and populates this cache even though the browser discards the no-store body,
// so the real click reads from memory.
//
// TTL matches the public pages' `max-age=60`, so the post-publish staleness
// window is identical either way. Bounded by insertion order (Map keeps it) so
// a long-lived isolate serving a large doc can't grow without limit.
// `astro dev` (local preview): no in-isolate cache, so a republish shows up on reload.
const R2_CACHE_TTL_MS = import.meta.env.DEV ? 0 : 60_000
const R2_CACHE_MAX_ENTRIES = 256
interface R2CacheEntry {
  value: unknown
  exp: number
}
const r2Cache = new Map<string, R2CacheEntry>()

function cacheRead<T>(key: string): { hit: boolean; value: T | null } {
  const entry = r2Cache.get(key)
  if (!entry) return { hit: false, value: null }
  if (entry.exp <= Date.now()) {
    r2Cache.delete(key)
    return { hit: false, value: null }
  }
  return { hit: true, value: entry.value as T | null }
}

function cacheWrite(key: string, value: unknown): void {
  if (r2Cache.size >= R2_CACHE_MAX_ENTRIES) {
    const oldest = r2Cache.keys().next().value
    if (oldest !== undefined) r2Cache.delete(oldest)
  }
  r2Cache.set(key, { value, exp: Date.now() + R2_CACHE_TTL_MS })
}

const DOMAIN_INDEX_KEY = '_domains/index.json'
const DOMAIN_INDEX_TTL_MS = 60_000
type DomainIndex = Record<string, DomainMapping>
let domainIndexCache: { value: DomainIndex; exp: number } | null = null
let domainIndexInflight: Promise<DomainIndex> | null = null

/** Drop every cached read (after an in-process publish, so changes show immediately). */
export function clearContentCache(): void {
  r2Cache.clear()
  domainIndexCache = null
}

export class ContentSource {
  constructor(
    private readonly kv: KVLike,
    private readonly r2: BucketLike,
  ) {}

  async resolveDomain(hostname: string): Promise<DomainMapping | null> {
    const index = await this.loadDomainIndex()
    const hit = index[hostname]
    if (hit) return hit
    try {
      return await this.kv.get<DomainMapping>(hostname, { type: 'json', cacheTtl: 300 })
    } catch {
      return null
    }
  }

  /** Every hostname that has a doc published (self-hosted installs only expose this). */
  async hostnames(): Promise<string[]> {
    return Object.keys(await this.loadDomainIndex()).sort()
  }

  /** The only published doc, when the install hosts exactly one (single-site mode). */
  async soleDomain(): Promise<DomainMapping | null> {
    const entries = Object.values(await this.loadDomainIndex())
    return entries.length === 1 ? entries[0] : null
  }

  private async loadDomainIndex(): Promise<DomainIndex> {
    const now = Date.now()
    if (domainIndexCache && domainIndexCache.exp > now) return domainIndexCache.value
    if (domainIndexInflight) return domainIndexInflight
    domainIndexInflight = (async () => {
      try {
        const obj = await this.r2.get(DOMAIN_INDEX_KEY)
        const value = obj ? await obj.json<DomainIndex>() : {}
        domainIndexCache = { value, exp: Date.now() + DOMAIN_INDEX_TTL_MS }
        return value
      } catch {
        return domainIndexCache?.value ?? {}
      } finally {
        domainIndexInflight = null
      }
    })()
    return domainIndexInflight
  }

  async readJson<T>(key: string): Promise<T | null> {
    const cached = cacheRead<T>(key)
    if (cached.hit) return cached.value
    const obj = await this.r2.get(key)
    const value = obj ? await obj.json<T>() : null
    cacheWrite(key, value)
    return value
  }

  async readText(key: string): Promise<string | null> {
    const cached = cacheRead<string>(key)
    if (cached.hit) return cached.value
    const obj = await this.r2.get(key)
    const value = obj ? await obj.text() : null
    cacheWrite(key, value)
    return value
  }

  // Key helpers — keep in sync with the render-cli uploader.
  documentationKey(m: DomainMapping): string {
    return `docs/${m.docId}/documentation.json`
  }
  versionsKey(m: DomainMapping): string {
    return `docs/${m.docId}/versions.json`
  }
  sectionsKey(m: DomainMapping, versionId: string): string {
    return `docs/${m.docId}/versions/${versionId}/sections.json`
  }
  entryTreeKey(m: DomainMapping, versionId: string, sectionId: string): string {
    return `docs/${m.docId}/versions/${versionId}/sections/${sectionId}/tree.json`
  }
  entryKey(m: DomainMapping, versionId: string, sectionId: string, entryId: string): string {
    return `docs/${m.docId}/versions/${versionId}/sections/${sectionId}/entries/${entryId}.json`
  }
  /** Clean markdown of one entry — served at the `…​.md` page routes. */
  entryMdKey(m: DomainMapping, versionId: string, sectionId: string, entryId: string): string {
    return `docs/${m.docId}/versions/${versionId}/sections/${sectionId}/entries/${entryId}.md`
  }
  /** Flat list of the default version's public pages — sitemap + llms.txt. */
  pagesIndexKey(m: DomainMapping): string {
    return `docs/${m.docId}/pages-index.json`
  }
}

/** One row of `pages-index.json`, written by the render-cli at publish. */
export interface PageIndexEntry {
  path: string
  title: string
  description?: string
  lastmod?: string
}

/**
 * Shared helper for API routes. Pulls the caller's hostname from the
 * Host header (or the DEBUG `X-Dev-Domain` override that matches the
 * existing content-runtime dev flow) and resolves to a mapping.
 */
export async function resolveFromRequest(
  request: Request,
  source: ContentSource,
  // Widened to `unknown` so callers can pass the full Cloudflare `Env`
  // without TypeScript complaining about extra bindings. We only poke
  // at `DEV_HOSTNAME` here.
  env?: Record<string, unknown>,
): Promise<DomainMapping | Response> {
  // Resolution order:
  //   1. `X-Dev-Domain` header — matches the content-runtime dev flow;
  //      useful when testing the Worker with curl/Postman.
  //   2. `DEV_HOSTNAME` env var — wrangler/astro dev doesn't receive
  //      a meaningful Host header (browser sends "localhost:4324"), so
  //      we use the `DEV_HOSTNAME` env var to route to the right doc.
  //   3. Request's Host header — production behavior.
  const devDomain = request.headers.get('x-dev-domain')?.trim()
  const rawDevEnv = env?.['DEV_HOSTNAME']
  const devEnv = typeof rawDevEnv === 'string' ? rawDevEnv.trim() : undefined
  const requestHost = request.headers.get('host') || new URL(request.url).hostname

  const isLocalHost = /^localhost(:|$)/.test(requestHost) || /^127\.0\.0\.1/.test(requestHost)
  const effective = devDomain || (isLocalHost ? devEnv : '') || requestHost

  let mapping = await source.resolveDomain(effective.split(':')[0] ?? effective)
  // OSS single-site mode: one doc published → answer on whatever host reached us.
  if (!mapping && env?.['SINGLE_SITE'] === 'true') mapping = await source.soleDomain()
  if (!mapping) {
    return new Response(
      JSON.stringify({ error: 'no documentation configured for hostname', hostname: effective }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )
  }
  return mapping
}
