import http from 'node:http'
import https from 'node:https'
import type { Embedder } from '../ai'
import { plainText } from './text'
import type { IndexReport, Passage, SearchBackend, SearchDoc, SearchQuery, SearchResult, SiteRef } from './types'


/**
 * OpenSearch over its REST API (no client library).
 *
 * Index name, document fields, mapping and query are the hosted product's:
 * `doc_{orgId}_{docId}`, `doc_embedding` as a `knn_vector`, title boosted ×2,
 * a `knn` clause next to the text clauses, `<mark>` highlighting. An index
 * written by the hosted pipeline is therefore readable here and vice versa.
 *
 * Semantic search is opt-in: give it an embeddings model (see lib/ai). Without
 * one the index is text-only.
 */

export interface OpenSearchOptions {
  url: string
  username?: string
  password?: string
  /** Accept a self-signed certificate (the default in OpenSearch's image). */
  insecure?: boolean
  embedder?: Embedder
}

interface Reply {
  status: number
  body: string
}

const BATCH = 100
// Embedding models have a context limit; a page's first screens carry the topic.
const EMBED_CHARS = 6000

export class OpenSearchBackend implements SearchBackend {
  readonly name = 'opensearch'
  private readonly base: URL
  private readonly auth?: string
  private readonly insecure: boolean
  private readonly embedder?: Embedder

  constructor(opts: OpenSearchOptions) {
    this.base = new URL(opts.url)
    const user = opts.username ?? decodeURIComponent(this.base.username)
    const pass = opts.password ?? decodeURIComponent(this.base.password)
    if (user) this.auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    this.base.username = ''
    this.base.password = ''
    this.insecure = !!opts.insecure
    this.embedder = opts.embedder
  }

