import { ContentSource } from './contentSource'
import { errorPage } from './errorPage'
import type { DomainMapping } from './types'
import type {
  Documentation,
  Version,
  Section,
  DocEntry,
} from '@/types/documentation.types'

/**
 * Everything the Astro page needs to render ONE documentation page
 * statically. Scoped to the requested URL:
 *   - documentation / versions: for header + theme config
 *   - activeSection: currently open section (sidebar highlight)
 *   - activeSectionTree: nav tree for the sidebar (metadata only,
 *     no page content — each page is its own request)
 *   - currentEntry + currentHtml: pre-rendered content of the
 *     requested entry
 *   - sections: all sections (for the top nav)
 *
 * Per-request cost: 4-6 R2 reads (doc, versions, sections, 1 tree,
 * 1 entry json, 1 entry html). Previous "load everything" design
 * pulled 60+ R2 reads on every page hit — wasted effort since we no
 * longer ship the full tree to the client.
 */
export interface SsrBundle {
  mapping: DomainMapping
  documentation: Documentation
  versions: Version[]
  activeVersion: Version | null
  sections: Section[]
  activeSection: Section | null
  /** Nav tree for the active section only. Metadata, no `content`. */
  activeSectionTree: DocEntry[]
  currentEntry: DocEntry | null
  /** Full entry JSON including raw MDX `content`, used by the React island. */
  currentEntryFull: DocEntry | null
  currentHtml: string | null
}

