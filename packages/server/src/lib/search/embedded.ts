import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Embedder } from '../ai'
import { LEXICAL_FLOOR_RATIO, chunkMarkdown, highlight, plainText, queryTerms, semanticCutoff, termsRequired, tokenize } from './text'
import type { IndexReport, Passage, SearchBackend, SearchDoc, SearchQuery, SearchResult, SiteRef } from './types'

/**
 * In-process hybrid search. No service, no native dependency.
 *
 *   lexical   BM25 over pages (title weighs double, like the hosted index)
 *   semantic  cosine over passages, when an embeddings model is configured
 *   fusion    reciprocal rank fusion of the two page rankings
 *
 * The corpus lives in DATA_DIR/_search (`<doc>.json` + `<doc>.vec`, float32,
 * L2-normalised) and is loaded lazily. Brute-force cosine is exact and, at
 * documentation scale (thousands of passages), takes milliseconds; an ANN
 * index only pays off far beyond that.
 */

const K1 = 1.2
const B = 0.75
const TITLE_BOOST = 2
const RRF_K = 60
const FORMAT = 2
const EMBED_BATCH = 32

interface StoredDoc {
  entry_id: string
  section_id: string
  version_id: string
  path: string
  title: string
  text: string
}
interface StoredChunk {
  doc: number
  heading: string
  text: string
}
interface Stored {
  format: number
  dim: number
  model: string
  docs: StoredDoc[]
  chunks: StoredChunk[]
}

interface FieldIndex {
  postings: Map<string, Map<number, number>>
  lengths: number[]
  avg: number
}

interface Loaded {
  mtimeMs: number
  s: Stored
  vectors: Float32Array | null
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
  return { postings, lengths, avg: lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0 }
}

function bm25(
  f: FieldIndex,
  term: string,
  n: number,
  into: Map<number, number>,
  weight: number,
  hit: Map<number, Set<string>>,
  key: string,
) {
  const p = f.postings.get(term)
  if (!p) return
  const idf = Math.log(1 + (n - p.size + 0.5) / (p.size + 0.5))
  for (const [doc, tf] of p) {
    const norm = 1 - B + B * ((f.lengths[doc] || 1) / (f.avg || 1))
    into.set(doc, (into.get(doc) ?? 0) + idf * ((tf * (K1 + 1)) / (tf + K1 * norm)) * weight)
    let h = hit.get(doc)
    if (!h) hit.set(doc, (h = new Set()))
    h.add(key)
  }
}

function normalise(v: number[]): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

export interface EmbeddedOptions {
  embedder?: Embedder | null
  /** Passages less similar than this to the query are ignored. */
  minSimilarity?: number
}

export class EmbeddedSearch implements SearchBackend {
  readonly name = 'embedded'
  private readonly dir: string
  private readonly cache = new Map<string, Loaded>()
  private readonly embedder: Embedder | null
  private readonly minSim: number

  constructor(dataDir: string, opts: EmbeddedOptions = {}) {
    this.dir = join(dataDir, '_search')
    this.embedder = opts.embedder ?? null
    this.minSim = opts.minSimilarity ?? 0.3
  }

  private file(site: SiteRef, ext: string): string {
    // docId is a UUID in practice; refuse anything that could leave `_search/`.
    if (!/^[\w.-]+$/.test(site.docId)) throw new Error('invalid doc id')
    return join(this.dir, `${site.docId}.${ext}`)
  }

  async replace(site: SiteRef, docs: SearchDoc[]): Promise<IndexReport> {
    const stored: Stored = { format: FORMAT, dim: 0, model: '', docs: [], chunks: [] }
    docs.forEach((d, i) => {
      stored.docs.push({
        entry_id: d.entry_id,
        section_id: d.section_id,
        version_id: d.version_id,
        path: d.path,
        title: d.title,
        text: plainText(d.content),
      })
      const chunks = chunkMarkdown(d.content)
      if (!chunks.length) chunks.push({ heading: '', text: stored.docs[i].text.slice(0, 1500) })
      for (const c of chunks) if (c.text) stored.chunks.push({ doc: i, heading: c.heading, text: c.text })
    })

    let vectors: Float32Array | null = null
    let warning: string | undefined
    if (this.embedder && stored.chunks.length) {
      try {
        const inputs = stored.chunks.map(
          (c) => `${stored.docs[c.doc].title}${c.heading ? ' › ' + c.heading : ''}\n${c.text}`.slice(0, 6000),
        )
        const rows: Float32Array[] = []
        for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
          for (const v of await this.embedder.embed(inputs.slice(i, i + EMBED_BATCH))) rows.push(normalise(v))
        }
        const dim = rows[0].length
        vectors = new Float32Array(rows.length * dim)
        rows.forEach((r, i) => vectors!.set(r, i * dim))
        stored.dim = dim
        stored.model = this.embedder.model
      } catch (e) {
        vectors = null
        warning = `embeddings unavailable, indexed text only: ${(e as Error).message}`
      }
    }

