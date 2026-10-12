import type { APIRoute } from 'astro'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { clearContentCache } from '../lib/contentSource'
import { reindexSite } from '../lib/search/reindex'

export const prerender = false

/**
 * POST /api/reindex[?hostname=docs.example.com] — rebuild the search index of
 * one site (or all) from the files already on disk, and drop the in-process
 * caches. For setups where the files are written outside /api/publish.
 * Node-only; authenticated by PUBLISH_TOKEN.
 */
export const POST: APIRoute = async ({ request }) => {
  const expected = process.env.PUBLISH_TOKEN
  if (!expected) return json({ error: 'disabled (PUBLISH_TOKEN is not set)' }, 404)
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: 'unauthorized' }, 401)

  let hostnames: string[]
  const one = new URL(request.url).searchParams.get('hostname')
  if (one) hostnames = [one]
  else {
    try {
      const dataDir = resolve(process.env.DATA_DIR || './data')
      hostnames = Object.keys(JSON.parse(await readFile(join(dataDir, '_domains', 'index.json'), 'utf-8')))
    } catch {
      hostnames = []
    }
  }

  clearContentCache()
  const sites: Record<string, unknown> = {}
  for (const h of hostnames) {
    try {
      sites[h] = await reindexSite(h)
    } catch (e) {
      sites[h] = { error: (e as Error).message }
    }
  }
  const failed = Object.values(sites).some((s) => (s as { error?: string }).error)
  return json({ ok: !failed, sites }, failed ? 500 : 200)
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