  static indexName(site: SiteRef): string {
    // OpenSearch index names: lowercase, no spaces or `\/*?"<>|,#`.
    return `doc_${site.orgId}_${site.docId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '_')
  }

  private request(method: string, path: string, body?: string, contentType = 'application/json'): Promise<Reply> {
    const url = new URL(path.replace(/^\//, ''), this.base.href.endsWith('/') ? this.base.href : this.base.href + '/')
    const lib = url.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method,
          rejectUnauthorized: !this.insecure,
          timeout: 30_000,
          headers: {
            ...(body !== undefined ? { 'content-type': contentType, 'content-length': Buffer.byteLength(body) } : {}),
            ...(this.auth ? { authorization: this.auth } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        },
      )
      req.on('timeout', () => req.destroy(new Error('OpenSearch request timed out')))
      req.on('error', reject)
      req.end(body)
    })
  }

  private async json(method: string, path: string, body?: unknown, ok: number[] = []): Promise<any> {
    const r = await this.request(method, path, body === undefined ? undefined : JSON.stringify(body))
    if ((r.status < 200 || r.status >= 300) && !ok.includes(r.status)) {
      throw new Error(`OpenSearch ${method} ${path} → ${r.status}: ${r.body.slice(0, 300)}`)
    }
    try {
      return JSON.parse(r.body)
    } catch {
      return {}
    }
  }

  private mapping(dim?: number) {
    const keyword = { type: 'keyword' }
    return {
      settings: { 'index.knn': !!dim, number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        properties: {
          id: keyword,
          org_id: keyword,
          doc_id: keyword,
          version_id: keyword,
          section_id: keyword,
          entry_id: keyword,
          path: keyword,
          title: { type: 'text', fields: { keyword } },
          content: { type: 'text', analyzer: 'standard' },
          doc_type: keyword,
          word_count: { type: 'integer' },
          generated_at: { type: 'date', format: 'strict_date_optional_time||epoch_millis' },
          ...(dim
            ? {
                doc_embedding: {
                  type: 'knn_vector',
                  dimension: dim,
                  method: {
                    engine: 'lucene',
                    space_type: 'cosinesimil',
                    name: 'hnsw',
                    parameters: { ef_construction: 128, m: 24 },
                  },
                },
              }
            : {}),
        },
      },
    }
  }

  async replace(site: SiteRef, docs: SearchDoc[]): Promise<IndexReport> {
    const index = OpenSearchBackend.indexName(site)
    const texts = docs.map((d) => plainText(d.content))
    let warning: string | undefined

    // Embed first: the vector dimension decides the index mapping.
    let vectors: number[][] | null = null
    if (this.embedder && docs.length) {
      try {
        vectors = []
        for (let i = 0; i < docs.length; i += 32) {
          const part = docs.slice(i, i + 32).map((d, j) => `${d.title}\n${texts[i + j]}`.slice(0, EMBED_CHARS))
          vectors.push(...(await this.embedder.embed(part)))
        }
      } catch (e) {
        vectors = null
        warning = `embeddings unavailable, indexed text only: ${(e as Error).message}`
      }
    }
    const dim = vectors?.[0]?.length

    const head = await this.request('HEAD', index)
    if (head.status === 404) {
      await this.json('PUT', index, this.mapping(dim))
    } else if (dim) {
      // Existing index: its vector field must agree with the model in use.
      const m = await this.json('GET', `${index}/_mapping`)
      const have = m?.[index]?.mappings?.properties?.doc_embedding?.dimension
      if (have && have !== dim) {
        throw new Error(
          `index ${index} holds ${have}-dim vectors but the embedding model returns ${dim}; ` +
            `delete the index (DELETE /${index}) and publish again`,
        )
      }
    }

    // Upsert by entry id, then drop whatever this run didn't touch: the
    // doc stays searchable throughout (no delete-then-create gap).
    const stamp = new Date().toISOString()
    for (let i = 0; i < docs.length; i += BATCH) {
      const lines: string[] = []
      docs.slice(i, i + BATCH).forEach((d, j) => {
        const k = i + j
        lines.push(JSON.stringify({ index: { _index: index, _id: d.entry_id } }))
        lines.push(
          JSON.stringify({
            id: d.entry_id,
            org_id: site.orgId,
            doc_id: site.docId,
            version_id: d.version_id,
            section_id: d.section_id,
            entry_id: d.entry_id,
            path: d.path,
            title: d.title,
            content: texts[k],
            doc_type: 'doc_entry',
            word_count: texts[k].split(/\s+/).filter(Boolean).length,
            generated_at: stamp,
            ...(vectors && vectors[k] ? { doc_embedding: vectors[k] } : {}),
          }),
        )
      })
      const r = await this.request('POST', '_bulk', lines.join('\n') + '\n', 'application/x-ndjson')
      const parsed = r.status < 300 ? JSON.parse(r.body) : null
      if (!parsed || parsed.errors) {
        const first = parsed?.items?.find((it: any) => it.index?.error)?.index?.error
        throw new Error(`OpenSearch bulk index failed: ${first ? JSON.stringify(first).slice(0, 300) : r.status}`)
      }
    }
    await this.json('POST', `${index}/_refresh`)
    await this.json('POST', `${index}/_delete_by_query?refresh=true&conflicts=proceed`, {
      query: { range: { generated_at: { lt: stamp } } },
    })

    return { backend: this.name, indexed: docs.length, semantic: !!dim, warning }
  }

  async remove(site: SiteRef): Promise<void> {
    await this.json('DELETE', OpenSearchBackend.indexName(site), undefined, [404])
  }

  private async query(site: SiteRef, q: SearchQuery, source: string[], highlight: boolean, size: number) {
    const index = OpenSearchBackend.indexName(site)

    let vector: number[] | null = null
    if (this.embedder) {
      try {
        vector = (await this.embedder.embed([q.query]))[0] ?? null
      } catch {
        vector = null // text-only, like the hosted search does
      }
    }

    const must: unknown[] = [{ term: { doc_type: 'doc_entry' } }]
    if (q.versionId) must.push({ term: { version_id: q.versionId } })
    const should: unknown[] = [
      { match: { title: { query: q.query, boost: 2.0 } } },
      { match: { content: { query: q.query, boost: 1.0 } } },
    ]
    if (vector) should.push({ knn: { doc_embedding: { vector, k: size } } })

    const r = await this.json(
      'POST',
      `${index}/_search`,
      {
        size,
        query: { bool: { must, should, minimum_should_match: 1 } },
        _source: source,
        ...(highlight
          ? {
              highlight: {
                pre_tags: ['<mark>'],
                post_tags: ['</mark>'],
                fields: {
                  title: { fragment_size: 100, number_of_fragments: 1 },
                  content: { fragment_size: 150, number_of_fragments: 3 },
                },
              },
            }
          : {}),
      },
      [404], // never published → nothing to find
    )
    return (r?.hits?.hits ?? []) as any[]
  }

  async search(site: SiteRef, q: SearchQuery): Promise<SearchResult[]> {
    const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 50) : 10
    const hits = await this.query(site, q, ['entry_id', 'section_id', 'version_id', 'path', 'title'], true, limit)
    return hits.map((h) => ({
      version_id: h._source?.version_id ?? '',
      section_id: h._source?.section_id ?? '',
      entry_id: h._source?.entry_id ?? '',
      path: h._source?.path ?? '',
      title: h._source?.title ?? '',
      highlights: [...(h.highlight?.title ?? []), ...(h.highlight?.content ?? [])],
      score: h._score ?? 0,
    }))
  }

  /** Whole pages (the hosted index is page-level), trimmed to a prompt-sized excerpt. */
  async passages(site: SiteRef, q: SearchQuery): Promise<Passage[]> {
    const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 20) : 6
    const hits = await this.query(
      site,
      q,
      ['entry_id', 'section_id', 'version_id', 'path', 'title', 'content'],
      false,
      limit,
    )
    return hits.map((h) => ({
      version_id: h._source?.version_id ?? '',
      section_id: h._source?.section_id ?? '',
      entry_id: h._source?.entry_id ?? '',
      path: h._source?.path ?? '',
      title: h._source?.title ?? '',
      text: String(h._source?.content ?? '').slice(0, 3000),
      score: h._score ?? 0,
    }))
  }
}
