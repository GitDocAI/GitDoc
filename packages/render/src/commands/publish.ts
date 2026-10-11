import { renderEntry } from '../render/renderEntry'
import { mdxSerializer } from '../../../ui/src/services/mdxSerializer'
import { R2Uploader } from '../upload/r2'
import { KVWriter } from '../upload/kv'
import { FsUploader, FsKvWriter } from '../upload/fs'
import type { ObjectSink, MappingSink } from '../upload/sink'
import { ContentRuntimeClient } from '../source/contentRuntime'
import { LocalContentClient } from '../source/localContent'
import { openLocalSource } from '../source/docstore'
import { ControlPlaneClient } from '../source/controlPlane'
import { AssetMigrator } from '../assets/migrator'
import type {
  ContentSourceClient,
  DocEntryLike,
  PublishError,
  PublishInput,
  PublishResult,
  SectionLike,
  VersionLike,
} from '../types'

interface PageIndexEntry {
  path: string
  title: string
  description?: string
  lastmod?: string
}

const RENDERER_VERSION = '0.1.0'

/**
 * Streams documentation content from a content-runtime instance,
 * rendering + uploading one page at a time. Memory footprint is O(1
 * page) instead of O(whole doc) — critical for docs with thousands of
 * pages.
 *
 * Ordering:
 *   1. Fetch doc header + versions, upload both
 *   2. For each version: fetch sections, upload sections.json
 *   3. For each section: fetch tree, upload tree.json
 *   4. For each entry in tree: fetch entry content, render, upload
 *   5. Write KV mappings at the end (so readers never see a hostname
 *      mapped to a doc whose R2 objects haven't landed yet)
 */
