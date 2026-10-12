import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  ContentSourceClient,
  DocEntryLike,
  DocumentationLike,
  SectionLike,
  VersionLike,
} from '../types'

/**
 * Reader for the docs-as-code layout defined by packages/docstore:
 *
 *   gitdocai.json            manifest: versions → navigation (sections, groups, pages)
 *   <page path>.mdx | .md    one file per page, YAML front matter + body
 *   assets/…                 files the pages reference
 *
 * It exposes that layout through ContentSourceClient, so `runPublish`
 * streams it exactly like the other sources. The files carry no ids: they
 * are derived (UUIDv5) from the site key and the paths, byte-for-byte the
 * same way packages/docstore/ids.go does it.
 */

// --- ids (mirrors docstore/ids.go) --------------------------------------

const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'

function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const h = createHash('sha1').update(ns).update(Buffer.from(name, 'utf-8')).digest()
  const b = h.subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const x = b.toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

export class DocstoreIds {
  private readonly ns: string
  constructor(siteKey: string) {
    this.ns = uuidV5(NAMESPACE_URL, `gitdocai:${siteKey}`)
  }
  private derive(kind: string, key: string): string {
    return uuidV5(this.ns, `${kind}:${key}`)
  }
  version(slug: string) {
    return this.derive('version', slug)
  }
  section(version: string, section: string) {
    return this.derive('section', `${version}/${section}`)
  }
  group(version: string, section: string, ...groupSlugs: string[]) {
    return this.derive('group', [`${version}/${section}`, ...groupSlugs].join('/'))
  }
  page(path: string) {
    return this.derive('page', path)
  }
  asset(path: string) {
    return this.derive('asset', path)
  }
}

/** The ids of the documentation itself (the files don't have one). */
export function docstoreIdentity(siteKey: string): { orgId: string; docId: string } {
  return { orgId: 'self-hosted', docId: uuidV5(NAMESPACE_URL, `gitdocai:site:${siteKey}`) }
}

// --- slug (mirrors docstore/paths.go) -----------------------------------

export function slug(name: string): string {
  let out = ''
  let pending = false
  for (const ch of name.trim().toLowerCase()) {
    const keep = /\p{Nd}/u.test(ch) || (/\p{L}/u.test(ch) && ch === ch.toLowerCase() && ch !== ch.toUpperCase())
    if (keep) {
      if (pending && out) out += '-'
      pending = false
      out += ch
    } else {
      pending = true
    }
  }
  return out
}

// --- manifest -----------------------------------------------------------

type NavNode = string | { page?: string; group?: string; slug?: string; icon?: string; pages?: NavNode[] }

interface NavSection {
  section: string
  slug?: string
  type?: string
  icon?: string
  visible?: boolean
  pages?: NavNode[]
}

interface NavVersion {
  name: string
  slug?: string
  default?: boolean
  latest?: boolean
  deprecated?: boolean
  released_at?: string
  navigation?: NavSection[]
}

interface Manifest {
  format?: number
  name?: string
  description?: string
  audience?: string
  favicon?: string
  theme?: unknown
  assistant?: unknown
  seo?: unknown
  navbar?: unknown
  footer?: unknown
  kb?: unknown
  version_selector?: { enabled?: boolean; position?: string }
  versions?: NavVersion[]
  [key: string]: unknown
}

/** True for the docstore layout (as opposed to the id-based backup manifest). */
export function isDocstoreManifest(m: unknown): boolean {
  const mm = m as Manifest
  if (!mm || typeof mm !== 'object') return false
  if (mm['schema_version'] !== undefined) return false
  return (
    typeof mm.format === 'number' ||
    (Array.isArray(mm.versions) && mm.versions.some((v) => Array.isArray(v?.navigation)))
  )
}

interface PageFile {
  meta: Record<string, any>
  body: string
  file: string
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
}

interface BuiltEntry {
  entry: DocEntryLike
  /** Page path the content comes from (a group may have its own page). */
  contentPath?: string
}

