/**
 * Input/output shapes for `gitdoc-render publish`.
 *
 * The content-runtime Go service fills `PublishInput` from its DB and
 * pipes it in via stdin. The CLI reads it, renders every entry to HTML,
 * uploads R2 objects + a KV entry, and emits `PublishResult` on stdout.
 *
 * Keep the Documentation/Version/Section/DocEntry shapes in sync with
 * `publish-web-astro/src/types/documentation.types.ts` — both consumers
 * must agree on the JSON schema served out of R2.
 */

export interface CloudflareTarget {
  account_id: string
  /** Generic CF API token. Used for KV (no S3 alternative there) and as
   *  a fallback for R2 when no R2 access keys are provided. */
  api_token: string
  r2_bucket: string
  kv_namespace_id: string
  /** R2 S3-compatible API credentials. When set, R2 PUTs go through the
   *  S3 endpoint (`<account>.r2.cloudflarestorage.com`) which has a
   *  much higher rate limit than the CF REST API — critical for
   *  concurrent customer publishes. Generated from R2 dashboard ("Manage
   *  R2 API Tokens"). When absent, fall back to the REST endpoint with
   *  retry+backoff. */
  r2_access_key_id?: string
  r2_secret_access_key?: string
}

export interface DomainMapping {
  hostname: string
  org_id: string
  doc_id: string
  is_private: boolean
}

/**
 * Where the CLI fetches the documentation data from.
 *
 * We stream from content-runtime (not read everything from stdin) so a
 * 5,000-page doc stays in O(1 page) memory: fetch tree → for each entry,
 * fetch content → render → upload → free. Only refs + current page live
 * in memory at any moment.
 */
export interface ContentRuntimeSource {
  /** Discriminator. Optional/absent defaults to content-runtime. */
  kind?: 'content-runtime'
  base_url: string
  /** Bearer token that content-runtime accepts for internal publish calls. */
  auth_token?: string
  /**
   * Content-runtime resolves the doc via the Host / X-Dev-Domain header
   * (same resolution logic publish-web uses today). Pass the hostname the
   * user would visit.
   */
  hostname: string
}

/**
 * Reads a documentation straight from a local `content/` folder — the
 * backup-manifest format (`gitdocai.json` + per-page MDX + `assets/`).
 * Lets you seed KV + R2 from disk to test the Worker without a live
 * content-runtime backend.
 */
export interface LocalContentSource {
  kind: 'local'
  /** Absolute or CWD-relative path to the folder holding gitdocai.json. */
  content_dir: string
}

/**
 * Reads a documentation straight from the control-plane's internal
 * (s2s) read API, by org + doc id. control-plane spawns the CLI on
 * publish and already knows these ids, so there's no hostname round-trip.
 * Streams page-by-page like the content-runtime client.
 */
export interface ControlPlaneSource {
  kind: 'control-plane'
  /** Base URL of the control-plane (e.g. http://localhost:8080). */
  base_url: string
  /** S2S bearer token the control-plane accepts on its internal routes. */
  auth_token?: string
  organization_id: string
  documentation_id: string
}

/** Shared shape both source clients implement; publish.ts types against it. */
export interface ContentSourceClient {
  getDocumentation(): Promise<DocumentationLike & { versions: VersionLike[] }>
  listSections(versionId: string): Promise<SectionLike[]>
  getEntryTree(
    versionId: string,
    sectionId: string,
  ): Promise<{ section_id: string; doc_entries: DocEntryLike[] }>
  getEntry(versionId: string, sectionId: string, entryId: string): Promise<DocEntryLike>
  downloadAsset(assetId: string): Promise<{ bytes: ArrayBuffer; contentType: string }>
}

/** Write the rendered bundle to a directory instead of Cloudflare. */
export interface FsTarget {
  kind: 'fs'
  /** Data dir publish-web reads from (its DATA_DIR). */
  dir: string
}

export interface PublishInput {
  /** Cloudflare R2 + KV destination. Omit when `output` is set. */
  cloudflare?: CloudflareTarget
  /** Local directory destination (publish-web on Node). Wins over `cloudflare`. */
  output?: FsTarget
  /** One or more hostnames this doc should answer on (KV writes). */
  mappings: DomainMapping[]
  /** Where to fetch doc/section/entry payloads from. */
  source: ContentRuntimeSource | LocalContentSource | ControlPlaneSource
}

/** Partial shapes — keep aligned with publish-web's documentation.types.ts. */
export interface DocumentationLike {
  id: string
  organization_id: string
  [key: string]: unknown
}
export interface VersionLike {
  id: string
  is_default?: boolean
  is_latest?: boolean
  [key: string]: unknown
}
export interface SectionLike {
  id: string
  version_id: string
  slug?: string
  name?: string
  [key: string]: unknown
}
export interface DocEntryLike {
  id: string
  section_id: string
  type: 'page' | 'folder'
  slug?: string
  content?: string
  /** The tree endpoint returns children but typically WITHOUT content. */
  children?: DocEntryLike[]
  [key: string]: unknown
}

export interface RenderedPage {
  entry_id: string
  section_id: string
  /** Rendered body HTML (no `<html>`/`<body>` — Worker wraps it). */
  html: string
  /** Extracted metadata used for `<meta>` tags + SEO. */
  meta: PageMeta
}

export interface PageMeta {
  title: string
  description?: string
  og_image?: string
  updated_at?: string
}

export interface PublishError {
  where: 'render' | 'r2' | 'kv' | 'r2-cleanup' | 'input'
  entry_id?: string
  message: string
}

export interface PublishResult {
  status: 'ok' | 'partial' | 'failed'
  rendered_pages: number
  uploaded_objects: number
  kv_writes: number
  cleanup_deleted: number
  /** Asset migration summary (images/files moved from GCS → R2). */
  assets: {
    unique: number
    uploaded: number
    failed: number
  }
  renderer_version: string
  duration_ms: number
  errors: PublishError[]
}
