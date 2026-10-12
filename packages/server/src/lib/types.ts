/**
 * Domain → documentation mapping stored in KV. Writes come from the
 * control-plane / Go uploader; the Worker only reads.
 */
export interface DomainMapping {
  orgId: string
  docId: string
  /** Deferred for the POC — everything is served publicly for now. */
  isPrivate: boolean
}

/* ---------- Render-side view types ----------
 * Worker-safe shapes used by the SSR page + presentational components.
 * Relocated here from the (deleted) SSG `staticContent.ts` loader so the
 * Worker bundle never pulls node:fs.
 */

interface ColorMode {
  bg_color?: string
  text_color?: string
  accent_color?: string
  logo_url?: string
  /** Intrinsic logo pixel size, stamped by the render-cli at publish
   *  time so the header can reserve the logo's box (avoids CLS). */
  logo_width?: number
  logo_height?: number
}

export interface ThemeConfig {
  dark?: ColorMode
  light?: ColorMode
  modes?: string[]
  default?: 'dark' | 'light'
  font_family?: string
  heading_font?: string
  show_name?: boolean
  preset?: string
  /** Per-doc override of the preset's default corner-radius scale.
   *  When absent, the resolved preset's `shape` wins. */
  shape?: 'sharp' | 'soft' | 'round'
}

/** A page/folder node in the sidebar nav tree. Mirrors the metadata
 *  fields of a control-plane DocEntry the body actually reads. */
export interface PageTreeNode {
  id: string
  section_id?: string
  parent_id?: string
  title: string
  slug: string
  type: 'page' | 'folder' | string
  icon?: string
  order?: number
  /** HTTP verb for `api_endpoint` entries — drives the sidebar method badge. */
  method?: string
  /** API path for `api_endpoint` entries. */
  endpoint?: string
  children?: PageTreeNode[]
}
