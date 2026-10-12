import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { highlight, plainText, tokenize } from './text'
import type { IndexReport, SearchBackend, SearchDoc, SearchQuery, SearchResult, SiteRef } from './types'

/**
 * In-process BM25. No service, no native dependency: the corpus is a JSON file
 * in DATA_DIR and the inverted index is rebuilt in memory on first use (a few
 * thousand pages take milliseconds). Title weighs double content, like the
 * hosted index's boosts. Lexical only; semantic search needs a vector store,
 * which is what the OpenSearch adapter is for.
 */

const K1 = 1.2
const B = 0.75
const TITLE_BOOST = 2

interface StoredDoc {
  entry_id: string
  section_id: string
  version_id: string
  path: string
  title: string
  text: string
}

interface FieldIndex {
  postings: Map<string, Map<number, number>> // term → doc → tf
  lengths: number[]
  avg: number
}

interface Loaded {
  mtimeMs: number
  docs: StoredDoc[]
  title: FieldIndex
  content: FieldIndex
}

function buildField(texts: string[]): FieldIndex {
  const postings = new Map<string, Map<number, number>>()
  const lengths: number[] = []
  texts.forEach((t, i) => {
    const toks = tokenize(t)
    lengths.push(toks.length)
    for (const tok of toks) {
      let p = postings.get(tok)
      if (!p) postings.set(tok, (p = new Map()))
      p.set(i, (p.get(i) ?? 0) + 1)
    }
  })
  const avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0
  return { postings, lengths, avg }
}

function bm25(f: FieldIndex, term: string, n: number, into: Map<number, number>, weight: number, hit: Map<number, Set<string>>, key: string) {
  const p = f.postings.get(term)
  if (!p) return
  const idf = Math.log(1 + (n - p.size + 0.5) / (p.size + 0.5))
  for (const [doc, tf] of p) {
    const norm = 1 - B + B * ((f.lengths[doc] || 1) / (f.avg || 1))
    const s = idf * ((tf * (K1 + 1)) / (tf + K1 * norm)) * weight
    into.set(doc, (into.get(doc) ?? 0) + s)
    let h = hit.get(doc)
    if (!h) hit.set(doc, (h = new Set()))
    h.add(key)
  }
}

export class EmbeddedSearch implements SearchBackend {
  readonly name = 'embedded'
  private readonly dir: string
  private readonly cache = new Map<string, Loaded>()

  constructor(dataDir: string) {
    this.dir = join(dataDir, '_search')
  }

  private file(site: SiteRef): string {
    // docId is a UUID in practice; refuse anything that could leave `_search/`.
    if (!/^[\w.-]+$/.test(site.docId)) throw new Error('invalid doc id')
    return join(this.dir, `${site.docId}.json`)
  }

  async replace(site: SiteRef, docs: SearchDoc[]): Promise<IndexReport> {
    const stored: StoredDoc[] = docs.map((d) => ({
      entry_id: d.entry_id,
      section_id: d.section_id,
      version_id: d.version_id,
      path: d.path,
      title: d.title,
      text: plainText(d.content),
    }))
    const file = this.file(site)
    await mkdir(this.dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(stored))
    await rename(tmp, file) // readers never see a half-written index
    this.cache.delete(file)
    return { backend: this.name, indexed: stored.length, semantic: false }
  }

  async remove(site: SiteRef): Promise<void> {
    const file = this.file(site)
    this.cache.delete(file)
    await rm(file, { force: true })
  }

  private async load(site: SiteRef): Promise<Loaded | null> {
    const file = this.file(site)
    let st
    try {
      st = await stat(file)
    } catch {
      return null
    }
    const hit = this.cache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit
    const docs = JSON.parse(await readFile(file, 'utf-8')) as StoredDoc[]
    const loaded: Loaded = {
      mtimeMs: st.mtimeMs,
      docs,
      title: buildField(docs.map((d) => d.title)),
      content: buildField(docs.map((d) => d.text)),
    }
    this.cache.set(file, loaded)
    return loaded
  }

  async search(site: SiteRef, q: SearchQuery): Promise<SearchResult[]> {
    const idx = await this.load(site)
    const terms = tokenize(q.query)
    if (!idx || !terms.length) return []
    const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 50) : 10
    const n = idx.docs.length

    const scores = new Map<number, number>()
    const hit = new Map<number, Set<string>>() // doc → query terms it matched
    const matchedTerms = new Set<string>()
    terms.forEach((term, i) => {
      // Exact term; the last one also matches by prefix (search as you type).
      const variants = new Map<string, number>([[term, 1]])
      if (i === terms.length - 1 && term.length >= 2) {
        for (const v of new Set([...idx.title.postings.keys(), ...idx.content.postings.keys()])) {
          if (v !== term && v.startsWith(term)) variants.set(v, 0.5)
        }
      }
      for (const [v, w] of variants) {
        bm25(idx.title, v, n, scores, TITLE_BOOST * w, hit, term)
        bm25(idx.content, v, n, scores, w, hit, term)
        matchedTerms.add(v)
      }
    })

    const ranked = [...scores]
      .filter(([doc]) => !q.versionId || idx.docs[doc].version_id === q.versionId)
      // Documents that match more of the distinct query words rank higher.
      .map(([doc, s]) => [doc, s * (0.5 + 0.5 * ((hit.get(doc)?.size ?? 0) / terms.length))] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)

    const marks = [...matchedTerms]
    return ranked.map(([doc, score]) => {
      const d = idx.docs[doc]
      return {
        version_id: d.version_id,
        section_id: d.section_id,
        entry_id: d.entry_id,
        path: d.path,
        title: d.title,
        highlights: [...highlight(d.title, marks, 1, 100), ...highlight(d.text, marks, 3, 150)],
        score,
      }
    })
  }
}
