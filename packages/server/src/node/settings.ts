import type { APIRoute } from 'astro'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { effectiveQuota, loadSettings, parseSettings, saveSettings } from '../lib/settings'
import { readUsage } from '../lib/usage'

export const prerender = false

/**
 * Operator API for one site's runtime settings and usage. Node-only;
 * authenticated by PUBLISH_TOKEN.
 *
 *   GET /api/settings?hostname=…   stored settings and the effective quota
 *   PUT /api/settings?hostname=…   replace the stored settings (JSON body)
 *   GET /api/usage?hostname=…      what the site has consumed
 *
 * Settings are not part of the docs (see lib/settings.ts).
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function authorized(request: Request): Response | null {
  const expected = process.env.PUBLISH_TOKEN
  if (!expected) return json({ error: 'disabled (PUBLISH_TOKEN is not set)' }, 404)
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b) ? null : json({ error: 'unauthorized' }, 401)
}

async function docIdOf(request: Request): Promise<{ docId: string } | Response> {
  const hostname = new URL(request.url).searchParams.get('hostname')
  if (!hostname) return json({ error: 'hostname is required' }, 400)
  try {
    const dataDir = resolve(process.env.DATA_DIR || './data')
    const index = JSON.parse(await readFile(join(dataDir, '_domains', 'index.json'), 'utf-8'))
    const docId = index[hostname]?.docId as string | undefined
    if (docId) return { docId }
  } catch {
    /* nothing published */
  }
  return json({ error: `no site is published for ${hostname}` }, 404)
}

export const GET: APIRoute = async ({ request }) => {
  const denied = authorized(request)
  if (denied) return denied
  const site = await docIdOf(request)
  if (site instanceof Response) return site
  const path = new URL(request.url).pathname
  if (path === '/api/usage') return json(await readUsage(site.docId))
  return json({ settings: await loadSettings(site.docId), effective: { quota: await effectiveQuota(site.docId) } })
}

export const PUT: APIRoute = async ({ request }) => {
  const denied = authorized(request)
  if (denied) return denied
  const site = await docIdOf(request)
  if (site instanceof Response) return site
  let settings
  try {
    settings = parseSettings(await request.json())
  } catch (e) {
    return json({ error: (e as Error).message }, 400)
  }
  await saveSettings(site.docId, settings)
  return json({ ok: true, settings, effective: { quota: await effectiveQuota(site.docId) } })
}
