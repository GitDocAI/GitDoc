import type { APIRoute } from 'astro'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const prerender = false

/**
 * GET /api/sites — which documentations this server hosts and the hostname
 * each answers on. Node-only; authenticated by PUBLISH_TOKEN.
 */
export const GET: APIRoute = async ({ request }) => {
  const expected = process.env.PUBLISH_TOKEN
  if (!expected) return json({ error: 'disabled (PUBLISH_TOKEN is not set)' }, 404)
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: 'unauthorized' }, 401)

  const dataDir = resolve(process.env.DATA_DIR || './data')
  let index: Record<string, { orgId: string; docId: string; isPrivate: boolean }> = {}
  try {
    index = JSON.parse(await readFile(join(dataDir, '_domains', 'index.json'), 'utf-8'))
  } catch {
    /* nothing published yet */
  }
  const sites = await Promise.all(
    Object.entries(index).map(async ([hostname, m]) => {
      let name = ''
      let pages: number | undefined
      try {
        name = JSON.parse(await readFile(join(dataDir, 'docs', m.docId, 'documentation.json'), 'utf-8')).name ?? ''
      } catch {
        /* header missing */
      }
      try {
        pages = JSON.parse(await readFile(join(dataDir, 'docs', m.docId, 'pages-index.json'), 'utf-8')).length
      } catch {
        /* no index */
      }
      return { hostname, name, docId: m.docId, isPrivate: m.isPrivate, pages }
    }),
  )
  return json({ sites })
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
