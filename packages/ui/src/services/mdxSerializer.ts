/**
 * MDX Serializer Service
 * Converts TipTap JSON format back to MDX content
 */

interface TipTapNode {
  type: string
  attrs?: Record<string, any>
  content?: TipTapNode[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, any> }>
}

interface SerializeOptions {
  tight?: boolean // For list items - no blank lines between
  level?: number // For nested structures
}

class MDXSerializerService {
  /**
   * Serialize TipTap document to MDX string
   */
  serialize(doc: TipTapNode): string {
    if (doc.type !== 'doc') {
      throw new Error('Root node must be of type "doc"')
    }

    if (!doc.content || doc.content.length === 0) {
      return ''
    }

    const lines: string[] = []

    for (let i = 0; i < doc.content.length; i++) {
      const node = doc.content[i]
      if (!node) continue
      const serialized = this.serializeNode(node)

      if (serialized) {
        lines.push(serialized)

        // Add blank line after certain block types (but not before horizontal rules or between list items)
        const nextNode = doc.content[i + 1]
        if (nextNode && this.needsBlankLineAfter(node, nextNode)) {
          lines.push('')
        }
      }
    }

    return lines.join('\n')
  }

  /**
   * Determine if a blank line is needed between two nodes
   */
  private needsBlankLineAfter(current: TipTapNode, next: TipTapNode): boolean {
    /* Blank line REQUIRED before/after horizontal rule. Without it
       a `paragraph\n---` block re-parses as setext h2 (the `---`
       becomes the underline). Mintlify and Notion both insert blank
       lines around HRs for this exact reason. */
    if (next.type === 'horizontalRuleBlock' || current.type === 'horizontalRuleBlock') {
      return true
    }

    // No blank line between list items of the same type
    if (
      (current.type === 'bulletList' && next.type === 'bulletList') ||
      (current.type === 'orderedList' && next.type === 'orderedList') ||
      (current.type === 'taskList' && next.type === 'taskList')
    ) {
      return false
    }

    // Blank line after these block types
    const needsBlankLine = [
      'heading',
      'paragraph',
      'blockquote',
      'codeBlock',
      'bulletList',
      'orderedList',
      'taskList',
      'imageBlock',
      'videoBlock',
      'infoBlock',
      'cardBlock',
      'accordionBlock',
      'tabsBlock',
      'columnsBlock',
      'rightPanel',
      'tableBlock',
      'codeGroup',
      'endpointBlock',
      'responseBlock',
      'mermaidBlock',
      'changelogBlock',
    ]

    return needsBlankLine.includes(current.type)
  }

  /**
   * Serialize a single node
   */
  private serializeNode(node: TipTapNode, options: SerializeOptions = {}): string {

    switch (node.type) {


      case 'heading': {
        return this.serializeHeading(node)
      }

      case 'paragraph':
        return this.serializeParagraph(node)

      case 'blockquote':
        return this.serializeBlockquote(node)

      case 'bulletList':
        return this.serializeBulletList(node)

      case 'orderedList':
        return this.serializeOrderedList(node)

      case 'taskList':
        return this.serializeTaskList(node)

      case 'listItem':
        return this.serializeListItem(node, options)

      case 'taskItem':
        return this.serializeTaskItem(node, options)

      case 'codeBlock':
        return this.serializeCodeBlock(node)

      case 'horizontalRuleBlock':
        return '---'

      case 'imageBlock':
        return this.serializeImage(node)

      case 'videoBlock':
        return this.serializeVideoBlock(node)

      case 'hardBreak':
        return '  ' // Two spaces = hard break in markdown

      case 'infoBlock':
      case 'tipBlock':
      case 'noteBlock':
      case 'warningBlock':
      case 'dangerBlock':
        return this.serializeInfoBlock(node)

      case 'cardBlock':
        return this.serializeCardBlock(node)

      case 'accordionBlock':
        return this.serializeAccordionBlock(node)

      case 'tabsBlock':
        return this.serializeTabsBlock(node)

      case 'columnsBlock':
        return this.serializeColumnsBlock(node)

      case 'rightPanel':
        return this.serializeRightPanel(node)

      case 'tableBlock':
        return this.serializeTableBlock(node)

      case 'codeGroup':
        return this.serializeCodeGroup(node)

      case 'endpointBlock':
        return this.serializeEndpointBlock(node)

      case 'labelBlock':
        return this.serializeLabelBlock(node)

      case 'paramBlock':
        return this.serializeParamBlock(node)

      case 'responseBlock':
        return this.serializeResponseBlock(node)

      case 'stepsBlock':
        return this.serializeStepsBlock(node)

      case 'stepBlock':
        // Individual steps are handled by stepsBlock
        return ''

      case 'mermaidBlock':
        return this.serializeMermaidBlock(node)

      case 'changelogBlock':
        return this.serializeChangelogBlock(node)

      case 'updateBlock':
        // Free-standing updateBlocks (no changelog parent) still serialize
        // so the editor doesn't silently drop them.
        return this.serializeUpdateBlock(node)

      default:
        console.warn(`[MDXSerializer] Unknown node type: ${node.type}`)
        return ''
    }
  }

