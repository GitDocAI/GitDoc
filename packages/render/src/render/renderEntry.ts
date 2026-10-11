// Import both the parser AND the canonical HTML renderer from the UI
// source. We deliberately use `renderTiptapToHtml` (the same renderer
// the dashboard editor + old SSG use) instead of a hand-rolled walker:
// the custom one drifted and produced broken/placeholder output for
// tables and several components. Reusing the canonical renderer
// guarantees byte-for-byte parity with what authors see while editing.
// It pulls React + the presenters into the bundle (~big), but for a
// Node CLI invoked at publish time, fidelity beats bundle size.
// Path is relative to the GitDoc monorepo sibling: render-cli/ and
// GitDoc/ both live under code/GitDoc/.
import { mdxParser } from '../../../ui/src/services/mdxParser'
import {
  renderTiptapToHtml,
  type RenderOptions,
  type TiptapDoc,
} from '../../../ui/src/lib/renderTiptap'
import { highlightTiptapDoc } from './highlight'
import type { DocEntryLike, PageMeta, RenderedPage } from '../types'

/**
 * MDX → Tiptap JSON → HTML + meta. Reuses the same `mdxParser` +
 * `renderTiptapToHtml` the dashboard editor uses so the output is
 * byte-for-byte consistent with what users see during editing
 * (ignoring interactive parts that hydrate client-side on publish-web).
 */
export async function renderEntry(
  entry: DocEntryLike,
  renderOptions: RenderOptions = {},
): Promise<RenderedPage> {
  const raw = (entry.content ?? '').trim()
  let tiptapDoc: unknown = { type: 'doc', content: [] }

  if (raw) {
    // Entries may be stored as either raw MDX or pre-serialized
    // Tiptap JSON (`{type:"doc", content:[...]}`). Detect the JSON
    // shape up front — parsing JSON as MDX would silently produce
    // an empty document and ship a blank HTML file.
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
          tiptapDoc = parsed
        }
      } catch {
        /* not valid JSON — fall through to MDX path */
      }
    }
    // Only run the MDX parser when we didn't already get a Tiptap
    // doc from JSON.
    if ((tiptapDoc as { content?: unknown[] }).content?.length === 0) {
      tiptapDoc = (await mdxParser.parse(raw)).doc
    }
  }

  // Syntax-highlight code blocks (shiki) before rendering — sets
  // `highlightedHtml` on each codeBlock/codeGroup so renderTiptapToHtml
  // emits the dual-theme tokens instead of a raw <pre><code>.
  await highlightTiptapDoc(tiptapDoc)

  const html = renderTiptapToHtml(tiptapDoc as TiptapDoc, renderOptions)
  const meta: PageMeta = {
    title: (entry.title as string) || '',
    description: extractDescription(tiptapDoc),
    updated_at: (entry.updated_at as string) || undefined,
  }

  return {
    entry_id: entry.id,
    section_id: entry.section_id,
    html,
    meta,
  }
}

/** Best-effort: first paragraph's plain text, trimmed to 200 chars. */
function extractDescription(doc: unknown): string | undefined {
  if (!doc || typeof doc !== 'object') return undefined
  const content = (doc as { content?: Array<{ type: string; content?: any[] }> }).content
  const first = content?.find((n) => n.type === 'paragraph')
  if (!first?.content) return undefined
  const text = first.content.map((c: any) => c.text ?? '').join('').trim()
  if (!text) return undefined
  return text.length > 200 ? text.slice(0, 197) + '…' : text
}
