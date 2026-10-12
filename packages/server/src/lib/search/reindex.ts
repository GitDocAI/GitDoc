import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { searchBackend } from './index'
import type { IndexReport, SearchDoc } from './types'

/**
 * Rebuild the search index of one published site from the corpus the renderer
 * wrote (`docs/{docId}/search-docs.json`). Used after a publish through this
 * server and by `POST /api/reindex`, for installs where something else
 * (e.g. a control plane running render-cli on the shared volume) wrote the
 * files.
 */
export async function reindexSite(
  hostname: string,
  env: Record<string, string | undefined> = process.env,
): Promise<IndexReport> {
  const dataDir = resolve(env.DATA_DIR || './data')
  const domains = JSON.parse(await readFile(join(dataDir, '_domains', 'index.json'), 'utf-8'))
  const m = domains[hostname] as { orgId?: string; docId?: string } | undefined
  if (!m?.docId) throw new Error(`no site is published for ${hostname}`)
  const docs = JSON.parse(await readFile(join(dataDir, 'docs', m.docId, 'search-docs.json'), 'utf-8')) as SearchDoc[]
  return searchBackend(env).replace({ orgId: m.orgId ?? '', docId: m.docId }, docs)
}