export class DocstoreClient implements ContentSourceClient {
  readonly siteKey: string
  readonly identity: { orgId: string; docId: string }
  private readonly ids: DocstoreIds
  /** asset path (relative to the site root) → derived id */
  private assetIds = new Map<string, string>()
  private assetPaths = new Map<string, string>()
  /** `${versionId}/${sectionId}` → flat entries */
  private entries = new Map<string, BuiltEntry[]>()
  private versionList: VersionLike[] = []
  private sectionList = new Map<string, SectionLike[]>()
  private problems: string[] = []

  private constructor(
    private readonly dir: string,
    private readonly manifest: Manifest,
    private readonly mtime: string,
  ) {
    const key = manifest['x-site-key']
    this.siteKey = typeof key === 'string' && key ? key : slug(manifest.name ?? '') || 'site'
    this.ids = new DocstoreIds(this.siteKey)
    this.identity = docstoreIdentity(this.siteKey)
  }

  static async open(dir: string): Promise<DocstoreClient> {
    const raw = await readFile(join(dir, 'gitdocai.json'), 'utf-8')
    const manifest = JSON.parse(raw.replace(/^﻿/, '')) as Manifest
    const st = await stat(join(dir, 'gitdocai.json'))
    const c = new DocstoreClient(dir, manifest, st.mtime.toISOString())
    await c.scanAssets()
    await c.build()
    return c
  }

  /** Things the navigation points to that don't exist, etc. Surfaced by publish. */
  getProblems(): string[] {
    return this.problems
  }

  // -- assets ------------------------------------------------------------

