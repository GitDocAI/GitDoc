import { resolve } from 'node:path'
import { EmbeddedSearch } from './embedded'
import { HttpEmbedder, OpenSearchBackend } from './opensearch'
import type { SearchBackend } from './types'

export type { IndexReport, SearchBackend, SearchDoc, SearchQuery, SearchResult, SiteRef } from './types'

let cached: { key: string; backend: SearchBackend } | undefined

/**
 * Choose the backend from the environment.
 *
 *   SEARCH_BACKEND=embedded|opensearch   (default: opensearch if OPENSEARCH_URL
 *                                         is set, else embedded)
 *   OPENSEARCH_URL, OPENSEARCH_USERNAME, OPENSEARCH_PASSWORD, OPENSEARCH_INSECURE
 *   EMBEDDINGS_URL, EMBEDDINGS_MODEL, EMBEDDINGS_API_KEY   (semantic, opensearch only)
 */
export function searchBackend(env: Record<string, string | undefined> = process.env): SearchBackend {
  const kind = env.SEARCH_BACKEND || (env.OPENSEARCH_URL ? 'opensearch' : 'embedded')
  const dataDir = resolve(env.DATA_DIR || './data')
  const key = JSON.stringify([kind, dataDir, env.OPENSEARCH_URL, env.EMBEDDINGS_URL, env.EMBEDDINGS_MODEL])
  if (cached?.key === key) return cached.backend

  let backend: SearchBackend
  if (kind === 'opensearch') {
    if (!env.OPENSEARCH_URL) throw new Error('SEARCH_BACKEND=opensearch needs OPENSEARCH_URL')
    backend = new OpenSearchBackend({
      url: env.OPENSEARCH_URL,
      username: env.OPENSEARCH_USERNAME,
      password: env.OPENSEARCH_PASSWORD,
      insecure: env.OPENSEARCH_INSECURE === 'true',
      embedder: env.EMBEDDINGS_URL
        ? new HttpEmbedder(env.EMBEDDINGS_URL, env.EMBEDDINGS_MODEL || 'text-embedding-3-small', env.EMBEDDINGS_API_KEY)
        : undefined,
    })
  } else if (kind === 'embedded') {
    backend = new EmbeddedSearch(dataDir)
  } else {
    throw new Error(`unknown SEARCH_BACKEND "${kind}" (use embedded or opensearch)`)
  }
  cached = { key, backend }
  return backend
}
