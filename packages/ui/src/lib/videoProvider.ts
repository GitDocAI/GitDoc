/**
 * Video provider detection + safe embed-URL construction.
 *
 * This is the security boundary for the `<Video>` block: the block stores a
 * `provider` plus a raw `src`, and the renderer only ever emits an <iframe>
 * whose URL was produced by `buildEmbedUrl()` for a KNOWN provider. An
 * unknown provider (or an URL we can't parse) yields `null`, so no arbitrary
 * third-party URL can ever land inside a frame. Self-hosted files
 * (`provider: 'file'`) are rendered as a native <video>, never an iframe.
 *
 * Pure module — no DOM, no React — so it's shared by the MDX parser, the
 * insert modal, and the static (SSG) renderer alike.
 */

export type VideoProvider = 'youtube' | 'vimeo' | 'loom' | 'file'

export const EMBED_PROVIDERS: VideoProvider[] = ['youtube', 'vimeo', 'loom']

export function isVideoProvider(value: unknown): value is VideoProvider {
  return value === 'youtube' || value === 'vimeo' || value === 'loom' || value === 'file'
}

const YOUTUBE_RE =
  /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i
const VIMEO_RE = /vimeo\.com\/(?:video\/)?(\d+)(?:[/?#]([A-Za-z0-9]+))?/i
const LOOM_RE = /loom\.com\/(?:share|embed)\/([A-Za-z0-9]+)/i

export function extractYouTubeId(url: string): string | null {
  const m = url.match(YOUTUBE_RE)
  return m && m[1] ? m[1] : null
}

/** Returns `[id, hash?]` — hash is the private-link token in `vimeo.com/ID/HASH`. */
export function extractVimeoId(url: string): [string, string | undefined] | null {
  const m = url.match(VIMEO_RE)
  return m && m[1] ? [m[1], m[2]] : null
}

export function extractLoomId(url: string): string | null {
  const m = url.match(LOOM_RE)
  return m && m[1] ? m[1] : null
}

/**
 * Best-effort provider detection from a raw URL/path. Falls back to `'file'`
 * for asset paths and anything we don't recognize as a known embed host —
 * the caller (modal) lets the user confirm, and the renderer is the actual
 * safety gate.
 */
export function detectProvider(src: string): VideoProvider {
  if (!src) return 'file'
  if (extractYouTubeId(src)) return 'youtube'
  if (VIMEO_RE.test(src)) return 'vimeo'
  if (extractLoomId(src)) return 'loom'
  return 'file'
}

/**
 * Build the canonical, safe embed URL for an iframe-based provider. Returns
 * `null` for `provider: 'file'` (use a native <video> instead) and for any
 * src we can't confidently parse into a known provider's embed form.
 */
export function buildEmbedUrl(provider: VideoProvider, src: string): string | null {
  if (!src) return null
  if (!provider) {
    provider = detectProvider(src)
  }
  switch (provider) {
    case 'youtube': {
      const id = extractYouTubeId(src)
      return id ? `https://www.youtube-nocookie.com/embed/${id}` : null
    }
    case 'vimeo': {
      const parsed = extractVimeoId(src)
      if (!parsed) return null
      const [id, hash] = parsed
      return `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ''}`
    }
    case 'loom': {
      const id = extractLoomId(src)
      return id ? `https://www.loom.com/embed/${id}` : null
    }
    case 'file':
    default:
      return null
  }
}

export function providerLabel(provider: VideoProvider): string {
  switch (provider) {
    case 'youtube':
      return 'YouTube'
    case 'vimeo':
      return 'Vimeo'
    case 'loom':
      return 'Loom'
    case 'file':
      return 'Uploaded video'
  }
}