    const json = this.file(site, 'json')
    const vec = this.file(site, 'vec')
    await mkdir(this.dir, { recursive: true })
    const tmpJson = `${json}.${process.pid}.tmp`
    const tmpVec = `${vec}.${process.pid}.tmp`
    if (vectors) await writeFile(tmpVec, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength))
    await writeFile(tmpJson, JSON.stringify(stored))
    // Vectors first, the JSON last: the JSON is what readers key their cache on.
    if (vectors) await rename(tmpVec, vec)
    else await rm(vec, { force: true })
    await rename(tmpJson, json)
    this.cache.delete(json)
    return { backend: this.name, indexed: stored.docs.length, semantic: !!vectors, warning }
  }

  async remove(site: SiteRef): Promise<void> {
    const json = this.file(site, 'json')
    this.cache.delete(json)
    await rm(json, { force: true })
    await rm(this.file(site, 'vec'), { force: true })
  }

  async has(site: SiteRef): Promise<boolean> {
    try {
      return (await stat(this.file(site, 'json'))).size > 2
    } catch {
      return false
    }
  }

  private async load(site: SiteRef): Promise<Loaded | null> {
    const json = this.file(site, 'json')
    let st
    try {
      st = await stat(json)
    } catch {
      return null
    }
    const hit = this.cache.get(json)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit
    const s = JSON.parse(await readFile(json, 'utf-8')) as Stored
    if (s.format !== FORMAT) return null // written by an older build: republish
    let vectors: Float32Array | null = null
    if (s.dim) {
      try {
        const buf = await readFile(this.file(site, 'vec'))
        const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
        if (v.length === s.dim * s.chunks.length) vectors = v
      } catch {
        vectors = null
      }
    }
    const loaded: Loaded = {
      mtimeMs: st.mtimeMs,
      s,
      vectors,
      title: buildField(s.docs.map((d) => d.title)),
      content: buildField(s.docs.map((d) => d.text)),
    }
    this.cache.set(json, loaded)
    return loaded
  }

  /** Page ranking by BM25: [doc, score][] best first, plus the terms that matched. */
  private lexical(idx: Loaded, query: string, versionId?: string) {
    const terms = queryTerms(query)
    const n = idx.s.docs.length
    const scores = new Map<number, number>()
    const hit = new Map<number, Set<string>>()
    const matched = new Set<string>()
    terms.forEach((term, i) => {
      const variants = new Map<string, number>([[term, 1]])
      if (i === terms.length - 1 && term.length >= 2) {
        for (const v of new Set([...idx.title.postings.keys(), ...idx.content.postings.keys()])) {
          if (v !== term && v.startsWith(term)) variants.set(v, 0.5)
        }
      }
      for (const [v, w] of variants) {
        bm25(idx.title, v, n, scores, TITLE_BOOST * w, hit, term)
        bm25(idx.content, v, n, scores, w, hit, term)
        matched.add(v)
      }
    })
    const need = termsRequired(new Set(terms).size)
    const ranked = [...scores]
      .filter(([d]) => !versionId || idx.s.docs[d].version_id === versionId)
      .filter(([d]) => (hit.get(d)?.size ?? 0) >= need)
      .map(([d, s]) => [d, s * (0.5 + 0.5 * ((hit.get(d)?.size ?? 0) / (terms.length || 1)))] as const)
      .sort((a, b) => b[1] - a[1])
      // A page that matches only a sliver of what the best page does is noise.
      .filter(([, sc], _i, all) => sc >= all[0][1] * LEXICAL_FLOOR_RATIO)
    return { ranked, marks: [...matched] }
  }

  /** Passages by cosine to the query: [chunk, similarity][] best first. */
  private async semantic(idx: Loaded, query: string, versionId?: string) {
    if (!this.embedder || !idx.vectors) return []
    let q: Float32Array
    try {
      q = normalise((await this.embedder.embed([query]))[0])
    } catch {
      return [] // the model is down: lexical only
    }
    const dim = idx.s.dim
    if (q.length !== dim) return [] // the model changed since indexing
    const all: [number, number][] = []
    const bestOfPage = new Map<number, number>()
    for (let c = 0; c < idx.s.chunks.length; c++) {
      const doc = idx.s.chunks[c].doc
      if (versionId && idx.s.docs[doc].version_id !== versionId) continue
      let dot = 0
      const o = c * dim
      for (let i = 0; i < dim; i++) dot += q[i] * idx.vectors[o + i]
      all.push([c, dot])
      if (dot > (bestOfPage.get(doc) ?? -1)) bestOfPage.set(doc, dot)
    }
    // Judge the pages (their best passage), not the passages: a long page
    // would otherwise crowd the statistics.
    const cut = semanticCutoff([...bestOfPage.values()], this.minSim)
    if (cut === null) return []
    return all.filter(([, sim]) => sim >= cut).sort((a, b) => b[1] - a[1])
  }

  async search(site: SiteRef, q: SearchQuery): Promise<SearchResult[]> {
    const idx = await this.load(site)
    if (!idx || !tokenize(q.query).length) return []
    const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 50) : 10

    const lex = this.lexical(idx, q.query, q.versionId)
    const sem = await this.semantic(idx, q.query, q.versionId)

    // Best passage per page, in semantic order.
    const bestChunk = new Map<number, number>()
    for (const [c] of sem) {
      const d = idx.s.chunks[c].doc
      if (!bestChunk.has(d)) bestChunk.set(d, c)
    }

    const fused = new Map<number, number>()
    if (bestChunk.size) {
      lex.ranked.forEach(([d], r) => fused.set(d, (fused.get(d) ?? 0) + 1 / (RRF_K + r + 1)))
      let r = 0
      for (const d of bestChunk.keys()) fused.set(d, (fused.get(d) ?? 0) + 1 / (RRF_K + ++r))
    } else {
      for (const [d, s] of lex.ranked) fused.set(d, s)
    }

    return [...fused]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([d, score]) => {
        const doc = idx.s.docs[d]
        let highlights = [...highlight(doc.title, lex.marks, 1, 100), ...highlight(doc.text, lex.marks, 3, 150)]
        if (!highlights.length) {
          const c = bestChunk.get(d)
          if (c !== undefined) highlights = [idx.s.chunks[c].text.slice(0, 150)]
        }
        return {
          version_id: doc.version_id,
          section_id: doc.section_id,
          entry_id: doc.entry_id,
          path: doc.path,
          title: doc.title,
          highlights,
          score,
        }
      })
  }

  async passages(site: SiteRef, q: SearchQuery): Promise<Passage[]> {
    const idx = await this.load(site)
    if (!idx || !tokenize(q.query).length) return []
    const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 20) : 6
    const mk = (c: number, score: number): Passage => {
      const ch = idx.s.chunks[c]
      const d = idx.s.docs[ch.doc]
      return {
        entry_id: d.entry_id,
        section_id: d.section_id,
        version_id: d.version_id,
        path: d.path,
        title: d.title,
        heading: ch.heading || undefined,
        text: ch.text,
        score,
      }
    }

    const sem = await this.semantic(idx, q.query, q.versionId)
    const lex = this.lexical(idx, q.query, q.versionId)
    const picked = new Map<number, number>() // chunk → fused score

    if (sem.length) {
      sem.slice(0, limit * 2).forEach(([c], r) => picked.set(c, (picked.get(c) ?? 0) + 1 / (RRF_K + r + 1)))
    }
    // Lexical: the best chunk(s) of the best pages, by query-term overlap.
    const terms = new Set(lex.marks.length ? lex.marks : queryTerms(q.query))
    lex.ranked.slice(0, limit).forEach(([d], r) => {
      const best = idx.s.chunks
        .map((ch, c) => [c, ch] as const)
        .filter(([, ch]) => ch.doc === d)
        .map(([c, ch]) => [c, tokenize(ch.text + ' ' + ch.heading).filter((t) => terms.has(t)).length] as const)
        .sort((a, b) => b[1] - a[1])[0]
      if (best && best[1] > 0) picked.set(best[0], (picked.get(best[0]) ?? 0) + 1 / (RRF_K + r + 1))
    })

    return [...picked]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([c, s]) => mk(c, s))
  }
}
