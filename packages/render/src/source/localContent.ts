import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ContentSourceClient,
  DocEntryLike,
  DocumentationLike,
  SectionLike,
  VersionLike,
} from '../types'

/**
 * Reads a documentation from a local `content/` folder in the
 * backup-manifest format and exposes it through the same interface as
 * ContentRuntimeClient, so `runPublish` streams it to R2 + KV unchanged.
 *
 * Folder layout:
 *   content/gitdocai.json                  ← manifest (versions→sections→pages)
 *   content/<content_path>.mdx             ← per-page MDX (page.content_path)
 *   content/assets/manifest.json           ← [{ id, filename, mime_type }]
 *   content/assets/files/<filename>        ← asset bytes
 */

interface ManifestPage {
  id: string
  section_id?: string
  parent_id?: string
  type: 'page' | 'folder'
  order?: number
  content_path?: string
  children?: ManifestPage[]
  [key: string]: unknown
}
interface ManifestSection {
  id: string
  version_id?: string
  pages?: ManifestPage[]
  [key: string]: unknown
}
interface ManifestVersion {
  id: string
  sections?: ManifestSection[]
  [key: string]: unknown
}
interface Manifest {
  id: string
  organization_id: string
  versions?: ManifestVersion[]
  [key: string]: unknown
}

interface AssetManifestEntry {
  id: string
  filename: string
  mime_type?: string
}

export class LocalContentClient implements ContentSourceClient {
  private manifest: Manifest | null = null
  private assetMap: Map<string, AssetManifestEntry> | null = null

  constructor(private readonly contentDir: string) {}

  private async load(): Promise<Manifest> {
    if (!this.manifest) {
      const raw = await readFile(join(this.contentDir, 'gitdocai.json'), 'utf-8')
      this.manifest = JSON.parse(raw) as Manifest
    }
    return this.manifest
  }

  async getDocumentation(): Promise<DocumentationLike & { versions: VersionLike[] }> {
    const m = await this.load()
    // Strip the heavy nested sections/pages from versions — they're
    // served from their own keys (sections.json / tree.json), matching
    // how content-runtime returns a lean versions list.
    const versions = (m.versions ?? []).map(({ sections: _s, ...v }) => v) as VersionLike[]
    return { ...m, versions }
  }

  async listSections(versionId: string): Promise<SectionLike[]> {
    const version = await this.findVersion(versionId)
    return (version?.sections ?? []).map(({ pages: _p, ...s }) => ({
      version_id: versionId,
      ...s,
    })) as SectionLike[]
  }

  async getEntryTree(
    versionId: string,
    sectionId: string,
  ): Promise<{ section_id: string; doc_entries: DocEntryLike[] }> {
    const version = await this.findVersion(versionId)
    const section = version?.sections?.find((s) => s.id === sectionId)
    const doc_entries = buildTree(section?.pages ?? [], sectionId)
    return { section_id: sectionId, doc_entries }
  }

  async getEntry(
    versionId: string,
    sectionId: string,
    entryId: string,
  ): Promise<DocEntryLike> {
    const version = await this.findVersion(versionId)
    const section = version?.sections?.find((s) => s.id === sectionId)
    const page = section?.pages?.find((p) => p.id === entryId)
    if (!page) throw new Error(`entry ${entryId} not found in section ${sectionId}`)
    let content = ''
    if (page.content_path) {
      content = await readFile(join(this.contentDir, page.content_path), 'utf-8')
    }
    const { children: _c, ...rest } = page
    return { ...rest, section_id: sectionId, content } as DocEntryLike
  }

  async downloadAsset(
    assetId: string,
  ): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const map = await this.loadAssetMap()
    const entry = map.get(assetId)
    const filename = entry?.filename ?? assetId
    const buf = await readFile(join(this.contentDir, 'assets', 'files', filename))
    // node Buffer → standalone ArrayBuffer slice (avoids handing back a
    // view over a larger pooled buffer).
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return {
      bytes,
      contentType: entry?.mime_type || 'application/octet-stream',
    }
  }

  private async findVersion(versionId: string): Promise<ManifestVersion | undefined> {
    const m = await this.load()
    return m.versions?.find((v) => v.id === versionId)
  }

  private async loadAssetMap(): Promise<Map<string, AssetManifestEntry>> {
    if (!this.assetMap) {
      this.assetMap = new Map()
      try {
        const raw = await readFile(
          join(this.contentDir, 'assets', 'manifest.json'),
          'utf-8',
        )
        const entries = JSON.parse(raw) as AssetManifestEntry[]
        for (const e of entries) this.assetMap.set(e.id, e)
      } catch {
        /* no asset manifest — downloadAsset falls back to <id> as filename */
      }
    }
    return this.assetMap
  }
}

/**
 * Nest a flat page list (each carrying an optional parent_id) into the
 * tree shape the tree endpoint returns. Roots = pages with no parent_id
 * (or a parent that isn't in this section); children hang off their
 * parent. Each level is ordered by `order`.
 */
function buildTree(pages: ManifestPage[], sectionId: string): DocEntryLike[] {
  const byId = new Map<string, DocEntryLike>()
  for (const p of pages) {
    byId.set(p.id, { ...p, section_id: p.section_id ?? sectionId, children: [] } as DocEntryLike)
  }
  const roots: DocEntryLike[] = []
  for (const p of pages) {
    const node = byId.get(p.id)!
    const parent = p.parent_id ? byId.get(p.parent_id) : undefined
    if (parent) (parent.children ??= []).push(node)
    else roots.push(node)
  }
  const sortByOrder = (a: DocEntryLike, b: DocEntryLike) =>
    ((a.order as number) ?? 0) - ((b.order as number) ?? 0)
  const sortDeep = (nodes: DocEntryLike[]) => {
    nodes.sort(sortByOrder)
    for (const n of nodes) if (n.children?.length) sortDeep(n.children)
  }
  sortDeep(roots)
  return roots
}
