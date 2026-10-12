import type { APIRoute } from 'astro'
import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { clearContentCache } from '../lib/contentSource'
import { reindexSite } from '../lib/search/reindex'

export const prerender = false

/**
 * POST /api/publish — self-hosted publish. Node-only (registered by
 * astro.node.config.mjs; the Workers build never sees it).
 *
 *   curl -X POST $URL/api/publish \
 *     -H "Authorization: Bearer $PUBLISH_TOKEN" \
 *     -H "Content-Type: application/gzip" \
 *     --data-binary @docs.tar.gz
 *
 * The body is a .tar.gz of the docs folder (gitdocai.json at its root). It is
 * unpacked in a temp dir, rendered by render-cli straight into DATA_DIR, and
 * the in-process caches are dropped so the next request serves the new doc.
 *
 * Disabled unless PUBLISH_TOKEN is set.
 */

let busy = false

/** `Acme Docs` → `acme-docs`. */
function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function tokenOk(header: string | null, expected: string): boolean {
  const given = (header ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function run(cmd: string, args: string[], input?: string, timeoutMs = 300_000) {
  return new Promise<{ code: number; out: string; err: string }>((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => {
      clearTimeout(t)
      rej(e)
    })
    p.on('close', (code) => {
      clearTimeout(t)
      res({ code: code ?? 1, out, err })
    })
    p.stdin.end(input)
  })
}

export const POST: APIRoute = async ({ request }) => {
  const expected = process.env.PUBLISH_TOKEN
  if (!expected) return json({ error: 'publishing is disabled (PUBLISH_TOKEN is not set)' }, 404)
  if (!tokenOk(request.headers.get('authorization'), expected)) {
    return json({ error: 'unauthorized' }, 401)
  }
  if (!request.body) return json({ error: 'empty body: send a .tar.gz of the docs folder' }, 400)
  if (busy) return json({ error: 'another publish is in progress' }, 409)

  busy = true
  const work = await mkdtemp(join(tmpdir(), 'gitdoc-publish-'))
  try {
    // 1. Stream the upload to disk, bounded.
    const maxBytes = Number(process.env.PUBLISH_MAX_MB ?? 200) * 1024 * 1024
    const archive = join(work, 'docs.tar.gz')
    let received = 0
    const limited = Readable.fromWeb(request.body as never)
    limited.on('data', (c: Buffer) => {
      received += c.length
      if (received > maxBytes) limited.destroy(new Error('payload too large'))
    })
    try {
      await pipeline(limited, createWriteStream(archive))
    } catch (e) {
      return json({ error: (e as Error).message }, received > maxBytes ? 413 : 400)
    }

    // 2. Inspect before extracting: only regular files and directories,
    //    nothing absolute, no `..` (a hostile tar must not escape the temp dir).
    const list = await run('tar', ['-tvzf', archive])
    if (list.code !== 0) return json({ error: 'not a valid .tar.gz' }, 400)
    for (const line of list.out.split('\n').filter(Boolean)) {
      const type = line[0]
      const name = line.replace(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/, '')
      if ((type !== '-' && type !== 'd') || /(^|\/)\.\.(\/|$)/.test(name) || name.startsWith('/')) {
        return json({ error: `archive entry not allowed: ${name}` }, 400)
      }
    }
    const src = join(work, 'src')
    await run('mkdir', ['-p', src])
    const ex = await run('tar', ['-xzf', archive, '-C', src, '--no-same-owner'])
    if (ex.code !== 0) return json({ error: `could not extract: ${ex.err.trim()}` }, 400)

    // 3. Mapping from the manifest.
    let manifest: { id?: string; organization_id?: string; format?: number; name?: string; [k: string]: unknown }
    try {
      manifest = JSON.parse(await readFile(join(src, 'gitdocai.json'), 'utf-8'))
    } catch {
      return json({ error: 'gitdocai.json not found at the archive root' }, 422)
    }
    // Backup manifests carry their ids; docstore sites (`format`) don't, and
    // render-cli derives them from the site key when they're left blank.
    if (!manifest.id && manifest.format === undefined) {
      return json({ error: 'gitdocai.json has neither an "id" nor a "format"' }, 422)
    }

    const dataDir = resolve(process.env.DATA_DIR || './data')
    // Which site this is: explicit hostname, else the server default, else one
    // derived from the site itself (`<name>.localhost`, which browsers resolve
    // to this machine) so several docs on one server don't overwrite each other.
    const siteKey = (manifest['x-site-key'] as string | undefined) || manifest.name || ''
    const derived = slugify(siteKey) ? `${slugify(siteKey)}.localhost` : 'localhost'
    const hostname =
      new URL(request.url).searchParams.get('hostname') || process.env.PUBLISH_HOSTNAME || derived
    const input = {
      output: { kind: 'fs', dir: dataDir },
      mappings: [
        {
          hostname,
          org_id: manifest.organization_id || '',
          doc_id: manifest.id || '',
          is_private: process.env.DOCS_PRIVATE === 'true',
        },
      ],
      source: { kind: 'local', content_dir: src },
    }

    // 4. Render into DATA_DIR with the same render-cli the SaaS uses.
    const cli = resolve(process.env.RENDER_CLI_PATH || '../render-cli/dist/cli.js')
    const r = await run('node', [cli, 'publish'], JSON.stringify(input))
    let result: { status?: string; errors?: unknown[] } | null = null
    try {
      result = JSON.parse(r.out)
    } catch {
      /* fall through */
    }
    if (!result || result.status === 'failed') {
      return json({ error: 'render failed', details: result?.errors ?? r.err.trim().slice(-500) }, 500)
    }

    clearContentCache()

    // 5. Index the pages for search. The site is already live, so a search
    //    backend that is down degrades search, not the publish.
    let search: Record<string, unknown>
    try {
      search = { ...(await reindexSite(hostname)) }
    } catch (e) {
      search = { error: (e as Error).message }
    }
    return json({ ok: true, hostname, result, search })
  } finally {
    busy = false
    await rm(work, { recursive: true, force: true })
  }
}
