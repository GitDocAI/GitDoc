/**
 * Search is a port: the server talks to a `SearchBackend` and never to a
 * concrete engine. Two adapters ship:
 *
 *   embedded    in-process BM25, no services (default)
 *   opensearch  OpenSearch over REST, same index shape the hosted product uses
 *
 * Field names are snake_case on purpose: they are the document fields of the
 * hosted product's OpenSearch index, so an index written by either side can be
 * read by the other.
 */

/** Identifies one documentation. Backends key their index on it. */
export interface SiteRef {
  orgId: string
  docId: string
}

/** One page, as the renderer emits it in `docs/{docId}/search-docs.json`. */
export interface SearchDoc {
  entry_id: string
  section_id: string
  version_id: string
  /** Site URL path, used to link the result. */
  path: string
  title: string
  /** Markdown/MDX source of the page. */
  content: string
}

export interface SearchQuery {
  query: string
  versionId?: string
  limit?: number
}

/** The shape `/api/search` returns (and the palette consumes). */
export interface SearchResult {
  version_id: string
  section_id: string
  entry_id: string
  path: string
  title: string
  /** Fragments with matches wrapped in `<mark>…</mark>`. */
  highlights: string[]
  score: number
}

/** A piece of a page, for answering questions (RAG). */
export interface Passage {
  entry_id: string
  section_id: string
  version_id: string
  path: string
  title: string
  /** Heading the passage sits under, when known. */
  heading?: string
  text: string
  score: number
}

export interface IndexReport {
  backend: string
  indexed: number
  /** True when the pages were also embedded for semantic search. */
  semantic: boolean
  warning?: string
}

export interface SearchBackend {
  readonly name: string
  /** Make `docs` the whole searchable content of `site` (publish replaces). */
  replace(site: SiteRef, docs: SearchDoc[]): Promise<IndexReport>
  /** Drop everything indexed for `site`. */
  remove(site: SiteRef): Promise<void>
  search(site: SiteRef, q: SearchQuery): Promise<SearchResult[]>
  /** The passages most relevant to `q`, with their text. Used by Ask. */
  passages(site: SiteRef, q: SearchQuery): Promise<Passage[]>
}
