/** Text helpers shared by the search backends. */

/** Markdown/MDX → searchable plain text. Lossy on purpose. */
export function plainText(src: string): string {
  return (
    src
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '') // frontmatter
      .replace(/^\s*(import|export)\s.+$/gm, '') // MDX imports/exports
      .replace(/```[^\n]*\n?/g, '\n') // fence markers, keep the code
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
      .replace(/<\/?[A-Za-z][^>]*>/g, ' ') // JSX / HTML tags
      .replace(/^\s{0,3}#{1,6}\s+/gm, '') // heading marks
      .replace(/^\s*>\s?(\[![A-Z]+\]\s*)?/gm, '') // quotes / GFM alerts
      .replace(/^\s*([-*+]|\d+\.)\s+/gm, '') // list markers
      .replace(/[*_~`|]+/g, ' ') // emphasis, code ticks, table pipes
      .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e as string] ?? '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim()
  )
}

/** Lowercase, accent-folded word tokens (Unicode letters and digits). */
export function tokenize(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * Up to `max` windows of `size` characters around where the query terms
 * occur, matches wrapped in `<mark>`. Same markup OpenSearch's highlighter
 * produces, so the client treats both alike.
 */
export function highlight(text: string, terms: string[], max = 3, size = 150): string[] {
  if (!terms.length || !text) return []
  const pattern = new RegExp(
    terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'giu',
  )
  const out: string[] = []
  let covered = -1
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0
    if (at < covered) continue
    const start = Math.max(0, at - Math.floor(size / 3))
    const end = Math.min(text.length, start + size)
    covered = end
    const frag = text.slice(start, end).replace(pattern, (x) => `<mark>${x}</mark>`)
    out.push((start > 0 ? '…' : '') + frag.trim() + (end < text.length ? '…' : ''))
    if (out.length >= max) break
  }
  return out
}

export interface Chunk {
  heading: string
  /** Plain text of the chunk. */
  text: string
}

/**
 * Split a markdown page into passages: cut at headings, then at paragraph
 * boundaries so no chunk is much longer than `max` characters. Fenced code
 * is never split at a `#` comment.
 */
export function chunkMarkdown(src: string, max = 1200): Chunk[] {
  const body = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  const out: Chunk[] = []
  let heading = ''
  let buf: string[] = []
  let size = 0
  let fence = false

  const flush = () => {
    const text = plainText(buf.join('\n'))
    if (text.length > 20) out.push({ heading, text })
    buf = []
    size = 0
  }

  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence
    const h = !fence && /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      flush()
      heading = h[2]
      continue
    }
    if (!fence && line.trim() === '' && size >= max * 0.6) {
      flush()
      continue
    }
    buf.push(line)
    size += line.length + 1
    if (size > max * 1.5 && !fence) flush()
  }
  flush()
  return out
}
