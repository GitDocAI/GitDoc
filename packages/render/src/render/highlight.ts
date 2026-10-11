import { codeToHtml } from 'shiki'

/**
 * Server-side syntax highlighting for the publish pipeline. The dashboard
 * editor highlights code blocks client-side (per node) and stores the
 * result as `highlightedHtml`; when content round-trips through MDX that
 * attr is lost, so renderTiptapToHtml falls back to raw <pre><code>.
 *
 * This walks the parsed Tiptap doc and re-highlights every codeBlock /
 * codeGroup with the SAME shiki config the editor uses (dual theme,
 * `defaultColor: false` so each token carries `--shiki-light` +
 * `--shiki-dark` and the CSS picks per page theme). It mutates the doc
 * in place; call it after mdxParser.parse and before renderTiptapToHtml.
 */

interface TiptapNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown> | null
  content?: TiptapNode[]
  [key: string]: unknown
}

interface CodeGroupFile {
  language?: string
  code?: string
  highlightedHtml?: string
  [key: string]: unknown
}

async function highlight(code: string, lang: string | undefined): Promise<string> {
  let html = await codeToHtml(code, {
    lang: lang || 'plaintext',
    themes: { light: 'github-light-default', dark: 'dark-plus' },
    defaultColor: false,
  })
  // Match the editor's tweak: swap shiki's default dark bg for ours.
  html = html.replace('--shiki-dark-bg:#1E1E1E', '--shiki-dark-bg:#0B0C0E')
  return html
}

/** Best-effort: a bad/unknown language must never fail the whole publish. */
async function safeHighlight(code: string, lang: string | undefined): Promise<string | null> {
  try {
    return await highlight(code, lang)
  } catch {
    try {
      // Retry as plaintext — covers langs shiki doesn't know.
      return await highlight(code, 'plaintext')
    } catch {
      return null
    }
  }
}

export async function highlightTiptapDoc(doc: unknown): Promise<void> {
  if (!doc || typeof doc !== 'object') return
  await walk(doc as TiptapNode)
}

async function walk(node: TiptapNode): Promise<void> {
  if (node.type === 'codeBlock') {
    const already = node.attrs?.highlightedHtml
    if (!already) {
      const text = (node.content ?? [])
        .map((c) => (c.type === 'text' ? c.text ?? '' : ''))
        .join('')
      if (text.trim()) {
        const html = await safeHighlight(text, node.attrs?.language as string | undefined)
        if (html) node.attrs = { ...(node.attrs ?? {}), highlightedHtml: html }
      }
    }
  } else if (node.type === 'codeGroup') {
    const files = (node.attrs?.files ?? []) as CodeGroupFile[]
    for (const f of files) {
      if (!f.highlightedHtml && f.code && f.code.trim()) {
        const html = await safeHighlight(f.code, f.language)
        if (html) f.highlightedHtml = html
      }
    }
  }
  if (node.content) {
    for (const child of node.content) await walk(child)
  }
}