  /**
   * Serialize heading
   */
  private serializeHeading(node: TipTapNode): string {
    const level = node.attrs?.level || 1
    const prefix = '#'.repeat(level)
    const text = this.serializeInlineContent(node.content || [])
    return `${prefix} ${text}`
  }

  /**
   * Serialize paragraph
   */
  private serializeParagraph(node: TipTapNode): string {
    return this.serializeInlineContent(node.content || [])
  }

  /**
   * Serialize blockquote
   */
  private serializeBlockquote(node: TipTapNode): string {
    const content = node.content || []
    const lines: string[] = []

    for (const child of content) {
      const serialized = this.serializeNode(child)
      if (serialized) {
        // Prefix each line with "> "
        serialized.split('\n').forEach(line => {
          lines.push(`> ${line}`)
        })
      }
    }

    return lines.join('\n')
  }

  /**
   * Serialize bullet list
   */
  private serializeBulletList(node: TipTapNode): string {
    const items = node.content || []
    const lines: string[] = []

    for (const item of items) {
      const serialized = this.serializeNode(item, { tight: true })
      if (serialized) {
        lines.push(serialized)
      }
    }

    return lines.join('\n')
  }

  /**
   * Serialize ordered list
   */
  private serializeOrderedList(node: TipTapNode): string {
    const items = node.content || []
    const lines: string[] = []
    const start = node.attrs?.start || 1

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item) continue
      const serialized = this.serializeNode(item, { tight: true })
      if (serialized) {
        // Replace the bullet with number
        const numbered = serialized.replace(/^- /, `${start + i}. `)
        lines.push(numbered)
      }
    }

    return lines.join('\n')
  }

  /**
   * Serialize task list
   */
  private serializeTaskList(node: TipTapNode): string {
    const items = node.content || []
    const lines: string[] = []

    for (const item of items) {
      const serialized = this.serializeNode(item, { tight: true })
      if (serialized) {
        lines.push(serialized)
      }
    }

    return lines.join('\n')
  }

  /**
   * Serialize list item
   */
  private serializeListItem(node: TipTapNode, options: SerializeOptions): string {
    void options
    const content = node.content || []
    const parts: string[] = []

    for (const child of content) {
      if (child.type === 'paragraph') {
        parts.push(this.serializeInlineContent(child.content || []))
      } else {
        // Nested list or other block content
        const nested = this.serializeNode(child)
        if (nested) {
          // Indent nested content
          parts.push(
            nested
              .split('\n')
              .map(line => `  ${line}`)
              .join('\n')
          )
        }
      }
    }

    return `- ${parts.join('\n  ')}`
  }

  /**
   * Serialize task item
   */
  private serializeTaskItem(node: TipTapNode, options: SerializeOptions): string {
    void options
    const checked = node.attrs?.checked || false
    const checkbox = checked ? '[x]' : '[ ]'
    const content = node.content || []
    const text = content
      .map(child => {
        if (child.type === 'paragraph') {
          return this.serializeInlineContent(child.content || [])
        }
        return this.serializeNode(child)
      })
      .join(' ')

    return `- ${checkbox} ${text}`
  }

  /**
   * Serialize code block
   */
  private serializeCodeBlock(node: TipTapNode): string {
    const lang = node.attrs?.language || ''
    const code = node.content?.[0]?.text || ''
    return `\`\`\`${lang}\n${code}\n\`\`\``
  }

  /**
   * Serialize image
   */
  private serializeImage(node: TipTapNode): string {
    const src = node.attrs?.src || ''
    const alt = node.attrs?.alt || ''
    const title = node.attrs?.caption

    if (title) {
      return `![${alt}](${src} "${title}")`
    }
    return `![${alt}](${src})`
  }

  /**
   * Serialize inline content (text with marks)
   */
  private serializeInlineContent(nodes: TipTapNode[]): string {
    return nodes.map(node => this.serializeInlineNode(node)).join('')
  }

  /**
   * Serialize a single inline node
   */
  private serializeInlineNode(node: TipTapNode): string {
    if (node.type === 'text') {
      return this.serializeTextWithMarks(node)
    }

    if (node.type === 'hardBreak') {
      return '  \n' // Two spaces + newline
    }


    if (node.type === 'emoji') {
      const name = node.attrs?.name || ''
      if (name) {
        return `:${name}:`
      }
    }

    return ''
  }

  /**
   * Serialize text node with marks (bold, italic, code, etc.)
   */
  private serializeTextWithMarks(node: TipTapNode): string {
    let text = node.text || ''
    const marks = node.marks || []

    // Apply marks in specific order
    const markOrder = ['link', 'code', 'bold', 'italic', 'strike', 'underline']

    // Sort marks by the order defined above
    const sortedMarks = [...marks].sort((a, b) => {
      const aIndex = markOrder.indexOf(a.type)
      const bIndex = markOrder.indexOf(b.type)
      return aIndex - bIndex
    })

    // Apply each mark
    for (const mark of sortedMarks) {
      text = this.applyMark(text, mark)
    }

    return text
  }

  /**
   * Apply a single mark to text
   */
  private applyMark(text: string, mark: { type: string; attrs?: Record<string, any> }): string {
    switch (mark.type) {
      case 'bold':
        return `**${text}**`

      case 'italic':
        return `*${text}*`

      case 'strike':
        return `~~${text}~~`

      case 'underline':
        return `<u>${text}</u>`

      case 'code':
        return `\`${text}\``

      case 'link':
        const href = mark.attrs?.href || ''
        return `[${text}](${href})`

      default:
        return text
    }
  }

  /**
   * Serialize info block (Tip, Info, Note, Warning, Danger)
   */
  private serializeInfoBlock(node: TipTapNode): string {
    // Determine type from node.type name or attrs.type
    let type = node.attrs?.type || 'info'

    // Extract type from node name if it's a specific block type
    if (node.type === 'tipBlock') type = 'tip'
    else if (node.type === 'noteBlock') type = 'note'
    else if (node.type === 'warningBlock') type = 'warning'
    else if (node.type === 'dangerBlock') type = 'danger'

    const content = node.content || []

    /* Canonical form: JSX components (<Info>, <Tip>, <Note>,
       <Warning>, <Danger>). Both this AND the `> [!TYPE]` GFM
       blockquote syntax parse to the same infoBlock node, so the
       round-trip user-wrote `<Info>` stays `<Info>` and user-wrote
       `> [!INFO]` ALSO stays as JSX (canonical). */
    const tagMap: Record<string, string> = {
      tip: 'Tip',
      info: 'Info',
      note: 'Note',
      warning: 'Warning',
      danger: 'Danger',
    }
    const tag = tagMap[type] || 'Info'
    const lines: string[] = [`<${tag}>`]

    for (const child of content) {
      const serialized = this.serializeNode(child)
      if (serialized) {
        serialized.split('\n').forEach(line => {
          lines.push(`  ${line}`)
        })
      }
    }

    lines.push(`</${tag}>`)
    return lines.join('\n')
  }

  /**
   * Serialize Card block
   */
  private serializeCardBlock(node: TipTapNode): string {
    const title = node.attrs?.title || ''
    const icon = node.attrs?.icon || ''
    const iconAlign = node.attrs?.iconAlign || 'left'
    const href = node.attrs?.href || ''

    const attrs: string[] = []
    if (title) attrs.push(`title="${this.escapeAttr(title)}"`)
    if (icon) attrs.push(`icon="${this.escapeAttr(icon)}"`)
    if (iconAlign !== 'left') attrs.push(`iconAlign="${iconAlign}"`)
    if (href) attrs.push(`href="${this.escapeAttr(href)}"`)

    const content = node.content || []
    const firstChild = content[0]

    if (content.length === 0 || (content.length === 1 && firstChild?.type === 'paragraph' && !firstChild?.content?.length)) {
      // Self-closing tag
      return `<Card ${attrs.join(' ')} />`
    }

    // With content
    const lines: string[] = [`<Card ${attrs.join(' ')}>`]

    for (const child of content) {
      const serialized = this.serializeNode(child)
      if (serialized) {
        lines.push('')
        lines.push(serialized)
      }
    }

    lines.push('')
    lines.push('</Card>')

    return lines.join('\n')
  }

  /**
   * Serialize Accordion block
   */
  private serializeAccordionBlock(node: TipTapNode): string {
    /* `multiple` defaults to true. Only emit it when the user
       opted out (multiple={false}) — emitting the default cluttered
       every <Accordion> with `multiple={true}` after a round-trip. */
    const multiple = node.attrs?.multiple !== false
    const content = node.content || []

    const attrs = multiple ? '' : ' multiple={false}'
    const lines: string[] = [`<Accordion${attrs}>`]

    for (const tab of content) {
      if (tab.type === 'accordionTab') {
        const header = tab.attrs?.header || 'Accordion Item'
        const icon = tab.attrs?.icon?`icon="${tab.attrs.icon}"`:''
        lines.push(`  <AccordionTab title="${this.escapeAttr(header)}" ${icon}>`)
        lines.push('')

        const tabContent = tab.content || []
        for (const child of tabContent) {
          const serialized = this.serializeNode(child)
          if (serialized) {
            // Indent content
            serialized.split('\n').forEach(line => {
              lines.push(`    ${line}`)
            })
          }
        }

        lines.push('')
        lines.push('  </AccordionTab>')
        lines.push('')
      }
    }

    lines.push('</Accordion>')

    return lines.join('\n')
  }

  /**
   * Serialize Tabs block
   */
  private serializeTabsBlock(node: TipTapNode): string {
    const content = node.content || []
    const lines: string[] = ['<Tabs>']

    for (const tab of content) {
      if (tab.type === 'tabBlock') {
        const label = tab.attrs?.label || 'Tab'
        lines.push(`  <Tab title="${this.escapeAttr(label)}">`)
        lines.push('')

        const tabContent = tab.content || []
        for (const child of tabContent) {
          const serialized = this.serializeNode(child)
          if (serialized) {
            serialized.split('\n').forEach(line => {
              lines.push(`    ${line}`)
            })
          }
        }

        lines.push('')
        lines.push('  </Tab>')
        lines.push('')
      }
    }

    lines.push('</Tabs>')

    return lines.join('\n')
  }

  /**
   * Serialize Columns block
   */
  private serializeColumnsBlock(node: TipTapNode): string {
    /* Canonical form: <ColumnGroup cols="N">. The parser accepts
       both `<Columns>` and `<ColumnGroup>` and both `cols` and
       `columnCount`, but emitting one canonical form means the
       user's first write matches what comes back on save. */
    const cols = node.attrs?.columnCount || 2
    const content = node.content || []

    const lines: string[] = [`<ColumnGroup cols="${cols}">`]

    for (const column of content) {
      if (column.type === 'column') {
        lines.push('  <Column>')

        const colContent = column.content || []
        for (const child of colContent) {
          const serialized = this.serializeNode(child)
          if (serialized) {
            serialized.split('\n').forEach(line => {
              lines.push(`    ${line}`)
            })
          }
        }

        lines.push('  </Column>')
      }
    }

    lines.push('</ColumnGroup>')

    return lines.join('\n')
  }

  /**
   * Serialize RightPanel
   */
  private serializeRightPanel(node: TipTapNode): string {
    const content = node.content || []
    const lines: string[] = ['<RightPanel>']

    for (const child of content) {
      const serialized = this.serializeNode(child)
      if (serialized) {
        serialized.split('\n').forEach(line => {
          lines.push(`  ${line}`)
        })
      }
    }

    lines.push('</RightPanel>')

    return lines.join('\n')
  }

  /**
   * Serialize Table block
   */
  private serializeTableBlock(node: TipTapNode): string {
    const attrs = node.attrs || {}
    const columns = attrs.columns || []
    const rows = attrs.rows || []
    // The publish-side SSG renders every table as a plain `<table>`
    // (no sort / filter / paginate), so we always serialize to
    // markdown-table syntax. Legacy `<Table data={[...]}>` output
    // and the per-column `<sortable>`/`<filterable>` markers are
    // gone — re-saved docs lose them naturally.
    return this.serializeMarkdownTable(columns, rows)
  }

  /**
   * Sanitize a single cell value before it lands between pipes.
   * Markdown table rows must be single-line — any `\n` (e.g. from
   * AI-generated MDX where the model put inline code on its own
   * line, or a paste of multi-line text) would split the row and
   * break the table. Pipes inside the cell need escaping for the
   * same reason. Tabs collapse to single spaces.
   */
  private sanitizeCell(value: unknown): string {
    return String(value ?? '')
      .replace(/\r\n|\r|\n|\t/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\|/g, '\\|')
      .trim()
  }

  /**
   * Serialize markdown table
   */
  private serializeMarkdownTable(columns: any[], rows: any[]): string {
    if (columns.length === 0) return ''

    const lines: string[] = []

    // Header row — column labels get the same sanitation since
    // they're stored as strings and could carry the same junk.
    const headers = columns.map(col => this.sanitizeCell(col.label || col.id))
    lines.push(`| ${headers.join(' | ')} |`)

    // Separator row
    const separators = columns.map(() => '---')
    lines.push(`|${separators.join('|')}|`)

    // Data rows
    for (const row of rows) {
      const cells = columns.map(col => this.sanitizeCell(row[col.id]))
      lines.push(`| ${cells.join(' | ')} |`)
    }

    return lines.join('\n')
  }

  /**
   * Serialize CodeGroup
   */
  private serializeCodeGroup(node: TipTapNode): string {
    const files = node.attrs?.files || []
    const lines: string[] = ['<CodeGroup>', '']

    for (const file of files) {
      const lang = file.language || ''
      const filename = file.filename || ''
      const code = file.code || ''

      /* Only emit the filename suffix when the user actually
         supplied one. The previous version always wrote
         `\`\`\`<lang> <filename>` (defaulting to `example.<lang>`),
         which polluted user code blocks on save. */
      const fence = filename
        ? `\`\`\`${lang} ${filename}`.trim()
        : `\`\`\`${lang}`
      lines.push(fence)
      lines.push(code)
      lines.push('```')
      lines.push('')
    }

    lines.push('</CodeGroup>')

    return lines.join('\n')
  }

  /**
   * Serialize Endpoint block
   */
  private serializeEndpointBlock(node: TipTapNode): string {
    const method = node.attrs?.method || 'GET'
    const path = node.attrs?.path || '/'

    return `<Endpoint method="${method}" path="${this.escapeAttr(path)}" />`
  }

  /**
   * Serialize Video block
   */
  private serializeVideoBlock(node: TipTapNode): string {
    const src = node.attrs?.src || ''
    const provider = node.attrs?.provider || 'youtube'
    const title = node.attrs?.title || ''

    const titleAttr = title ? ` title="${this.escapeAttr(title)}"` : ''
    return `<Video src="${this.escapeAttr(src)}" provider="${provider}"${titleAttr} />`
  }

  /**
   * Serialize Label block
   * Supports both old format (single label) and new format (labels array or JSON string)
   */
  private serializeLabelBlock(node: TipTapNode): string {
    // Check for new labels format (could be array or JSON string)
    let labels = node.attrs?.labels

    // Parse JSON string if necessary
    if (typeof labels === 'string' && labels !== '[]') {
      try {
        labels = JSON.parse(labels)
      } catch {
        labels = null
      }
    }

    if (labels && Array.isArray(labels) && labels.length > 0) {
      if (labels.length === 1) {
        // Single label - use simple format
        const label = labels[0]
        const iconAttr = label.icon ? ` icon="${this.escapeAttr(label.icon)}"` : ''
        return `<Label label="${this.escapeAttr(label.text)}" color="${label.color || '#3b82f6'}" size="${label.size || 'md'}"${iconAttr} />`
      } else {
        // Multiple labels - use Labels wrapper
        const labelElements = labels.map((label: { text: string; color?: string; size?: string; icon?: string }) => {
          const iconAttr = label.icon ? ` icon="${this.escapeAttr(label.icon)}"` : ''
          return `  <Label label="${this.escapeAttr(label.text)}" color="${label.color || '#3b82f6'}" size="${label.size || 'md'}"${iconAttr} />`
        }).join('\n')
        return `<Labels>\n${labelElements}\n</Labels>`
      }
    }

    // Fallback to old format
    const label = node.attrs?.label || ''
    const color = node.attrs?.color || '#3b82f6'
    const size = node.attrs?.size || 'md'

    return `<Label label="${this.escapeAttr(label)}" color="${color}" size="${size}" />`
  }

  /**
   * Serialize ParamField block
   */
  private serializeParamBlock(node: TipTapNode): string {
    /* Canonical: <Param> (both <Param> and <ParamField> parse to the
       same paramBlock). Required is emitted as a HTML5-style boolean
       attribute when truthy. */
    const path = node.attrs?.path || 'param'
    const type = node.attrs?.type || 'string'
    const required = node.attrs?.required || false
    const description = node.attrs?.description || ''

    const requiredAttr = required ? ' required' : ''

    if (description) {
      return `<Param path="${this.escapeAttr(path)}" type="${this.escapeAttr(type)}"${requiredAttr}>\n  ${this.escapeAttr(description)}\n</Param>`
    }

    return `<Param path="${this.escapeAttr(path)}" type="${this.escapeAttr(type)}"${requiredAttr} />`
  }

  /**
   * Serialize Response block
   */
  private serializeResponseBlock(node: TipTapNode): string {
    const status = node.attrs?.status || '200'
    const description = node.attrs?.description || ''

    if (description) {
      return `<Response status="${this.escapeAttr(status)}">\n  ${this.escapeAttr(description)}\n</Response>`
    }

    return `<Response status="${this.escapeAttr(status)}" />`
  }

  /**
   * Serialize Steps block
   */
  private serializeStepsBlock(node: TipTapNode): string {
    const steps = node.content || []
    const lines: string[] = ['<Steps>']

    for (const step of steps) {
      if (step.type === 'stepBlock') {
        const title = step.attrs?.title || 'Step'
        lines.push(`  <Step title="${this.escapeAttr(title)}">`)

        const stepContent = step.content || []
        for (const child of stepContent) {
          const serialized = this.serializeNode(child)
          if (serialized) {
            serialized.split('\n').forEach(line => {
              lines.push(`    ${line}`)
            })
          }
        }

        lines.push('  </Step>')
      }
    }

    lines.push('</Steps>')

    return lines.join('\n')
  }

  /**
   * Serialize MermaidBlock node
   */
  private serializeMermaidBlock(node: TipTapNode): string {
    const diagram = node.attrs?.diagram || ''
    return `\`\`\`mermaid\n${diagram}\n\`\`\``
  }

  /**
   * Serialize a Changelog container.
   * <Changelog title="..." description="...">...<Update/>...</Changelog>
   */
  private serializeChangelogBlock(node: TipTapNode): string {
    const title = node.attrs?.title || ''
    const description = node.attrs?.description || ''

    const attrs: string[] = []
    if (title) attrs.push(`title="${this.escapeAttr(title)}"`)
    if (description) attrs.push(`description="${this.escapeAttr(description)}"`)
    const attrStr = attrs.length ? ' ' + attrs.join(' ') : ''

    const updates = (node.content || [])
      .filter((n) => n.type === 'updateBlock')
      .map((n) => this.serializeUpdateBlock(n))
      .join('\n\n')

    return `<Changelog${attrStr}>\n${updates}\n</Changelog>`
  }

  /**
   * Serialize an Update entry. Body is emitted as markdown inside the
   * Update tags (blank line after the opening tag so MDX parses it).
   */
  private serializeUpdateBlock(node: TipTapNode): string {
    const { label, description, tags, prerelease, author, href, id } = node.attrs || {}

    const attrs: string[] = []
    if (label) attrs.push(`label="${this.escapeAttr(label)}"`)
    if (description) attrs.push(`description="${this.escapeAttr(description)}"`)
    if (tags) attrs.push(`tags="${this.escapeAttr(tags)}"`)
    if (prerelease) attrs.push('prerelease={true}')
    if (author) attrs.push(`author="${this.escapeAttr(author)}"`)
    if (href) attrs.push(`href="${this.escapeAttr(href)}"`)
    if (id) attrs.push(`id="${this.escapeAttr(id)}"`)
    const attrStr = attrs.length ? ' ' + attrs.join(' ') : ''

    const body = (node.content || [])
      .map((child, idx, arr) => {
        const s = this.serializeNode(child)
        if (!s) return ''
        const next = arr[idx + 1]
        return next ? s + (this.needsBlankLineAfter(child, next) ? '\n\n' : '\n') : s
      })
      .join('')

    return `<Update${attrStr}>\n${body}\n</Update>`
  }

  /**
   * Escape attribute value for MDX
   */
  // Escape a string for use inside a double-quoted JSX/MDX attribute.
  // JSX does NOT honor JS-style backslash escapes in attribute strings —
  // the previous implementation produced things like
  //   <Card title="C:\\Users\\foo" />
  // which the MDX parser rejects with "Unexpected character `\` in attribute
  // name" because the lone `\\` looks like a malformed escape. The right
  // approach is HTML-entity encoding: those entities are passed through
  // verbatim by acorn-jsx and decoded back to the original characters when
  // the renderer reads the attribute. Backslashes themselves are safe to
  // leave literal — they only break MDX when paired with quotes.
  private escapeAttr(value: string): string {
    if (typeof value !== 'string') return String(value)
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/[\r\n]+/g, ' ') // attributes are single-line in JSX
  }
}

// Export singleton instance
export const mdxSerializer = new MDXSerializerService()
export { MDXSerializerService }
