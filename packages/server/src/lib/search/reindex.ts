import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { searchBackend } from './index'
import type { IndexReport, SearchDoc, SiteRef } from './types'

/**
 * Ingestion: make a site's published pages searchable.
 *
 * Publishing does it at once (the renderer writes `search-docs.json` and the
 * server indexes it). These helpers also cover everything that was published
 * without an index: by an older build, or by a process that wrote the files
 * directly. For those the corpus is rebuilt from what was stored, so nobody
 * has to republish by hand.
 */

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as T
  } catch {
    return null
  }
}

interface Entry {
  id: string
  title?: string
  slug?: string
  type?: string
  children?: Entry[]
}

/** The corpus of one documentation: the renderer's file, or rebuilt from the stored pages. */
export async function corpusFor(docId: string, env: Record<string, string | undefined> = process.env): Promise<SearchDoc[]> {
  const docDir = join(resolve(env.DATA_DIR || './data'), 'docs', docId)
  const written = await readJson<SearchDoc[]>(join(docDir, 'search-docs.json'))
  if (written) return written

  // Rebuild: default version → sections → entry tree → each page's markdown.
  const versions = (await readJson<{ id: string; is_default?: boolean; is_latest?: boolean }[]>(join(docDir, 'versions.json'))) ?? []
  const version = versions.find((v) => v.is_default) ?? versions.find((v) => v.is_latest) ?? versions[0]
  if (!version) return []
  const vDir = join(docDir, 'versions', version.id)
  const sections = (await readJson<{ id: string; slug?: string }[]>(join(vDir, 'sections.json'))) ?? []

  const docs: SearchDoc[] = []
  for (const section of sections) {
    const sDir = join(vDir, 'sections', section.id)
    const tree = await readJson<{ doc_entries?: Entry[] }>(join(sDir, 'tree.json'))
    const walk = async (nodes: Entry[], chain: string[]) => {
      for (const node of nodes) {
        const next = [...chain, node.slug ?? '']
        if (node.type === 'folder') {
          await walk(node.children ?? [], next)
          continue
        }
        let content = ''
        try {
          content = await readFile(join(sDir, 'entries', `${node.id}.md`), 'utf-8')
        } catch {
          content = (await readJson<{ content?: string }>(join(sDir, 'entries', `${node.id}.json`)))?.content ?? ''
        }
        if (!content) continue
        docs.push({
          entry_id: node.id,
          section_id: section.id,
          version_id: version.id,
          path: `/${[section.slug ?? '', ...next].filter(Boolean).join('/')}`,
          title: node.title ?? '',
          content,
        })
      }
    }
    await walk(tree?.doc_entries ?? [], [])
  }
  return docs
}

/** Index one documentation from its corpus. */
export async function reindexDoc(site: SiteRef, env: Record<string, string | undefined> = process.env): Promise<IndexReport> {
  return searchBackend(env).replace(site, await corpusFor(site.docId, env))
}

/** Index the site published under `hostname`. */
export async function reindexSite(
  hostname: string,
  env: Record<string, string | undefined> = process.env,
): Promise<IndexReport> {
  const dataDir = resolve(env.DATA_DIR || './data')
  const domains = JSON.parse(await readFile(join(dataDir, '_domains', 'index.json'), 'utf-8'))
  const m = domains[hostname] as { orgId?: string; docId?: string } | undefined
  if (!m?.docId) throw new Error(`no site is published for ${hostname}`)
  return reindexDoc({ orgId: m.orgId ?? '', docId: m.docId }, env)
}

const known = new Set<string>()
const inflight = new Map<string, Promise<void>>()

/**
 * Ingest `site` now if it has never been indexed (once; concurrent callers
 * share the work). Cheap when it already is: one check, then remembered.
 */
export async function ensureIndexed(site: SiteRef, env: Record<string, string | undefined> = process.env): Promise<void> {
  const key = `${site.orgId}/${site.docId}`
  if (known.has(key)) return
  const running = inflight.get(key)
  if (running) return running
  const job = (async () => {
    const backend = searchBackend(env)
    if (!(await backend.has(site))) {
      const docs = await corpusFor(site.docId, env)
      if (docs.length) await backend.replace(site, docs)
    }
    known.add(key)
  })().finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

/** Every site on this server that has no index yet. Best effort, in the background. */
export async function ensureAllIndexed(env: Record<string, string | undefined> = process.env): Promise<void> {
  const dataDir = resolve(env.DATA_DIR || './data')
  const domains = await readJson<Record<string, { orgId?: string; docId?: string }>>(join(dataDir, '_domains', 'index.json'))
  for (const [host, m] of Object.entries(domains ?? {})) {
    if (!m.docId) continue
    try {
      await ensureIndexed({ orgId: m.orgId ?? '', docId: m.docId }, env)
    } catch (e) {
      console.warn(`could not index ${host}: ${(e as Error).message}`)
    }
  }
}