export async function runPublish(input: PublishInput): Promise<PublishResult> {
  const started = Date.now()
  const errors: PublishError[] = []
  let r2: ObjectSink
  let kv: MappingSink
  if (input.output?.kind === 'fs') {
    r2 = new FsUploader(input.output.dir)
    kv = new FsKvWriter()
  } else if (input.cloudflare) {
    r2 = new R2Uploader(input.cloudflare)
    kv = new KVWriter(input.cloudflare)
  } else {
    return fail(started, [{ where: 'input', message: 'need either `output` (fs) or `cloudflare`' }])
  }
  let runtime: ContentSourceClient
  let identity: { orgId: string; docId: string } | undefined
  let sourceProblems: () => string[] = () => []
  try {
    if (input.source.kind === 'local') {
      const opened = await openLocalSource(
        input.source.content_dir,
        (d) => new LocalContentClient(d),
      )
      runtime = opened.client
      identity = opened.identity
      sourceProblems = opened.problems
    } else if (input.source.kind === 'control-plane') {
      runtime = new ControlPlaneClient(input.source)
    } else {
      runtime = new ContentRuntimeClient(input.source)
    }
  } catch (err) {
    return fail(started, [{ where: 'input', message: describe(err) }])
  }

  // Docstore sites carry no ids in their files: when the caller left them
  // blank, they come from the site itself (same derivation as docstore/ids.go).
  const mappings = input.mappings.map((m) => ({
    ...m,
    org_id: m.org_id || identity?.orgId || '',
    doc_id: m.doc_id || identity?.docId || '',
  }))
  const { org_id: orgId, doc_id: docId } = mappings[0] ?? {}
  if (!orgId || !docId) {
    return fail(started, [{ where: 'input', message: 'mappings[0] missing org_id/doc_id' }])
  }

  const assets = new AssetMigrator(r2, runtime, docId)
  let uploaded = 0
  let rendered = 0
  // Flat list of the default version's public pages — drives the
  // sitemap.xml + llms.txt the Worker serves. Accumulated in document
  // order across sections.
  const pagesIndex: PageIndexEntry[] = []

  // -------------------------------------------------------------------
  // 1. Documentation header + versions
  // -------------------------------------------------------------------
  let versions: VersionLike[]
  // Which version the Worker serves at clean (un-prefixed) URLs. Only
  // this version's pages go into the index — others aren't routed yet.
  let defaultVersionId: string | undefined
  try {
    const doc = await runtime.getDocumentation()
    versions = (doc.versions || []) as VersionLike[]
    defaultVersionId =
      versions.find((v) => v.is_default)?.id ??
      versions.find((v) => v.is_latest)?.id ??
      versions[0]?.id
    // Strip `versions` from the object we store — it lives in its own
    // key. Keeps the documentation.json lightweight and matches how the
    // Worker reads them separately.
    const { versions: _versions, ...docOnly } = doc
    // Migrate asset URLs in the config (logo/favicon/og_image) the same
    // way page bodies are migrated: download to R2 + rewrite to
    // /assets/{id}. Without this the doc config keeps dashboard asset
    // URLs (/documentation/.../asset/.../file) that the Worker can't
    // serve. Round-trip through JSON so every string field is covered.
    const docMigrated = JSON.parse(await assets.processBody(JSON.stringify(docOnly)))
    // Stamp the logo's intrinsic pixel size into the config so the Worker
    // can emit <img width height> on the header logo and avoid the CLS of
    // it expanding from 0 once loaded. image-size already probed it when
    // processBody downloaded the logo asset above.
    stampLogoDimensions(docMigrated, assets.getDimensions())
    await r2.putJson(`docs/${docId}/documentation.json`, docMigrated)
    await r2.putJson(`docs/${docId}/versions.json`, versions)
    uploaded += 2
  } catch (err) {
    errors.push({ where: 'render', message: `doc header fetch/upload: ${describe(err)}` })
    return fail(started, errors)
  }

  // -------------------------------------------------------------------
  // 2. Per-version + per-section streaming
  // -------------------------------------------------------------------
  for (const version of versions) {
    let sections: SectionLike[]
    try {
      sections = await runtime.listSections(version.id)
      await r2.putJson(
        `docs/${docId}/versions/${version.id}/sections.json`,
        sections,
      )
      uploaded++
    } catch (err) {
      errors.push({
        where: 'render',
        message: `sections fetch/upload for version ${version.id}: ${describe(err)}`,
      })
      continue
    }

    for (const section of sections) {
      let tree: { section_id: string; doc_entries: DocEntryLike[] }
      try {
        tree = await runtime.getEntryTree(version.id, section.id)
        await r2.putJson(
          `docs/${docId}/versions/${version.id}/sections/${section.id}/tree.json`,
          tree,
        )
        uploaded++
      } catch (err) {
        errors.push({
          where: 'render',
          message: `tree fetch for section ${section.id}: ${describe(err)}`,
        })
        continue
      }

      // Walk the tree, fetch each page one at a time, render, upload,
      // then let it go out of scope. `forEachWithConcurrency` pipelines
      // up to N fetches+renders so we overlap network I/O and CPU.
      const pageEntries = flattenPagesWithPath(tree.doc_entries)
      const isDefaultVersion = version.id === defaultVersionId
      const sectionSlug = section.slug ?? ''
      // Per-entry index data, keyed by id so we can re-emit in document
      // order after the (out-of-order) concurrent batch finishes.
      const indexResults = new Map<
        string,
        { title: string; description?: string; lastmod?: string }
      >()

      await forEachWithConcurrency(pageEntries, 8, async ({ entry: entryStub }) => {
        try {
          const full = await runtime.getEntry(version.id, section.id, entryStub.id)
          if (!full.content) return

          // Migrate any GCS signed URLs in this page's content to R2
          // BEFORE render. The rewritten MDX is what we store + render,
          // so assets.json AND html both point at stable /assets/...
          // URLs served by the Worker.
          const rewritten = await assets.processBody(String(full.content))
          const entryForStorage = { ...full, content: rewritten }

          // Pass the dimension map so the HTML renderer can stamp
          // width/height on every migrated image <img>.
          const page = await renderEntry(entryForStorage, {
            assetDimensions: assets.getDimensions(),
          })
          rendered++

          const base =
            `docs/${docId}/versions/${version.id}` +
            `/sections/${section.id}/entries/${full.id}`

          await Promise.all([
            r2.putJson(base + '.json', entryForStorage),
            r2.putHtml(base + '.html', page.html),
            r2.putJson(base + '.meta.json', page.meta),
            // Clean markdown for LLM ingestion + the `…​.md` page routes.
            // MDX passes through as-is; Tiptap JSON is serialized to MDX.
            r2.putText(base + '.md', contentToMarkdown(rewritten), 'text/markdown; charset=utf-8'),
          ])
          uploaded += 4

          if (isDefaultVersion) {
            indexResults.set(entryStub.id, {
              title: page.meta.title,
              description: page.meta.description,
              lastmod: page.meta.updated_at,
            })
          }
        } catch (err) {
          errors.push({
            where: 'render',
            entry_id: entryStub.id,
            message: describe(err),
          })
        }
      })

      // Append this section's pages to the index in document order. URL
      // path mirrors the Worker's resolver: /{section.slug}/{cumulative
      // entry slugs}.
      if (isDefaultVersion) {
        for (const { entry, slugPath } of pageEntries) {
          const data = indexResults.get(entry.id)
          if (!data) continue
          pagesIndex.push({
            path: `/${[sectionSlug, ...slugPath].filter(Boolean).join('/')}`,
            title: data.title,
            description: data.description,
            lastmod: data.lastmod,
          })
        }
      }
    }
  }

  // Page index for sitemap.xml + llms.txt (default version, public pages).
  try {
    await r2.putJson(`docs/${docId}/pages-index.json`, pagesIndex)
    uploaded++
  } catch (err) {
    errors.push({ where: 'r2', message: `pages-index upload: ${describe(err)}` })
  }

  // -------------------------------------------------------------------
  // 3. KV mappings LAST so readers never hit a half-published doc.
  //    Also patch the R2 domain index so publish-web reads from R2 on
  //    the next isolate cache miss (≤60s TTL), eliminating the per-request
  //    KV read that exhausts the free-plan daily quota.
  // -------------------------------------------------------------------
  let kvWrites = 0
  for (const mapping of mappings) {
    try {
      await kv.putMapping(mapping)
      kvWrites++
    } catch (err) {
      errors.push({ where: 'kv', message: `${mapping.hostname}: ${describe(err)}` })
    }
  }

  try {
    await r2.patchDomainIndex(
      mappings.map((m) => ({
        hostname: m.hostname,
        orgId: m.org_id,
        docId: m.doc_id,
        isPrivate: m.is_private,
      })),
      [],
    )
  } catch (err) {
    errors.push({ where: 'kv', message: `R2 domain index patch: ${describe(err)}` })
  }

  // -------------------------------------------------------------------
  // 4. Orphan cleanup. Every prior publish was PUT-only, so deleting an
  //    entry / section / version / asset in the editor left its R2 files
  //    behind forever (sitemap was fine — pages-index is rewritten — but
  //    a snooping reader who knew an old key could still fetch it, and
  //    storage cost grew). Diff the live listing against everything we
  //    wrote this run and delete the leftover keys.
  //
  //    Runs AFTER the KV flip on purpose: if the listing+delete fails
  //    halfway through (network hiccup, R2 throttle), the published doc
  //    is already correct and the orphans just stick around until the
  //    next publish, instead of leaving a partially-deleted state.
  //
  //    Failures here are logged, not propagated — a cleanup miss never
  //    fails an otherwise-successful publish. `errors[].where='r2-cleanup'`
  //    keeps them visible in the result so operators see drift over time.
  //
  //    Kill switch: set RENDER_CLI_SKIP_CLEANUP=1 to skip entirely. Useful
  //    while debugging whether a slow publish is the cleanup or something
  //    earlier in the pipeline.
  // -------------------------------------------------------------------
  let cleanupDeleted = 0
  if (process.env.RENDER_CLI_SKIP_CLEANUP === '1') {
    errors.push({ where: 'r2-cleanup', message: 'skipped via RENDER_CLI_SKIP_CLEANUP=1' })
  } else {
    const cleanupStarted = Date.now()
    try {
      const written = r2.getWrittenKeys()
      // 30s hard timeout — listObjects pagination + deleteObjects shouldn't
      // exceed this in practice; if it does the publish is already done
      // (KV flip happened) and we'd rather log + bail than block the
      // subprocess from exiting.
      const live = await withTimeout(
        r2.listObjects(`docs/${docId}/`),
        30_000,
        'r2 listObjects',
      )
      const orphans = live.filter((k) => !written.has(k))
      if (orphans.length > 0) {
        await withTimeout(
          r2.deleteObjects(orphans),
          30_000,
          'r2 deleteObjects',
        )
        cleanupDeleted = orphans.length
      }
      // Surface duration so an operator watching logs can spot a slow
      // cleanup vs a slow earlier phase.
      if (Date.now() - cleanupStarted > 5_000) {
        errors.push({
          where: 'r2-cleanup',
          message: `cleanup took ${Date.now() - cleanupStarted}ms (deleted=${cleanupDeleted})`,
        })
      }
    } catch (err) {
      errors.push({ where: 'r2-cleanup', message: describe(err) })
    }
  }

  const assetStats = assets.getStats()
  // Surface any asset failures in the top-level errors list so callers
  // can fail a publish over missing images the same way they'd fail on
  // render errors.
  for (const e of assetStats.errors) {
    errors.push({ where: 'render', message: `asset ${e.asset_id}: ${e.message}` })
  }

  // Problems found while reading the source (broken navigation, bad front matter).
  for (const message of sourceProblems()) errors.push({ where: 'input', message })

  return {
    status: errors.length === 0 ? 'ok' : 'partial',
    rendered_pages: rendered,
    uploaded_objects: uploaded + assetStats.uploaded,
    kv_writes: kvWrites,
    cleanup_deleted: cleanupDeleted,
    assets: {
      unique: assetStats.unique_assets,
      uploaded: assetStats.uploaded,
      failed: assetStats.errors.length,
    },
    renderer_version: RENDERER_VERSION,
    duration_ms: Date.now() - started,
    errors,
  }
}