export async function loadSsrBundle(
  request: Request,
  source: ContentSource,
  env: Record<string, unknown>,
  pathname: string,
): Promise<SsrBundle | Response> {
  // -------------------------------------------------------------------
  // 1. Hostname → mapping
  // -------------------------------------------------------------------
  const devDomain = request.headers.get('x-dev-domain')?.trim()
  const rawDevEnv = env['DEV_HOSTNAME']
  const devEnv = typeof rawDevEnv === 'string' ? rawDevEnv.trim() : undefined
  const requestHost = request.headers.get('host') || new URL(request.url).hostname
  const isLocalHost =
    /^localhost(:|$)/.test(requestHost) || /^127\.0\.0\.1/.test(requestHost)
  const effectiveHost = devDomain || (isLocalHost ? devEnv : '') || requestHost

  let mapping = await source.resolveDomain(
    effectiveHost.split(':')[0] ?? effectiveHost,
  )
  // Self-hosted single-site mode: one doc published → it answers on any host.
  if (!mapping && env['SINGLE_SITE'] === 'true') mapping = await source.soleDomain()
  if (!mapping) {
    // Self-hosted installs with several docs: say which hostnames exist.
    // Never on the multi-tenant SaaS (that would list other customers).
    let hint = ''
    if (env['LIST_SITES'] === 'true') {
      const port = requestHost.includes(':') ? ':' + requestHost.split(':')[1] : ''
      const names = await source.hostnames()
      if (names.length) hint = ' Sites on this server: ' + names.map((h) => `http://${h}${port}/`).join(', ')
    }
    return errorPage({
      status: 404,
      title: 'No documentation here',
      message:
        'There’s no documentation published at this address yet. If you just set up a custom domain, give it a few minutes — or double-check the DNS record.' +
        hint,
    })
  }

  // -------------------------------------------------------------------
  // 2. Doc header + versions (parallel)
  // -------------------------------------------------------------------
  const [documentation, versionsRaw] = await Promise.all([
    source.readJson<Documentation>(source.documentationKey(mapping)),
    source.readJson<Version[]>(source.versionsKey(mapping)),
  ])
  if (!documentation) {
    return errorPage({
      status: 500,
      title: 'Couldn’t load this documentation',
      message:
        'This site is configured but its content isn’t available right now. Please try again in a moment.',
    })
  }
  const versions = versionsRaw ?? []

  // The URL may carry a version slug as its first segment
  // (`/{version}/{section}/...`). When it does, that version wins over
  // the `is_default`/`is_latest` fallback so readers can navigate into
  // non-default versions. The default version is reachable both with
  // and without its slug — links generated server-side omit it (see
  // `[...all].astro`'s `versionPrefix`) to keep canonical URLs clean.
  const allSegments = pathname.split('/').filter(Boolean)
  const urlVersion = allSegments[0]
    ? versions.find((v) => v.slug === allSegments[0]) ?? null
    : null
  const segments = urlVersion ? allSegments.slice(1) : allSegments

  const activeVersion =
    urlVersion ??
    versions.find((v) => v.is_default) ??
    versions.find((v) => v.is_latest) ??
    versions[0] ??
    null

  if (!activeVersion) {
    // No versions published — return the shell with no sidebar content.
    return {
      mapping,
      documentation,
      versions,
      activeVersion: null,
      sections: [],
      activeSection: null,
      activeSectionTree: [],
      currentEntry: null,
      currentEntryFull: null,
      currentHtml: null,
    }
  }

  // -------------------------------------------------------------------
  // 3. Sections for the active version (1 R2 read)
  // -------------------------------------------------------------------
  const sections =
    (await source.readJson<Section[]>(source.sectionsKey(mapping, activeVersion.id))) ??
    []

  // -------------------------------------------------------------------
  // 4. Parse URL → determine active section
  //    `segments` is the path with any version prefix already stripped
  //    in step 2, so segments[0] is the section slug.
  // -------------------------------------------------------------------
  const activeSection =
    (segments[0] ? sections.find((s) => s.slug === segments[0]) : null) ??
    sections[0] ??
    null

  if (!activeSection) {
    return {
      mapping,
      documentation,
      versions,
      activeVersion,
      sections,
      activeSection: null,
      activeSectionTree: [],
      currentEntry: null,
      currentEntryFull: null,
      currentHtml: null,
    }
  }

  // -------------------------------------------------------------------
  // 5. Tree for the active section (for sidebar render)
  // -------------------------------------------------------------------
  const treePayload = await source.readJson<{
    section_id: string
    doc_entries: DocEntry[]
  }>(source.entryTreeKey(mapping, activeVersion.id, activeSection.id))
  const activeSectionTree = treePayload?.doc_entries ?? []

  // -------------------------------------------------------------------
  // 6. Resolve which entry in the tree matches the URL
  // -------------------------------------------------------------------
  const entryPathSegments = segments.slice(1)
  let matchedEntry: DocEntry | null = null
  if (entryPathSegments.length > 0) {
    matchedEntry = findEntryBySlugPath(activeSectionTree, entryPathSegments)
  }
  if (!matchedEntry) {
    matchedEntry = firstPage(activeSectionTree)
  }

  // -------------------------------------------------------------------
  // 7. Pre-rendered HTML of the current entry (1 R2 read).
  //    The page injects it via `set:html`. We intentionally DON'T read
  //    the entry `.json` (raw MDX) anymore — the SSR page renders from
  //    the pre-rendered HTML, so that read was pure waste per request.
  //    `currentEntryFull` stays in the bundle (null) for API back-compat.
  // -------------------------------------------------------------------
  let currentHtml: string | null = null
  const currentEntryFull: DocEntry | null = null
  if (matchedEntry) {
    const basePath =
      `docs/${mapping.docId}/versions/${activeVersion.id}` +
      `/sections/${activeSection.id}/entries/${matchedEntry.id}`
    currentHtml = await source.readText(`${basePath}.html`).catch(() => null)
  }

  return {
    mapping,
    documentation,
    versions,
    activeVersion,
    sections,
    activeSection,
    activeSectionTree,
    currentEntry: matchedEntry,
    currentEntryFull,
    currentHtml,
  }
}

function findEntryBySlugPath(
  tree: DocEntry[],
  slugPath: string[],
): DocEntry | null {
  if (slugPath.length === 0) return null
  const [head, ...rest] = slugPath
  for (const node of tree) {
    if (node.slug !== head) continue
    if (rest.length === 0) {
      // A leaf is anything that isn't a folder — `page` AND `api_endpoint`
      // (OpenAPI reference entries) are both renderable pages. Matching only
      // `page` left api_endpoint URLs falling back to the group's first page.
      return node.type !== 'folder' ? node : firstPage(node.children ?? [])
    }
    if (node.children) {
      const found = findEntryBySlugPath(node.children, rest)
      if (found) return found
    }
  }
  return null
}

function firstPage(tree: DocEntry[]): DocEntry | null {
  for (const node of tree) {
    // Any non-folder leaf counts (page, api_endpoint, …); only folders recurse.
    if (node.type !== 'folder') return node
    if (node.children) {
      const found = firstPage(node.children)
      if (found) return found
    }
  }
  return null
}
