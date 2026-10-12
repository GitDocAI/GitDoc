import { resolve } from 'node:path'
import { aiFromEnv } from '../ai'
import { EmbeddedSearch } from './embedded'
import { OpenSearchBackend } from './opensearch'
import type { SearchBackend } from './types'

export type { IndexReport, Passage, SearchBackend, SearchDoc, SearchQuery, SearchResult, SiteRef } from './types'

let cached: { key: string; backend: SearchBackend } | undefined

/**
 * Choose the backend from the environment.
 *
 *   SEARCH_BACKEND=embedded|opensearch   (default: opensearch if OPENSEARCH_URL
 *                                         is set, else embedded)
 *   OPENSEARCH_URL, OPENSEARCH_USERNAME, OPENSEARCH_PASSWORD, OPENSEARCH_INSECURE
 *   AI_URL, AI_API_KEY, AI_API_SECRET, AI_EMBEDDING_MODEL   → semantic search
 *   SEARCH_MIN_SIMILARITY                                   (embedded; default 0.3)
 */
export function searchBackend(env: Record<string, string | undefined> = process.env): SearchBackend {
  const kind = env.SEARCH_BACKEND || (env.OPENSEARCH_URL ? 'opensearch' : 'embedded')
  const dataDir = resolve(env.DATA_DIR || './data')
  const key = JSON.stringify([kind, dataDir, env.OPENSEARCH_URL, env.AI_URL, env.AI_EMBEDDING_MODEL, env.SEARCH_MIN_SIMILARITY])
  if (cached?.key === key) return cached.backend

  const embedder = aiFromEnv(env)?.embedder ?? null
  let backend: SearchBackend
  if (kind === 'opensearch') {
    if (!env.OPENSEARCH_URL) throw new Error('SEARCH_BACKEND=opensearch needs OPENSEARCH_URL')
    backend = new OpenSearchBackend({
      url: env.OPENSEARCH_URL,
      username: env.OPENSEARCH_USERNAME,
      password: env.OPENSEARCH_PASSWORD,
      insecure: env.OPENSEARCH_INSECURE === 'true',
      embedder: embedder ?? undefined,
    })
  } else if (kind === 'embedded') {
    const min = Number(env.SEARCH_MIN_SIMILARITY)
    backend = new EmbeddedSearch(dataDir, { embedder, minSimilarity: Number.isFinite(min) && env.SEARCH_MIN_SIMILARITY ? min : undefined })
  } else {
    throw new Error(`unknown SEARCH_BACKEND "${kind}" (use embedded or opensearch)`)
  }
  cached = { key, backend }
  return backend
}
