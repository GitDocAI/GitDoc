import type {
  ContentRuntimeSource,
  DocEntryLike,
  DocumentationLike,
  SectionLike,
  VersionLike,
} from '../types'

/**
 * Streams documentation data from a content-runtime instance. Mirrors
 * exactly the endpoints publish-web already consumes, so we inherit
 * the same resolution semantics (hostname → doc, versioning, section
 * tree vs single entry). Nothing here is cached — callers fetch once
 * per publish run and stream through pages one at a time.
 */
export class ContentRuntimeClient {
  private readonly base: string
  private readonly headers: Record<string, string>

  constructor(source: ContentRuntimeSource) {
    this.base = source.base_url.replace(/\/$/, '')
    this.headers = {
      'Accept': 'application/json',
      // content-runtime resolves the doc by hostname. In prod (DevMode
      // off) the middleware ignores `X-Dev-Domain` and falls back to
      // `Origin` → `Host`. We send both: X-Dev-Domain wins in dev,
      // Origin wins in prod. The Host header can't be reliably overridden
      // by fetch when we're going through a load balancer anyway.
      'X-Dev-Domain': source.hostname,
      'Origin': `https://${source.hostname}`,
      // Node's default fetch UA gets flagged by Cloudflare's WAF (error
      // 1010 / challenge page returned as HTML, which then crashes the
      // JSON parser). Sending a real-looking UA bypasses the heuristic —
      // this is a legitimate S2S call, not a scraper.
      'User-Agent': 'gitdocai-render-cli/0.1 (publish runtime)',
    }
    if (source.auth_token) {
      this.headers.Authorization = `Bearer ${source.auth_token}`
    }
  }

  async getDocumentation(): Promise<DocumentationLike & { versions: VersionLike[] }> {
    return this.get('/content/docs')
  }

  async listVersions(): Promise<VersionLike[]> {
    return this.get('/content/docs/version')
  }

  async listSections(versionId: string): Promise<SectionLike[]> {
    return this.get(`/content/docs/version/${versionId}/section`)
  }

  async getEntryTree(
    versionId: string,
    sectionId: string,
  ): Promise<{ section_id: string; doc_entries: DocEntryLike[] }> {
    return this.get(
      `/content/docs/version/${versionId}/section/${sectionId}/entry/tree`,
    )
  }

  /** Full entry including `content`. Fetched once per page render. */
  async getEntry(
    versionId: string,
    sectionId: string,
    entryId: string,
  ): Promise<DocEntryLike> {
    return this.get(
      `/content/docs/version/${versionId}/section/${sectionId}/entry/${entryId}`,
    )
  }

  /**
   * Download a doc asset's bytes by its ID. content-runtime 302s to a
   * short-lived signed GCS URL; `fetch` follows redirects by default so
   * the caller only sees the final bytes + content-type.
   */
  async downloadAsset(
    assetId: string,
  ): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const res = await fetch(`${this.base}/content/docs/asset/${assetId}/file`, {
      headers: this.headers,
    })
    if (!res.ok) {
      throw new Error(`asset download ${res.status} ${res.statusText}`)
    }
    const bytes = await res.arrayBuffer()
    const contentType = res.headers.get('content-type') || 'application/octet-stream'
    return { bytes, contentType }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { headers: this.headers })
    if (!res.ok) {
      const body = await safeText(res)
      throw new Error(`content-runtime GET ${path} → ${res.status}: ${body}`)
    }
    return (await res.json()) as T
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return '<no body>'
  }
}
