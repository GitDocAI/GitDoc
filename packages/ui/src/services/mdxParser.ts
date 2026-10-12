/**
 * MDX Parser Service
 * Converts MDX content to TipTap JSON format
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMdx from 'remark-mdx'
import remarkGfm from 'remark-gfm'
import remarkGemoji from 'remark-gemoji';
import { detectProvider, isVideoProvider } from '../lib/videoProvider'

// MDX AST Node types
interface MdxNode {
  type: string
  value?: string
  children?: MdxNode[]
  depth?: number
  ordered?: boolean
  lang?: string
  meta?: string
  url?: string
  alt?: string
  title?:string
  name?: string
  attributes?: Array<{ type: string; name: string; value: any }>
  data?: any
  checked?: boolean | null
}

interface TipTapNode {
  type: string
  attrs?: Record<string, any>
  content?: TipTapNode[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, any> }>
}

export interface ParseResult {
  doc: any
  parseError?: string
}

class MDXParserService {
  /**
   * Pre-process MDX content to handle problematic patterns
   * that could cause parsing errors
   */
  private preprocessContent(content: string): string {
    const lines = content.split('\n')
    const processed: string[] = []

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]
      if (line === undefined) continue

      // If line is ONLY backslashes (with optional whitespace), skip it entirely
      // This handles orphan backslash lines that break MDX parsing
      if (/^\s*\\+\s*$/.test(line)) {
        continue
      }

      // Recover from a now-fixed bug where mdxSerializer.escapeAttr emitted
      // JS-style escapes inside JSX attribute strings (`title="C:\\Users"` or
      // `title="he said \"hi\""`). MDX/JSX doesn't understand those, so the
      // parser bailed out with "Unexpected character `\` in attribute name".
      // We scan attribute-shaped substrings and replace the legacy escapes
      // with their HTML-entity equivalents (which the new serializer emits).
      line = line.replace(/(\w+)="((?:[^"\\]|\\.)*)"/g, (full, name, value) => {
        if (!value.includes('\\')) return full
        const fixed = value
          .replace(/\\"/g, '&quot;')
          .replace(/\\n/g, ' ')
          .replace(/\\\\/g, '\\')
        return `${name}="${fixed}"`
      })

      // Handle invalid unicode escapes that break acorn (e.g. \u in a windows path or \unique)
      // If we find \u not followed by 4 hex digits, escape the backslash so acorn sees it as a literal backslash + u
      line = line.replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')

      // Handle other common invalid escapes that acorn might choke on in JSX attributes
      // like \x not followed by 2 hex digits
      line = line.replace(/\\x(?![0-9a-fA-F]{2})/g, '\\\\x')

      // Remove trailing backslashes that are used as "soft line breaks"
      // These cause issues in MDX when followed by certain content (headers, components, etc.)
      // Example: "text\" followed by "# Heading" breaks MDX parsing
      if (/\\+\s*$/.test(line)) {
        line = line.replace(/\\+\s*$/, '')
      }

      processed.push(line)
    }

    return processed.join('\n')
  }

  /**
   * Detect legacy entries whose content was persisted as Tiptap JSON
   * (the dashboard used to save `JSON.stringify(editor.getJSON())`
   * before we switched to MDX). When we recognize that shape we just
   * hand the JSON straight to the editor — no MDX parse needed. The
   * next save from the dashboard will rewrite the entry as MDX, so
   * legacy rows self-heal on edit and we don't need an explicit
   * migration script.
   */
  private tryParseTiptapJSON(content: string): ParseResult | null {
    const trimmed = content.trimStart()
    if (!trimmed.startsWith('{')) return null
    try {
      const parsed = JSON.parse(trimmed)
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.type === 'doc' &&
        Array.isArray(parsed.content)
      ) {
        return { doc: parsed }
      }
    } catch {
      // Not JSON — fall through to MDX parsing.
    }
    return null
  }

  /**
   * Parse MDX content to TipTap JSON
   * Returns ParseResult with doc and optional parseError
   */
  /**
   * Synchronous variant. Every remark plugin we use (`remark-parse`,
   * `remark-gfm`, `remark-gemoji`, `remark-mdx`) is pure + sync, so we
   * can skip the microtask that the async `parse()` introduces. Used
   * by the publish viewer via `useMemo` so the parsed Tiptap JSON is
   * available on the very first render — eliminating the layout shift
   * you'd otherwise see while the async parse resolves.
   */
  parseSync(mdxContent: string): ParseResult {
    const legacy = this.tryParseTiptapJSON(mdxContent)
    if (legacy) return legacy
    let processedContent = ''
    try {
      processedContent = this.preprocessContent(mdxContent)
      const processor = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkGemoji)
        .use(remarkMdx)
      const ast = processor.parse(processedContent)
      const result = processor.runSync(ast)
      const tiptapContent = this.convertToTipTap(result as MdxNode)
      return { doc: { type: 'doc', content: tiptapContent } }
    } catch (error) {
      console.error('[MDXParser] Sync parse error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown parsing error'
      return { doc: { type: 'doc', content: [] }, parseError: errorMessage }
    }
  }

  async parse(mdxContent: string): Promise<ParseResult> {
    const legacy = this.tryParseTiptapJSON(mdxContent)
    if (legacy) return legacy
    let processedContent = ''
    try {
      // Pre-process content to handle problematic patterns
      processedContent = this.preprocessContent(mdxContent)

      // Parse MDX to AST
      const processor = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkGemoji)
        .use(remarkMdx)

      const ast = processor.parse(processedContent)

      const result = await processor.run(ast)

      // Convert AST to TipTap JSON
      const tiptapContent = this.convertToTipTap(result as MdxNode)

      return {
        doc: {
          type: 'doc',
          content: tiptapContent
        }
      }
    } catch (error) {
      console.error('[MDXParser] Error parsing MDX:', error)

      // Try to provide more context about where the error occurred
      let errorMessage = error instanceof Error ? error.message : 'Unknown parsing error'

      // remark-mdx errors often have format "line:column: message"
      const match = errorMessage.match(/^(\d+):(\d+):/)
      if (match?.[1] && processedContent) {
        const lineNum = parseInt(match[1])
        const lines = processedContent.split('\n')
        const problematicLine = lines[lineNum - 1]
        if (lineNum <= lines.length && problematicLine !== undefined) {
          console.error(`[MDXParser] Problematic line ${lineNum}: "${problematicLine}"`)
          errorMessage = `Line ${lineNum}: ${errorMessage}`
        }
      }

      return {
        doc: {
          type: 'doc',
          content: []
        },
        parseError: errorMessage
      }
    }
  }

  /**
   * Convert MDX AST to TipTap JSON
   */
  private convertToTipTap(node: MdxNode): TipTapNode[] {
    if (!node.children) {
      return []
    }

    const result: TipTapNode[] = []

    for (const child of node.children) {
      const converted = this.convertNode(child)
      if (converted) {
        if (Array.isArray(converted)) {
          result.push(...converted)
        } else {
          result.push(converted)
        }
      }
    }

    return result
  }

  /**
   * Convert a single MDX node to TipTap node
   */
  private convertNode(node: MdxNode): TipTapNode | TipTapNode[] | null {
    switch (node.type) {
      case 'heading':
        return this.convertHeading(node)

      case 'paragraph':
        return this.convertParagraph(node)

      case 'blockquote':
        return this.convertBlockquote(node)

      case 'list':
        return this.convertList(node)

      case 'listItem':
        return this.convertListItem(node)

      case 'code':
        return this.convertCode(node)

      case 'image':
        return this.convertImage(node)

      case 'thematicBreak':
        return { type: 'horizontalRuleBlock' }

      case 'table':
        return this.convertMarkdownTable(node)

      case 'mdxJsxFlowElement':
      case 'mdxJsxTextElement':
        return this.convertMDXComponent(node)

      default:
        // For unknown types, try to convert children
        if (node.children) {
          return this.convertToTipTap(node)
        }
        return null
    }
  }

  /**
   * Convert heading node
   */
  private convertHeading(node: MdxNode): TipTapNode {
    return {
      type: 'heading',
      attrs: { level: node.depth || 1 },
      content: this.convertInlineContent(node.children || [])
    }
  }

  /**
   * Convert paragraph node
   */
  private convertParagraph(node: MdxNode): TipTapNode | TipTapNode[] {
    // Check if this paragraph contains only an image (or images)
    // Images should be block-level, not inline
    if (node.children && node.children.length > 0) {
      // If paragraph contains only image(s), extract them as block elements
      const hasOnlyImages = node.children.every(child => child.type === 'image')
      if (hasOnlyImages) {
        return node.children.map(child => this.convertImage(child))
      }

      // If paragraph contains mixed content with images, extract images separately
      const hasImages = node.children.some(child => child.type === 'image')
      if (hasImages) {
        const result: TipTapNode[] = []
        let inlineContent: MdxNode[] = []

        for (const child of node.children) {
          if (child.type === 'image') {
            // Flush any accumulated inline content as a paragraph
            if (inlineContent.length > 0) {
              const content = this.convertInlineContent(inlineContent)
              if (content.length > 0) {
                result.push({ type: 'paragraph', content })
              }
              inlineContent = []
            }
            // Add image as block
            result.push(this.convertImage(child))
          } else {
            inlineContent.push(child)
          }
        }

        // Flush remaining inline content
        if (inlineContent.length > 0) {
          const content = this.convertInlineContent(inlineContent)
          if (content.length > 0) {
            result.push({ type: 'paragraph', content })
          }
        }

        return result.length > 0 ? result : { type: 'paragraph' }
      }
    }

    // Regular paragraph without images
    const content = this.convertInlineContent(node.children || [])

    // Skip empty paragraphs
    if (content.length === 0) {
      return { type: 'paragraph' }
    }

    return {
      type: 'paragraph',
      content
    }
  }

  /**
   * Convert blockquote node
   */
  private convertBlockquote(node: MdxNode): TipTapNode {
    const children = node.children || []

    // Check if this is a special info block (e.g., > [!TIP])
    if (children.length > 0) {
      const firstChild = children[0]
      if (firstChild?.type === 'paragraph' && firstChild.children) {
        const firstText = firstChild.children[0]
        if (firstText?.type === 'text' && firstText.value) {
          const match = firstText.value.match(/^\[!(TIP|INFO|WARNING|NOTE|DANGER)\]/)
          if (match && match[1]) {
            const infoType = match[1].toLowerCase()

            // Remove the [!TYPE] marker from the text
            const contentWithoutMarker = firstText.value.replace(/^\[!(?:TIP|INFO|WARNING|NOTE|DANGER)\]\s*/, '')

            // Build content nodes
            const contentNodes: TipTapNode[] = []

            // First paragraph with remaining text
            const modifiedFirstChild: MdxNode = {
              type: firstChild.type,
              children: [
                { ...firstText, type: 'text', value: contentWithoutMarker },
                ...firstChild.children.slice(1)
              ]
            }

            // Convert the first paragraph
            const firstParagraph = this.convertParagraph(modifiedFirstChild)
            if (firstParagraph) {
              if (Array.isArray(firstParagraph)) {
                contentNodes.push(...firstParagraph)
              } else {
                contentNodes.push(firstParagraph)
              }
            }

            // Add rest of the content
            const restOfContent = children.slice(1)
            if (restOfContent.length > 0) {
              for (const child of restOfContent) {
                const converted = this.convertNode(child)
                if (converted) {
                  if (Array.isArray(converted)) {
                    contentNodes.push(...converted)
                  } else {
                    contentNodes.push(converted)
                  }
                }
              }
            }

            return {
              type: 'infoBlock',
              attrs: {
                id: `info-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                type: infoType,
                title: ''
              },
              content: contentNodes.length > 0 ? contentNodes : [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: ' ' }]
                }
              ]
            }
          }
        }
      }
    }

    // Regular blockquote
    return {
      type: 'blockquote',
      content: this.convertToTipTap(node)
    }
  }

  /**
   * Convert list node
   */
  private convertList(node: MdxNode): TipTapNode {
    // Check if this is a task list (remark-gfm adds 'checked' property to list items)
    const isTaskList = node.children?.some((item: MdxNode) => {
      return item.type === 'listItem' && item.checked !== undefined && item.checked !== null
    })

    if (isTaskList) {
      return {
        type: 'taskList',
        content: (node.children || []).map(item => this.convertTaskItem(item))
      }
    }

    const listType = node.ordered ? 'orderedList' : 'bulletList'

    return {
      type: listType,
      content: (node.children || []).map(item => ({
        type: 'listItem',
        content: this.convertToTipTap(item)
      }))
    }
  }

  /**
   * Convert list item node
   */
  private convertListItem(node: MdxNode): TipTapNode {
    return {
      type: 'listItem',
      content: this.convertToTipTap(node)
    }
  }

  /**
   * Convert task list item
   */
  private convertTaskItem(node: MdxNode): TipTapNode {
    // Get checked state from node (remark-gfm provides this)
    const checked = node.checked === true

    // Convert children normally (remark-gfm already removed the checkbox syntax)
    const content = this.convertToTipTap(node)

    return {
      type: 'taskItem',
      attrs: { checked },
      content
    }
  }

  /**
   * Convert code block node
   */
  private convertCode(node: MdxNode): TipTapNode {
    // Handle mermaid code blocks as MermaidBlock
    if (node.lang === 'mermaid') {
      return {
        type: 'mermaidBlock',
        attrs: {
          id: `mermaid-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
          diagram: node.value || 'flowchart TD\n    A[Start] --> B[End]',
          title: ''
        }
      }
    }

    return {
      type: 'codeBlock',
      attrs: {
        language: node.lang || 'plaintext'
      },
      content: node.value ? [{ type: 'text', text: node.value }] : []
    }
  }

  /**
   * Convert image node
   */
  private convertImage(node: MdxNode): TipTapNode {
    return {
      type: 'imageBlock',
      attrs: {
        src: node.url || '',
        alt: node.alt || 'Image',
        caption: node.title||'',
        type: 'url'
      }
    }
  }

  /**
   * Convert MDX component (Card, CodeGroup, Info, CheckList, etc.)
   */
  private convertMDXComponent(node: MdxNode): TipTapNode | TipTapNode[] | null {
    const componentName = node.name
    switch (componentName) {
      case 'img':
          const mdxNode ={
              url:'',
              alt:'',
          }
          node.attributes?.forEach(at=>{
          if(at.name=='src'){
            mdxNode.url=at.value
          }
          if(at.name=='alt'){
            mdxNode.alt=at.value
          }
        })
        return this.convertImage(mdxNode as MdxNode)
      case 'Card':
        return this.convertCardComponent(node)

      case 'CodeGroup':
        return this.convertCodeGroupComponent(node)

      case 'Info':
      case 'Tip':
      case 'Note':
      case 'Warning':
      case 'Danger':
        return this.convertInfoComponent(node)

      case 'Columns':
      case 'ColumnGroup':
        return this.convertColumnsComponent(node)

      case 'Column':
        // Columns are handled by ColumnGroup
        return null

      case 'RightPanel':
        return this.convertRightPanelComponent(node)

      case 'Accordion':
        return this.convertAccordionComponent(node)

      case 'AccordionTab':
        // AccordionTabs are handled by Accordion
        return null

      case 'Tabs':
        return this.convertTabsComponent(node)

      case 'Tab':
        // Tabs are handled by Tabs component
        return null

      case 'Table':
        return this.convertTableComponent(node)

      case 'Endpoint':
        return this.convertEndpointComponent(node)

      case 'Label':
        return this.convertLabelComponent(node)

      case 'Labels':
        return this.convertLabelsComponent(node)

      case 'ParamField':
      case 'Param':
        return this.convertParamFieldComponent(node)

      case 'Response':
        return this.convertResponseComponent(node)

      case 'Steps':
        return this.convertStepsComponent(node)

      case 'Step':
        // Individual Steps are handled by Steps container
        return null

      case 'CheckList':
        return this.convertCheckListComponent(node)

      case 'CheckItem':
        // CheckItems are handled by CheckList
        return null

      case 'Mermaid':
        return this.convertMermaidComponent(node)

      case 'Video':
        return this.convertVideoComponent(node)

      case 'Changelog':
        return this.convertChangelogComponent(node)

      case 'Update':
        // Individual Updates are handled by the Changelog container; a
        // top-level <Update> is still rendered inline so the timeline
        // keeps working even if the outer wrapper is missing.
        return this.convertUpdateComponent(node)

      default:
        console.warn(`[MDXParser] Unknown component: ${componentName}`)
        // Return a fallback paragraph instead of null to prevent page breaking
        return {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: `[Unknown component: ${componentName}]`
            }
          ]
        }
    }
  }

  /**
   * Convert Card component
   */
  private convertCardComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)

    // Convert children to TipTap nodes
    const content = this.convertToTipTap(node)

    return {
      type: 'cardBlock',
      attrs: {
        id: `card-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        title: attrs.title || '',
        icon: attrs.icon || '',
        iconAlign: attrs.iconAlign || 'left',
        href: attrs.href || ''
      },
      content: content.length > 0 ? content : [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: ' ' }]
        }
      ]
    }
  }

  /**
   * Convert CodeGroup component
   */
  private convertCodeGroupComponent(node: MdxNode): TipTapNode {
    const files: Array<{ filename: string; language: string; code: string }> = []

    // Extract code blocks from children
    if (node.children) {
      for (const child of node.children) {
        // Handle <Code> JSX children (legacy format)
        if (child.name === 'Code') {
          const attrs = this.extractAttributes(child)
          const code = this.extractTextContent(child)
          const language = attrs.lang || attrs.language || 'plaintext'

          /* Store filename as empty string when the user didn't
             specify one — fabricating `example.<lang>` made the
             round-trip add filenames that weren't there originally. */
          files.push({
            filename: attrs.filename || '',
            language: language,
            code: code,
          })
        }
        // Handle fenced code blocks (```language filename)
        else if (child.type === 'code') {
          const lang = child.lang || 'plaintext'
          const code = child.value || ''
          // The meta field contains the filename (text after the language)
          const filename = child.meta || ''

          files.push({
            filename: filename,
            language: lang,
            code: code,
          })
        }
      }
    }

    // Ensure at least one file exists
    if (files.length === 0) {
      files.push({
        filename: 'example.js',
        language: 'javascript',
        code: ''
      })
    }

    return {
      type: 'codeGroup',
      attrs: {
        files
      }
    }
  }

  /**
   * Convert Info component
   */
  private convertInfoComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)

    // Determine type from component name if not specified in attrs
    let infoType = attrs.type || 'info'
    if (node.name) {
      const name = node.name.toLowerCase()
      if (['tip', 'info', 'note', 'warning', 'danger'].includes(name)) {
        infoType = name
      }
    }

    // Convert children to TipTap nodes
    const content = this.convertToTipTap(node)

    return {
      type: 'infoBlock',
      attrs: {
        id: `info-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        type: infoType,
        title: attrs.title || ''
      },
      content: content.length > 0 ? content : [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: ' ' }]
        }
      ]
    }
  }

  /**
   * Convert Columns/ColumnGroup component
   */
  private convertColumnsComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)
    const columns: TipTapNode[] = []

    // Extract Column children
    if (node.children) {
      for (const child of node.children) {
        if (child.name === 'Column') {
          const columnContent = this.convertToTipTap(child)

          // Create a column node with its own content
          columns.push({
            type: 'column',
            attrs: {
              width: 'auto'
            },
            content: columnContent.length > 0 ? columnContent : [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: ' ' }]
              }
            ]
          })
        }
      }
    }

    // Ensure at least 1 column exists
    if (columns.length === 0) {
      /* Accept both `cols` (the friendlier author syntax) and
         `columnCount` (the canonical attribute name). */
      const defaultColumnCount = attrs.columnCount || attrs.cols || 2
      for (let i = 0; i < defaultColumnCount; i++) {
        columns.push({
          type: 'column',
          attrs: {
            width: 'auto'
          },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: ' ' }]
            }
          ]
        })
      }
    }

    return {
      type: 'columnsBlock',
      attrs: {
        columnCount: columns.length
      },
      content: columns
    }
  }

  /**
   * Convert RightPanel component
   */
  private convertRightPanelComponent(node: MdxNode): TipTapNode {
    const content = this.convertToTipTap(node)

    return {
      type: 'rightPanel',
      attrs: {
        id: `rightpanel-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
      },
      content
    }
  }

  /**
   * Convert Accordion component
   */
  private convertAccordionComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)
    const tabs: TipTapNode[] = []

    // Extract AccordionTab children
    if (node.children) {
      for (const child of node.children) {
        if (child.name === 'AccordionTab') {
          const tabAttrs = this.extractAttributes(child)
          const tabContent = this.convertToTipTap(child)

          tabs.push({
            type: 'accordionTab',
            attrs: {
              header: tabAttrs.title || 'Accordion Item',
              icon:tabAttrs.icon,
              disabled: false,
              isActive: false
            },
            content: tabContent.length > 0 ? tabContent : [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: ' ' }]
              }
            ]
          })
        }
      }
    }

    return {
      type: 'accordionBlock',
      attrs: {
        id: `accordion-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        multiple: attrs.multiple !== false
      },
      content: tabs.length > 0 ? tabs : [
        {
          type: 'accordionTab',
          attrs: { header: 'Tab 1', disabled: false, isActive: true },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: ' ' }]
            }
          ]
        }
      ]
    }
  }

  /**
   * Convert Tabs component
   */
  private convertTabsComponent(node: MdxNode): TipTapNode {
    const tabs: TipTapNode[] = []

    // Extract Tab children
    if (node.children) {
      for (const child of node.children) {
        if (child.name === 'Tab') {
          const tabAttrs = this.extractAttributes(child)
          const tabContent = this.convertToTipTap(child)

          tabs.push({
            type: 'tabBlock',
            attrs: {
              label: tabAttrs.title || 'Tab',
              icon: tabAttrs.icon || null,
              isActive: false
            },
            content: tabContent.length > 0 ? tabContent : [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: ' ' }]
              }
            ]
          })
        }
      }
    }

    // Ensure at least one tab exists and first tab is active
    if (tabs.length === 0) {
      tabs.push({
        type: 'tabBlock',
        attrs: {
          label: 'Tab 1',
          icon: null,
          isActive: true
        },
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: ' ' }]
          }
        ]
      })
    } else if (tabs.length > 0 && tabs[0]?.attrs) {
      // Set first tab as active
      tabs[0].attrs.isActive = true
    }

    return {
      type: 'tabsBlock',
      attrs: {
        id: `tabs-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        alignment: 'left'
      },
      content: tabs
    }
  }

  /**
   * Convert Table component
   */
  private convertTableComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)

    // Default table data
    let data = [
      ['Column 1', 'Column 2', 'Column 3'],
      ['Data 1-1', 'Data 1-2', 'Data 1-3'],
      ['Data 2-1', 'Data 2-2', 'Data 2-3']
    ]

    // Try to parse data attribute
    if (attrs.data) {
      if (Array.isArray(attrs.data)) {
        data = attrs.data
      } else if (typeof attrs.data === 'string') {
        try {
          data = JSON.parse(attrs.data)
        } catch (_e) {
        }
      } else if (attrs.data && typeof attrs.data === 'object') {
        data = this.evaluateExpression(attrs.data)
      }
    }

    let columns: any[] = []
    let rows: any[] = []

    const hasColumnsConfig = attrs.columns && Array.isArray(attrs.columns)

    if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
      const headers = data[0]

      if (hasColumnsConfig) {
        columns = attrs.columns.map((col: any, index: number) => ({
          id: col.id || `col${index + 1}`,
          label: this.normalizeCell(col.label || headers[index] || `Column ${index + 1}`),
        }))
      } else {
        // Strip the legacy `<sortable>` / `<filterable>` inline tags
        // from header labels if a v1 doc lands here. Sort/filter aren't
        // honored anywhere in v2 — keep the visible label clean.
        headers.forEach((header: string, index: number) => {
          const label = String(header)
            .replace(/<sortable>/g, '')
            .replace(/<filterable>/g, '')
          columns.push({
            id: `col${index + 1}`,
            label: this.normalizeCell(label),
          })
        })
      }

      for (let i = 1; i < data.length; i++) {
        const row = data[i]
        if (Array.isArray(row)) {
          const rowData: any = { id: `row${i}` }
          row.forEach((cell: any, index: number) => {
            rowData[`col${index + 1}`] = this.normalizeCell(cell)
          })
          rows.push(rowData)
        }
      }
    } else {
      columns = (hasColumnsConfig && Array.isArray(attrs.columns))
        ? attrs.columns.map((col: any, index: number) => ({
            id: col.id || `col${index + 1}`,
            label: this.normalizeCell(col.label || `Column ${index + 1}`),
          }))
        : [
            { id: 'col1', label: 'Column 1' },
            { id: 'col2', label: 'Column 2' },
            { id: 'col3', label: 'Column 3' },
          ]
      rows.push(
        { id: 'row1', col1: 'Data 1-1', col2: 'Data 1-2', col3: 'Data 1-3' },
        { id: 'row2', col1: 'Data 2-1', col2: 'Data 2-2', col3: 'Data 2-3' }
      )
    }

    if (!Array.isArray(columns) || columns.length === 0) {
      columns = [
        { id: 'col1', label: 'Column 1' },
        { id: 'col2', label: 'Column 2' },
        { id: 'col3', label: 'Column 3' },
      ]
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      rows = [
        { id: 'row1', col1: 'Data 1-1', col2: 'Data 1-2', col3: 'Data 1-3' },
        { id: 'row2', col1: 'Data 2-1', col2: 'Data 2-2', col3: 'Data 2-3' },
      ]
    }

    return {
      type: 'tableBlock',
      attrs: { columns, rows }
    }
  }

  /**
   * Collapse any newline/tab/CR inside a cell to a single space and
   * trim. Markdown table syntax requires one-line rows — AI-generated
   * MDX sometimes splits inline code onto its own line, which would
   * otherwise round-trip as a broken table.
   */
  private normalizeCell(value: unknown): string {
    return String(value ?? '')
      .replace(/\r\n|\r|\n|\t/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }

  /**
   * Convert markdown table to TableBlock
   */
  private convertMarkdownTable(node: MdxNode): TipTapNode {
    let columns: any[] = []
    let rows: any[] = []

    if (!node.children || node.children.length === 0) {
      return {
        type: 'tableBlock',
        attrs: {
          columns: [{ id: 'col1', label: 'Column 1' }],
          rows: [{ id: 'row1', col1: 'No data' }]
        }
      }
    }

    let headerRow: MdxNode | null = null
    const dataRows: MdxNode[] = []

    // First tableRow is the header, the rest are data
    for (const child of node.children) {
      if (child.type === 'tableRow') {
        if (!headerRow) {
          headerRow = child
        } else {
          dataRows.push(child)
        }
      }
    }

    if (headerRow && headerRow.children) {
      headerRow.children.forEach((cell: MdxNode, index: number) => {
        if (cell.type === 'tableCell') {
          const cellText = this.normalizeCell(this.extractTextContent(cell))
          columns.push({
            id: `col${index + 1}`,
            label: cellText || `Column ${index + 1}`,
          })
        }
      })
    }

    dataRows.forEach((row, rowIndex) => {
      if (row.children) {
        const rowData: any = { id: `row${rowIndex + 1}` }
        row.children.forEach((cell: MdxNode, cellIndex: number) => {
          if (cell.type === 'tableCell') {
            // `extractTextContent` already collapses inline children
            // without separators, but AI-generated MDX sometimes
            // contains a literal newline inside the cell text — see
            // `normalizeCell` for the rationale.
            rowData[`col${cellIndex + 1}`] = this.normalizeCell(this.extractTextContent(cell))
          }
        })
        rows.push(rowData)
      }
    })

    if (!Array.isArray(columns) || columns.length === 0) {
      columns = [{ id: 'col1', label: 'Column 1' }]
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      rows = [{ id: 'row1', col1: 'No data' }]
    }

    return {
      type: 'tableBlock',
      attrs: { columns, rows }
    }
  }

  /**
   * Convert Endpoint component
   */
  private convertEndpointComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)

    return {
      type: 'endpointBlock',
      attrs: {
        id: `endpoint-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        method: attrs.method || 'GET',
        path: attrs.path || '/api/endpoint'
      }
    }
  }

  /**
   * Convert Video component. `provider` is honored when valid; otherwise we
   * detect it from the src so hand-authored `<Video src="https://youtu.be/…" />`
   * still resolves to the right embed.
   */
  private convertVideoComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)
    const src = typeof attrs.src === 'string' ? attrs.src : ''
    const provider = isVideoProvider(attrs.provider) ? attrs.provider : detectProvider(src)

    return {
      type: 'videoBlock',
      attrs: {
        src,
        provider,
        title: typeof attrs.title === 'string' ? attrs.title : ''
      }
    }
  }

  /**
   * Convert Label component (single label)
   */
  private convertLabelComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)
    const label = attrs.label || this.extractTextContent(node) || 'Label'

    const labelItem: Record<string, any> = {
      id: `label-item-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      text: label,
      color: attrs.color || '#3b82f6',
      size: attrs.size || 'md'
    }
    if (attrs.icon) {
      labelItem.icon = attrs.icon
    }

    return {
      type: 'labelBlock',
      attrs: {
        id: `label-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        labels: JSON.stringify([labelItem])
      }
    }
  }

  /**
   * Convert Labels component (multiple labels wrapper)
   * <Labels>
   *   <Label label="First" color="#3b82f6" />
   *   <Label label="Second" color="#10b981" />
   * </Labels>
   */
  private convertLabelsComponent(node: MdxNode): TipTapNode {
    const labels: Array<{ id: string; text: string; color: string; size: string; icon?: string }> = []

    // Extract Label children
    const children = node.children || []
    for (const child of children) {
      if (child.type === 'mdxJsxFlowElement' || child.type === 'mdxJsxTextElement') {
        if (child.name === 'Label') {
          const attrs = this.extractAttributes(child)
          const labelItem: { id: string; text: string; color: string; size: string; icon?: string } = {
            id: `label-item-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            text: attrs.label || this.extractTextContent(child) || 'Label',
            color: attrs.color || '#3b82f6',
            size: attrs.size || 'md'
          }
          if (attrs.icon) {
            labelItem.icon = attrs.icon
          }
          labels.push(labelItem)
        }
      }
    }

    // If no labels found, create one default
    if (labels.length === 0) {
      labels.push({
        id: `label-item-${Date.now()}`,
        text: 'Label',
        color: '#3b82f6',
        size: 'md'
      })
    }

    return {
      type: 'labelBlock',
      attrs: {
        id: `label-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        labels: JSON.stringify(labels)
      }
    }
  }

  /**
   * Convert ParamField component
   * <ParamField path="user_id" type="string" required>
   *   Description of the parameter
   * </ParamField>
   */
  private convertParamFieldComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)
    const description = this.extractTextContent(node) || ''

    return {
      type: 'paramBlock',
      attrs: {
        id: `param-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        path: attrs.path || 'param',
        type: attrs.type || 'string',
        required: attrs.required === true || attrs.required === 'true',
        description: description.trim(),
      }
    }
  }

  /**
   * Convert Response component
   * <Response status="200">
   *   Success response description
   * </Response>
   */
  private convertResponseComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)
    const description = this.extractTextContent(node) || ''

    return {
      type: 'responseBlock',
      attrs: {
        id: `response-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        status: attrs.status?.toString() || '200',
        description: description.trim(),
      }
    }
  }

  /**
   * Convert Steps component
   * <Steps>
   *   <Step title="First Step">Content</Step>
   *   <Step title="Second Step">Content</Step>
   * </Steps>
   */
  private convertStepsComponent(node: MdxNode): TipTapNode {
    const steps: TipTapNode[] = []

    const children = node.children || []
    for (const child of children) {
      if (child.type === 'mdxJsxFlowElement' || child.type === 'mdxJsxTextElement') {
        if (child.name === 'Step') {
          const attrs = this.extractAttributes(child)
          const stepContent = this.convertToTipTap(child)

          steps.push({
            type: 'stepBlock',
            attrs: {
              title: attrs.title || 'Step',
            },
            content: stepContent.length > 0 ? stepContent : [
              { type: 'paragraph', content: [{ type: 'text', text: 'Step content' }] }
            ],
          })
        }
      }
    }

    // If no steps found, create a default one
    if (steps.length === 0) {
      steps.push({
        type: 'stepBlock',
        attrs: { title: 'Step 1' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step content' }] }],
      })
    }

    return {
      type: 'stepsBlock',
      attrs: {
        id: `steps-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      },
      content: steps,
    }
  }

  /**
   * Convert Changelog container. Only `<Update>` children map to
   * `updateBlock`; any non-Update child is dropped so the schema
   * contract (`content: 'updateBlock+'`) always holds.
   */
  private convertChangelogComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)
    const updates: TipTapNode[] = []

    for (const child of node.children || []) {
      if (
        (child.type === 'mdxJsxFlowElement' || child.type === 'mdxJsxTextElement') &&
        child.name === 'Update'
      ) {
        updates.push(this.convertUpdateComponent(child))
      }
    }

    if (updates.length === 0) {
      updates.push({
        type: 'updateBlock',
        attrs: {
          label: '',
          description: '',
          tags: '',
          prerelease: false,
          author: '',
          href: '',
          id: '',
        },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }],
      })
    }

    return {
      type: 'changelogBlock',
      attrs: {
        title: attrs.title?.toString() || '',
        description: attrs.description?.toString() || '',
      },
      content: updates,
    }
  }

  /**
   * Convert Update node into an `updateBlock`. Coerces string attrs and
   * normalizes `prerelease` to a boolean.
   */
  private convertUpdateComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)
    const content = this.convertToTipTap(node)

    const prerelease =
      attrs.prerelease === true ||
      attrs.prerelease === 'true' ||
      attrs.prerelease === ''

    return {
      type: 'updateBlock',
      attrs: {
        label: attrs.label?.toString() || '',
        description: attrs.description?.toString() || '',
        tags: attrs.tags?.toString() || '',
        prerelease,
        author: attrs.author?.toString() || '',
        href: attrs.href?.toString() || '',
        id: attrs.id?.toString() || '',
      },
      content: content.length > 0
        ? content
        : [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }],
    }
  }

  /**
   * Convert Mermaid component
   * <Mermaid title="Optional Title">
   *   flowchart TD
   *     A --> B
   * </Mermaid>
   */
  private convertMermaidComponent(node: MdxNode): TipTapNode {
    const attrs = this.extractAttributes(node)
    const diagram = this.extractTextContent(node).trim()

    return {
      type: 'mermaidBlock',
      attrs: {
        id: `mermaid-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        diagram: diagram || 'flowchart TD\n    A[Start] --> B[End]',
        title: attrs.title || ''
      }
    }
  }

  /**
   * Convert CheckList component to taskList
   * <CheckList>
   *   <CheckItem variant="do">Checked item</CheckItem>
   *   <CheckItem variant="dont">Unchecked item</CheckItem>
   *   <CheckItem>Default unchecked</CheckItem>
   * </CheckList>
   */
  private convertCheckListComponent(node: MdxNode): TipTapNode {
    const taskItems: TipTapNode[] = []

    // Helper function to find CheckItem nodes recursively
    const findCheckItems = (children: MdxNode[]): MdxNode[] => {
      const items: MdxNode[] = []
      for (const child of children) {
        if (child.name === 'CheckItem') {
          items.push(child)
        } else if (child.children) {
          items.push(...findCheckItems(child.children))
        }
      }
      return items
    }

    if (node.children) {
      const checkItems = findCheckItems(node.children)

      for (const checkItem of checkItems) {
        const attrs = this.extractAttributes(checkItem)
        // variant="do" means checked, "dont" or no variant means unchecked
        const checked = attrs.variant === 'do'
        const text = this.extractTextContent(checkItem).trim()

        taskItems.push({
          type: 'taskItem',
          attrs: { checked },
          content: [
            {
              type: 'paragraph',
              content: text ? [{ type: 'text', text }] : []
            }
          ]
        })
      }
    }

    // Ensure at least one item exists
    if (taskItems.length === 0) {
      taskItems.push({
        type: 'taskItem',
        attrs: { checked: false },
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: ' ' }]
          }
        ]
      })
    }

    return {
      type: 'taskList',
      content: taskItems
    }
  }

  /**
   * Extract attributes from MDX component node
   */
  private extractAttributes(node: MdxNode): Record<string, any> {
    const attrs: Record<string, any> = {}

    if (node.attributes) {
      for (const attr of node.attributes) {
        if (attr.name) {
          // Handle different attribute value types
          if (attr.value && typeof attr.value === 'object') {
            // Check for literal value
            if ('value' in attr.value) {
              attrs[attr.name] = attr.value.value
            }
            // Check for JSX expression with data (arrays/objects)
            else if ('data' in attr.value && attr.value.data) {
              try {
                // Try to evaluate the expression
                // For arrays like [{...}, {...}], data contains the estree
                attrs[attr.name] = this.evaluateExpression(attr.value.data)
              } catch (e) {
                console.warn(`[MDXParser] Failed to evaluate expression for ${attr.name}:`, e)
                attrs[attr.name] = attr.value
              }
            }
            else {
              attrs[attr.name] = attr.value
            }
          } else {
            attrs[attr.name] = attr.value || true
          }
        }
      }
    }

    return attrs
  }

  /**
   * Evaluate MDX expression (estree format) to get actual value
   */
  private evaluateExpression(data: any): any {
    // Handle array expressions
    if (data.type === 'ArrayExpression' && data.elements) {
      return data.elements.map((elem: any) => this.evaluateExpression(elem))
    }

    // Handle object expressions
    if (data.type === 'ObjectExpression' && data.properties) {
      const obj: any = {}
      for (const prop of data.properties) {
        if (prop.key && prop.value) {
          const key = prop.key.value || prop.key.name
          obj[key] = this.evaluateExpression(prop.value)
        }
      }
      return obj
    }

    // Handle literal values
    if (data.type === 'Literal') {
      return data.value
    }

    // Handle boolean values
    if (data.type === 'BooleanLiteral') {
      return data.value
    }

    // Default: return as-is
    return data
  }

  /**
   * Extract text content from node
   */
  private extractTextContent(node: MdxNode): string {
    /* Inline code at top level keeps its backticks — the previous
       version returned the raw value, which silently stripped `…`
       from any attribute value that traveled through a paragraph
       wrapper (Param description, Response description, etc.). */
    if (node.type === 'inlineCode' && node.value) {
      return `\`${node.value}\``
    }

    /* MDX JSX-expression nodes like `{Generate}` inside <Mermaid> —
       mdast represents them as mdxFlowExpression/mdxTextExpression
       with the JS source in `node.value`. Wrapping back in braces
       preserves the visual text the user typed; without this the
       text disappears (parser evaluates `Generate` as undefined and
       returns empty). */
    if (
      (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') &&
      typeof node.value === 'string'
    ) {
      return `{${node.value}}`
    }

    if (node.value) {
      return node.value
    }

    if (node.children) {
      return node.children
        .map(child => {
          // Handle paragraph nodes — inline children join without separator
          if (child.type === 'paragraph' && child.children) {
            return child.children.map(c => this.extractTextContent(c)).join('')
          }
          // Handle text nodes
          if (child.type === 'text' && child.value) {
            return child.value
          }
          // Handle inline code
          if (child.type === 'inlineCode' && child.value) {
            return `\`${child.value}\``
          }
          // Handle emphasis (italic)
          if (child.type === 'emphasis' && child.children) {
            return `*${child.children.map(c => this.extractTextContent(c)).join('')}*`
          }
          // Handle strong (bold)
          if (child.type === 'strong' && child.children) {
            return `**${child.children.map(c => this.extractTextContent(c)).join('')}**`
          }
          // Handle links
          if (child.type === 'link' && child.children) {
            const url = child.url || ''
            const text = child.children.map(c => this.extractTextContent(c)).join('')
            return `[${text}](${url})`
          }
          // Recurse for other types
          return this.extractTextContent(child)
        })
        .join('')
    }

    return ''
  }

  /**
   * Convert inline content (text, emphasis, strong, links, etc.)
   */
  private convertInlineContent(nodes: MdxNode[], marks: Array<{ type: string; attrs?: Record<string, any> }> = []): TipTapNode[] {
    const result: TipTapNode[] = []

    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          // Split text by newlines and create hardBreak nodes
          if (node.value) {
            const lines = node.value.split('\n')
            lines.forEach((line, index) => {
              // Only create text nodes with actual content (TipTap doesn't allow empty text nodes)
              if (line) {
                result.push({
                  type: 'text',
                  text: line,
                  ...(marks.length > 0 ? { marks } : {})
                })
              }
              if (index < lines.length - 1) {
                result.push({ type: 'hardBreak' })
              }
            })
          }
          break

        case 'strong':
          if (node.children) {
            const childMarks = [...marks, { type: 'bold' }]
            result.push(...this.convertInlineContent(node.children, childMarks))
          }
          break

        case 'emphasis':
          if (node.children) {
            const childMarks = [...marks, { type: 'italic' }]
            result.push(...this.convertInlineContent(node.children, childMarks))
          }
          break

        case 'delete':
          if (node.children) {
            const childMarks = [...marks, { type: 'strike' }]
            result.push(...this.convertInlineContent(node.children, childMarks))
          }
          break

        case 'mdxJsxTextElement':
          // Handle MDX JSX elements like <u>
          if (node.name === 'u' && node.children) {
            const childMarks = [...marks, { type: 'underline' }]
            result.push(...this.convertInlineContent(node.children, childMarks))
          } else {
            // Other JSX elements, convert children normally
            if (node.children) {
              result.push(...this.convertInlineContent(node.children, marks))
            }
          }
          break

        case 'html':
          // Keep HTML nodes in result for post-processing
          if (node.value) {
            result.push({ type: 'text', text: node.value })
          }
          break

        case 'inlineCode':
          if (node.value) {
            result.push({
              type: 'text',
              text: node.value,
              marks: [...marks, { type: 'code' }]
            })
          }
          break

        case 'link':
          if (node.children) {
            const childMarks = [...marks, { type: 'link', attrs: { href: node.url || '', target: '_self' } }]
            result.push(...this.convertInlineContent(node.children, childMarks))
          }
          break

        case 'break':
          result.push({ type: 'hardBreak' })
          break

        default:
          // Try to extract text content for unknown inline types
          if (node.children) {
            result.push(...this.convertInlineContent(node.children, marks))
          } else if (node.value) {
            result.push({
              type: 'text',
              text: node.value,
              ...(marks.length > 0 ? { marks } : {})
            })
          }
      }
    }

    // Post-process to handle <u> tags (for non-MDX HTML)
    const processed: TipTapNode[] = []
    let i = 0

    while (i < result.length) {
      const current = result[i]
      if (!current) {
        i++
        continue
      }

      // Look for pattern: text(<u>) -> text -> text(</u>)
      const next1 = result[i + 1]
      const next2 = result[i + 2]
      if (i + 2 < result.length &&
          current.type === 'text' && current.text === '<u>' &&
          next1?.type === 'text' &&
          next2?.type === 'text' && next2?.text === '</u>') {
        // Create underlined text node
        if (next1.text) {
          processed.push({
            type: 'text',
            text: next1.text,
            marks: next1.marks ? [...next1.marks, { type: 'underline' }] : [{ type: 'underline' }]
          })
        }
        i += 3
      } else if (current.type !== 'text' || (current.text !== '<u>' && current.text !== '</u>')) {
        // Only add nodes that are not orphan <u> or </u> tags
        processed.push(current)
        i++
      } else {
        i++
      }
    }

    // Final safety filter: remove any empty text nodes (TipTap doesn't allow them)
    return processed.filter(node => {
      if (node.type === 'text') {
        return node.text && node.text.length > 0
      }
      return true
    })
  }
}

// Export both the class and singleton instance
export { MDXParserService }
export const mdxParser = new MDXParserService()
