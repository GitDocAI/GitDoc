import type {
  ContentSourceClient,
  ControlPlaneSource,
  DocEntryLike,
  DocumentationLike,
  SectionLike,
  VersionLike,
} from '../types'

/**
 * Streams documentation data from the control-plane's internal (s2s)
 * read API, addressing everything by organization + documentation id
 * (the control-plane spawns this CLI on publish and already knows them,
 * so there's no hostname → doc resolution step). Nothing is cached —
 * `runPublish` fetches once per run and streams pages one at a time.
 *
 * Expected control-plane endpoints (all under the s2s group, Bearer auth):
 *   GET /s2s/documentation/{org}/{doc}
 *   GET /s2s/documentation/{org}/{doc}/version
 *   GET /s2s/documentation/{org}/{doc}/version/{v}/section
 *   GET /s2s/documentation/{org}/{doc}/version/{v}/section/{s}/entry/tree
 *   GET /s2s/documentation/{org}/{doc}/version/{v}/section/{s}/entry/{e}
 *   GET /s2s/documentation/{org}/{doc}/asset/{a}/file
 */
export class ControlPlaneClient implements ContentSourceClient {
  private readonly base: string
  private readonly docBase: string
  private readonly headers: Record<string, string>

  constructor(source: ControlPlaneSource) {
    this.base = source.base_url.replace(/\/$/, '')
    this.docBase = `/s2s/documentation/${source.organization_id}/${source.documentation_id}`
    this.headers = { Accept: 'application/json' }
    if (source.auth_token) {
      this.headers.Authorization = `Bearer ${source.auth_token}`
    }
  }

  async getDocumentation(): Promise<DocumentationLike & { versions: VersionLike[] }> {
    // control-plane returns the doc (with config) and versions separately;
    // merge them into the shape the renderer + R2 layout expect.
    const [doc, versions] = await Promise.all([
      this.get<DocumentationLike>(this.docBase),
      this.get<VersionLike[]>(`${this.docBase}/version`),
    ])
    return { ...doc, versions: versions ?? [] }
  }

  async listSections(versionId: string): Promise<SectionLike[]> {
    return this.get(`${this.docBase}/version/${versionId}/section`)
  }

  async getEntryTree(
    versionId: string,
    sectionId: string,
  ): Promise<{ section_id: string; doc_entries: DocEntryLike[] }> {
    return this.get(
      `${this.docBase}/version/${versionId}/section/${sectionId}/entry/tree`,
    )
  }

  async getEntry(
    versionId: string,
    sectionId: string,
    entryId: string,
  ): Promise<DocEntryLike> {
    return this.get(
      `${this.docBase}/version/${versionId}/section/${sectionId}/entry/${entryId}`,
    )
  }

  async downloadAsset(
    assetId: string,
  ): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const res = await fetch(`${this.base}${this.docBase}/asset/${assetId}/file`, {
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
      throw new Error(`control-plane GET ${path} → ${res.status}: ${body}`)
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