function fail(started: number, errors: PublishError[]): PublishResult {
  return {
    status: 'failed',
    rendered_pages: 0,
    uploaded_objects: 0,
    kv_writes: 0,
    cleanup_deleted: 0,
    assets: { unique: 0, uploaded: 0, failed: 0 },
    renderer_version: RENDERER_VERSION,
    duration_ms: Date.now() - started,
    errors,
  }
}

/**
 * Stamp the header logo's intrinsic pixel size into the migrated config
 * (`theme.{dark,light}.logo_width|logo_height`) from the probed `dims`
 * map. Lets the Worker emit <img width height> so the logo's box is
 * reserved before load. No-op when the logo wasn't a measurable image.
 */
function stampLogoDimensions(
  docMigrated: unknown,
  dims: Map<string, { width: number; height: number }>,
): void {
  if (!docMigrated || typeof docMigrated !== 'object') return
  const theme = (docMigrated as { config?: { theme?: Record<string, any> } }).config?.theme
  if (!theme) return
  for (const mode of ['dark', 'light'] as const) {
    const modeCfg = theme[mode]
    const url: unknown = modeCfg?.logo_url
    if (typeof url !== 'string') continue
    const id = url.match(/\/assets\/([^/?#]+)/)?.[1]
    if (!id) continue
    const d = dims.get(id)
    if (!d) continue
    modeCfg.logo_width = d.width
    modeCfg.logo_height = d.height
  }
}

/**
 * Walk an entry tree and yield every non-folder leaf (`page` AND
 * `api_endpoint`), each with its cumulative slug path (parent folder slugs
 * + the leaf slug). Folders don't get their own URL but contribute their
 * slug to descendants — matching the Worker's `findEntryBySlugPath`
 * resolution. Including `api_endpoint` ensures their content (.json/.html/
 * .md) and pages-index entry get published, not just their tree node.
 */
function flattenPagesWithPath(
  tree: DocEntryLike[],
  prefix: string[] = [],
  out: Array<{ entry: DocEntryLike; slugPath: string[] }> = [],
): Array<{ entry: DocEntryLike; slugPath: string[] }> {
  for (const node of tree) {
    const slugPath = [...prefix, node.slug ?? '']
    if (node.type !== 'folder') out.push({ entry: node, slugPath })
    if (node.children?.length) flattenPagesWithPath(node.children, slugPath, out)
  }
  return out
}

/**
 * Clean markdown for a page's stored `.md` + the LLM-facing routes. Raw
 * MDX is already markdown so it passes through untouched; pre-serialized
 * Tiptap JSON is serialized back to MDX via the shared serializer.
 */
function contentToMarkdown(content: string): string {
  const t = (content ?? '').trim()
  if (t.startsWith('{')) {
    try {
      const doc = JSON.parse(t)
      if (doc && typeof doc === 'object' && doc.type === 'doc') {
        return mdxSerializer.serialize(doc)
      }
    } catch {
      /* not valid JSON — already MDX, fall through */
    }
  }
  return content ?? ''
}

async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) return
      const item = items[idx]
      if (item !== undefined) await fn(item)
    }
  })
  await Promise.all(workers)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Race a promise against a timeout. Used by the orphan-cleanup step so a
 * stuck R2 LIST/DELETE never holds the subprocess open past the publish's
 * useful completion. The underlying fetch isn't actually aborted — the
 * caller just stops awaiting — but Node will tear it down on `process.exit`.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (err) => {
        clearTimeout(t)
        reject(err)
      },
    )
  })
}
