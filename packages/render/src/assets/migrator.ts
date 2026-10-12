import { imageSize } from 'image-size'
import type { ObjectSink } from '../upload/sink'
import type { ContentSourceClient } from '../types'

/**
 * Asset migration pipeline.
 *
 * Two source shapes appear in MDX content returned by content-runtime:
 *   1. Absolute signed GCS URLs — expire in ~15min. Must migrate or
 *      they rot.
 *   2. Relative paths `/assets/{id}` — content-runtime is expected to
 *      resolve them via its own /content/docs/asset/{id}/file endpoint
 *      which 302s to a signed GCS URL. Looks "clean" but still requires
 *      content-runtime alive; moving the bytes to R2 cuts the dep.
 *
 * Either way we end up with the bytes in R2 and a `/assets/{id}` URL
 * that resolves through the Worker's asset route. The Worker serves
 * legacy path shapes too via aliases.
 */

const GCS_SIGNED_URL =
  /https?:\/\/storage\.googleapis\.com\/[^\s"')<>]*?\/assets\/([a-f0-9-]{36})[^\s"')<>]*/g

/**
 * Matches the asset-URL shapes that show up in content + config:
 *   /assets/{uuid}
 *   /content/docs/asset/{uuid}/file              (legacy content-runtime)
 *   /documentation/{org}/{doc}/asset/{uuid}/file (dashboard asset path —
 *                                                  used by logo/favicon/og
 *                                                  URLs in the doc config)
 * All collapse to `/assets/{uuid}`, served by the Worker's asset route.
 */
const RELATIVE_ASSET_PATH =
  /\/(?:assets|content\/docs\/asset|documentation\/[a-f0-9-]+\/[a-f0-9-]+\/asset)\/([a-f0-9-]{36})(?:\/file)?/g

export interface AssetDimensions {
  width: number
  height: number
}

export interface AssetMigrationStats {
  unique_assets: number
  uploaded: number
  errors: Array<{ asset_id: string; message: string }>
}

export class AssetMigrator {
  private readonly uploaded = new Set<string>()
  private readonly failed = new Map<string, string>()
  /**
   * asset_id → intrinsic pixel dimensions. Populated when `image-size`
   * recognizes the file format. Used by the HTML renderer to emit
   * `<img width height>` attributes, killing CLS caused by images
   * reserving no space until they load.
   */
  private readonly dims = new Map<string, AssetDimensions>()
  private readonly stats: AssetMigrationStats = {
    unique_assets: 0,
    uploaded: 0,
    errors: [],
  }

  constructor(
    private readonly r2: ObjectSink,
    private readonly runtime: ContentSourceClient,
    private readonly docId: string,
  ) {}

  /**
   * Ensures all assets referenced by `mdx` are in R2, then returns a
   * body where every asset reference is normalized to `/assets/{id}`.
   * Idempotent and cheap to call per entry — downloads happen only for
   * asset IDs not seen before in this run.
   */
  async processBody(mdx: string): Promise<string> {
    if (!mdx) return mdx

    // Collect every asset ID referenced in this body, regardless of
    // which URL shape it came in. One download per ID across the whole
    // publish run (state lives on the migrator, survives calls).
    const idsInBody = new Set<string>()
    for (const m of mdx.matchAll(GCS_SIGNED_URL)) if (m[1]) idsInBody.add(m[1])
    for (const m of mdx.matchAll(RELATIVE_ASSET_PATH)) if (m[1]) idsInBody.add(m[1])
    if (idsInBody.size === 0) return mdx

    for (const assetId of idsInBody) {
      if (this.uploaded.has(assetId) || this.failed.has(assetId)) continue
      this.stats.unique_assets++
      try {
        const { bytes, contentType } = await this.runtime.downloadAsset(assetId)
        const key = `docs/${this.docId}/assets/${assetId}`
        await this.r2.putBytes(key, bytes, contentType)
        this.uploaded.add(assetId)
        this.stats.uploaded++

        // Probe image dimensions where possible. `image-size` silently
        // throws on non-images — that's fine, we just skip.
        try {
          const sized = imageSize(new Uint8Array(bytes))
          if (sized.width && sized.height) {
            this.dims.set(assetId, { width: sized.width, height: sized.height })
          }
        } catch {
          /* not an image or format not supported — skip */
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.failed.set(assetId, message)
        this.stats.errors.push({ asset_id: assetId, message })
      }
    }

    // Normalize every known asset reference to the stable shape the
    // Worker serves. Unknown / failed ones are left untouched (they'll
    // still 404 at serve time but the log already has the reason).
    let out = mdx.replace(GCS_SIGNED_URL, (full, id: string) =>
      this.uploaded.has(id) ? `/assets/${id}` : full,
    )
    out = out.replace(RELATIVE_ASSET_PATH, (full, id: string) =>
      this.uploaded.has(id) ? `/assets/${id}` : full,
    )
    return out
  }

  getStats(): AssetMigrationStats {
    return { ...this.stats, errors: [...this.stats.errors] }
  }

  /** Dimensions map snapshot — used by the HTML renderer. */
  getDimensions(): Map<string, AssetDimensions> {
    return new Map(this.dims)
  }
}
