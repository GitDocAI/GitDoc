/**
 * Render a tiny subset of inline markdown to HTML — backticks, bold,
 * italic, strikethrough, links, inline images. Used inside surfaces
 * that don't run a full markdown processor on the cell text (table
 * cells, label text, etc.) but still want rich-looking output.
 *
 * Always HTML-escapes the input first, so passing user-typed text is
 * XSS-safe even after the inline-tag substitutions run.
 *
 * Shared between the editor's `TableNodeView` (Tiptap preview render)
 * and the SSG's `renderTiptap.tsx` (static publish render) — both use
 * the same regex set so the cell contents look identical across the
 * two surfaces.
 */
export function renderInlineMarkdown(text: string): string {
  if (!text) return ''

  let result = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

  result = result.replace(
    /`([^`]+)`/g,
    '<code style="padding:1px 5px;border-radius:4px;font-size:0.9em;background:rgba(127,127,127,0.15)">$1</code>',
  )
  result = result.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    '<img src="$2" alt="$1" style="max-height:1.5em;vertical-align:middle" />',
  )
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#3b82f6;text-decoration:underline">$1</a>',
  )
  result = result.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
  result = result.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
  result = result.replace(/\*(.*?)\*/g, '<em>$1</em>')
  result = result.replace(/~~(.*?)~~/g, '<del>$1</del>')

  return result
}