  private async scanAssets(): Promise<void> {
    const root = join(this.dir, 'assets')
    if (!existsSync(root)) return
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.isFile()) {
          const rel = relative(this.dir, p).split(sep).join('/')
          const id = this.ids.asset(rel)
          this.assetIds.set(rel, id)
          this.assetPaths.set(id, p)
        }
      }
    }
    await walk(root)
  }

  /** Rewrite `assets/x.png`, `/assets/x.png`, `../assets/x.png` to `/assets/{id}`. */
  private rewriteAssets(text: string): string {
    if (this.assetIds.size === 0) return text
    return text.replace(/(?:\.{1,2}\/)*\/?(assets\/[^\s"'()<>\\]+)/g, (full, rel: string) => {
      const id = this.assetIds.get(decodeURI(rel))
      return id ? `/assets/${id}` : full
    })
  }

  async downloadAsset(assetId: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const p = this.assetPaths.get(assetId)
    if (!p) throw new Error(`asset ${assetId} not found in assets/`)
    const buf = await readFile(p)
    return {
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      contentType: MIME[extname(p).toLowerCase()] ?? 'application/octet-stream',
    }
  }

  // -- pages -------------------------------------------------------------

  private async readPage(path: string): Promise<PageFile | null> {
    if (path.includes('..') || path.startsWith('/')) return null
    for (const ext of ['.mdx', '.md']) {
      const file = join(this.dir, path + ext)
      if (!existsSync(file)) continue
      const src = (await readFile(file, 'utf-8')).replace(/^﻿/, '')
      const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
      if (!m) return { meta: {}, body: src, file }
      let meta: Record<string, any> = {}
      try {
        const parsed = parseYaml(m[1])
        if (parsed && typeof parsed === 'object') meta = parsed as Record<string, any>
      } catch (e) {
        this.problems.push(`${path}: invalid front matter (${(e as Error).message.split('\n')[0]})`)
      }
      return { meta, body: src.slice(m[0].length), file }
    }
    return null
  }

  private titleFor(path: string): string {
    const base = basename(path).replace(/[-_]+/g, ' ').trim()
    return base ? base[0].toUpperCase() + base.slice(1) : path
  }

  private async pageEntry(
    path: string,
    sectionId: string,
    parentId: string | undefined,
    nodeSlug: string | undefined,
    order: number,
  ): Promise<DocEntryLike> {
    const page = await this.readPage(path)
    if (!page) {
      this.problems.push(`navigation points to "${path}" but ${path}.mdx / ${path}.md does not exist`)
    }
    const m = page?.meta ?? {}
    const show = (m.show ?? {}) as Record<string, unknown>
    const type = m.type === 'api_endpoint' ? 'api_endpoint' : 'page'
    return {
      id: this.ids.page(path),
      section_id: sectionId,
      ...(parentId ? { parent_id: parentId } : {}),
      title: (m.title as string) || this.titleFor(path),
      slug: nodeSlug || slug(basename(path)),
      type: type as 'page',
      order,
      ...(m.icon ? { icon: m.icon as string } : {}),
      ...(type === 'api_endpoint' ? { method: m.method, endpoint: m.endpoint } : {}),
      metadata: {
        ...(m.author ? { author: m.author } : {}),
        ...(m.author_avatar ? { author_avatar: m.author_avatar } : {}),
        ...(m.reading_time ? { reading_time: m.reading_time } : {}),
        ...(m.description ? { description: m.description } : {}),
        ...(Array.isArray(m.tags) ? { tags: m.tags } : {}),
        ...(m.published_at ? { published_at: String(m.published_at) } : {}),
        ...(m.last_edited_by ? { last_edited_by: m.last_edited_by } : {}),
      },
      metadata_visibility: {
        show_author: show.author ?? true,
        show_reading_time: show.reading_time ?? true,
        show_publish_date: show.publish_date ?? true,
        show_update_date: show.update_date ?? true,
        show_tags: show.tags ?? true,
      },
      created_at: this.mtime,
      updated_at: this.mtime,
    } as DocEntryLike
  }

  // -- model -------------------------------------------------------------

  private async build(): Promise<void> {
    const versions = this.manifest.versions ?? []
    const hasDefault = versions.some((v) => v.default)

    for (let vi = 0; vi < versions.length; vi++) {
      const v = versions[vi]
      const vSlug = v.slug || slug(v.name)
      const versionId = this.ids.version(vSlug)
      this.versionList.push({
        id: versionId,
        documentation_id: this.identity.docId,
        name: v.name,
        slug: vSlug,
        is_latest: !!v.latest,
        is_default: hasDefault ? !!v.default : vi === 0,
        is_deprecated: !!v.deprecated,
        ...(v.released_at ? { released_at: v.released_at } : {}),
        created_at: this.mtime,
        updated_at: this.mtime,
      } as VersionLike)

      const sections: SectionLike[] = []
      const navigation = v.navigation ?? []
      for (let si = 0; si < navigation.length; si++) {
        const s = navigation[si]
        const sSlug = s.slug || slug(s.section)
        const sectionId = this.ids.section(vSlug, sSlug)
        sections.push({
          id: sectionId,
          version_id: versionId,
          name: s.section,
          slug: sSlug,
          type: s.type || 'product_documentation',
          ...(s.icon ? { icon: s.icon } : {}),
          order: si,
          visible: s.visible !== false,
          created_at: this.mtime,
          updated_at: this.mtime,
        } as SectionLike)

        const built: BuiltEntry[] = []
        const walk = async (nodes: NavNode[], parentId: string | undefined, trail: string[], offset = 0) => {
          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i]
            if (typeof n === 'string' || (n.page && !n.group)) {
              const path = typeof n === 'string' ? n : (n.page as string)
              const nodeSlug = typeof n === 'object' ? n.slug : undefined
              built.push({ entry: await this.pageEntry(path, sectionId, parentId, nodeSlug, i + offset), contentPath: path })
            } else if (n.group) {
              const gSlug = n.slug || slug(n.group)
              const id = this.ids.group(vSlug, sSlug, ...trail, gSlug)
              const entry = {
                id,
                section_id: sectionId,
                ...(parentId ? { parent_id: parentId } : {}),
                title: n.group,
                slug: gSlug,
                type: 'folder',
                order: i + offset,
                ...(n.icon ? { icon: n.icon } : {}),
                metadata: {},
                created_at: this.mtime,
                updated_at: this.mtime,
              } as unknown as DocEntryLike
              built.push({ entry })
              // Folders are navigation containers (publish and the Worker never
              // render them), so a group's own page becomes its first child.
              if (n.page) {
                built.push({ entry: await this.pageEntry(n.page, sectionId, id, undefined, 0), contentPath: n.page })
              }
              await walk(n.pages ?? [], id, [...trail, gSlug], n.page ? 1 : 0)
            }
          }
        }
        await walk(s.pages ?? [], undefined, [])
        this.entries.set(`${versionId}/${sectionId}`, built)
      }
      this.sectionList.set(versionId, sections)
    }
  }

  // -- ContentSourceClient -----------------------------------------------

  async getDocumentation(): Promise<DocumentationLike & { versions: VersionLike[] }> {
    const m = this.manifest
    const strip = (v: unknown) => (v === undefined ? undefined : JSON.parse(this.rewriteAssets(JSON.stringify(v))))
    const config: Record<string, unknown> = {}
    for (const [k, v] of Object.entries({
      theme: m.theme, assistant: m.assistant, seo: m.seo, navbar: m.navbar, footer: m.footer, kb: m.kb,
      favicon_url: m.favicon,
    })) {
      if (v !== undefined) config[k] = strip(v)
    }
    return {
      id: this.identity.docId,
      organization_id: this.identity.orgId,
      name: m.name ?? '',
      description: m.description ?? '',
      audience: m.audience ?? 'public',
      status: 'published',
      version_selector_enabled: m.version_selector?.enabled ?? false,
      version_selector_position: m.version_selector?.position ?? 'navbar_right',
      config,
      versions: this.versionList,
      created_at: this.mtime,
      updated_at: this.mtime,
    } as DocumentationLike & { versions: VersionLike[] }
  }

  async listSections(versionId: string): Promise<SectionLike[]> {
    return this.sectionList.get(versionId) ?? []
  }

  async getEntryTree(
    versionId: string,
    sectionId: string,
  ): Promise<{ section_id: string; doc_entries: DocEntryLike[] }> {
    const flat = this.entries.get(`${versionId}/${sectionId}`) ?? []
    const byId = new Map<string, DocEntryLike>()
    for (const b of flat) byId.set(b.entry.id, { ...b.entry, children: [] })
    const roots: DocEntryLike[] = []
    for (const b of flat) {
      const node = byId.get(b.entry.id) as DocEntryLike
      const parent = b.entry.parent_id ? byId.get(b.entry.parent_id as string) : undefined
      if (parent) (parent.children ??= []).push(node)
      else roots.push(node)
    }
    return { section_id: sectionId, doc_entries: roots }
  }

  async getEntry(versionId: string, sectionId: string, entryId: string): Promise<DocEntryLike> {
    const b = (this.entries.get(`${versionId}/${sectionId}`) ?? []).find((x) => x.entry.id === entryId)
    if (!b) throw new Error(`entry ${entryId} not found in section ${sectionId}`)
    let content = ''
    if (b.contentPath) {
      const page = await this.readPage(b.contentPath)
      if (page) content = this.rewriteAssets(page.body)
    }
    const { children: _c, ...rest } = b.entry
    return { ...rest, content } as DocEntryLike
  }
}

/**
 * Open a local docs folder with whichever reader matches its manifest:
 * the docstore layout (`format` + navigation) or the id-based backup.
 */
export async function openLocalSource(
  dir: string,
  makeBackup: (dir: string) => ContentSourceClient,
): Promise<{ client: ContentSourceClient; identity?: { orgId: string; docId: string }; problems: () => string[] }> {
  let manifest: unknown
  try {
    manifest = JSON.parse((await readFile(join(dir, 'gitdocai.json'), 'utf-8')).replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new Error(`cannot read gitdocai.json in ${dir}: ${(e as Error).message}`)
  }
  if (isDocstoreManifest(manifest)) {
    const client = await DocstoreClient.open(dir)
    return { client, identity: client.identity, problems: () => client.getProblems() }
  }
  return { client: makeBackup(dir), problems: () => [] }
}
