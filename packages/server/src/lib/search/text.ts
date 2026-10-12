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

/**
 * Words that say nothing about what a page is about. They are dropped from the
 * query: "how to install" is a search for "install", and without this every
 * page that has a "to" or a "how" in it matches.
 */
const STOPWORDS = new Set(
  (
    // English
    'a an and are as at be but by can could do does did for from had has have how i if in into is it its me my no not of on ' +
    'or our so than that the their them then there these they this to up us was we were what when where which who why will ' +
    'with would you your about after again all also any been before being between both each few more most other over same ' +
    'get got make way ' +
    'should some such too under very while ' +
    // Spanish
    'el la los las un una unos unas y o u de del al en con por para sin sobre entre es son ser fue como que cual cuales ' +
    'cuando donde quien quienes porque se su sus lo le les mi mis tu tus nuestro nuestra esto eso esta este estos estas ' +
    'hay muy mas pero si no ya hacer puedo puede pueden'
  ).split(' '),
)

/** The words of a query that carry meaning; all of them if nothing else is left. */
export function queryTerms(query: string): string[] {
  const all = tokenize(query)
  const kept = all.filter((t) => !STOPWORDS.has(t))
  return kept.length ? kept : all
}

/** Hits scoring below this share of the best lexical hit are noise. */
export const LEXICAL_FLOOR_RATIO = 0.3
/** The best page must stand this far (cosine) above the median page, or nothing matched by meaning. */
export const SEMANTIC_MIN_GAP = 0.06

/**
 * Which semantic similarities (cosine, one per page) count as a match.
 *
 * A fixed threshold does not work: embedding models differ a lot in how close
 * unrelated text sits (some put everything at 0.3-0.5). What does hold is that
 * a question about the docs has a *winner* clearly above the rest, while
 * nonsense leaves every page bunched around the median. So: nothing matches
 * unless the best page stands out from the median, and then only pages in the
 * upper half between the median and the best do.
 *
 * Returns the cut-off, or null when there is no semantic match at all.
 */
export function semanticCutoff(sims: number[], floor: number): number | null {
  if (!sims.length) return null
  const sorted = [...sims].sort((a, b) => b - a)
  const top = sorted[0]
  if (top < floor) return null
  const median = sorted[Math.floor(sorted.length / 2)]
  if (sorted.length >= 3 && top - median < SEMANTIC_MIN_GAP) return null
  return Math.max(floor, median + (top - median) * 0.5)
}

/**
 * How many of the query's meaningful terms a page must match to be a hit:
 * all of one or two, three quarters of more ("run a docker image" needs two of
 * run/docker/image, so a page that merely says "run" is out).
 */
export function termsRequired(n: number): number {
  return n <= 2 ? n : Math.max(2, Math.floor(n * 0.75))
}
