/**
 * Tiptap JSON → React tree → HTML renderer.
 *
 * Single source of truth for the "static" rendering of doc content:
 *   - publish-web static builds call `renderTiptapToHtml()` at
 *     build time to produce the entry's HTML
 *   - render-cli (when migrated) will do the same in the publish job
 *
 * For each custom node type, we delegate to the matching *Presenter*
 * component in `components/editor/node-views/presenters/`. Presenters
 * are pure JSX (no Tiptap deps, no `useEffect`, no DOM lookups) so
 * they render correctly under `renderToStaticMarkup`. NodeViews wrap
 * the same presenters in edit mode, so editor and static output share
 * one visual definition.
 *
 * Standard markdown nodes (paragraph, heading, lists, etc.) and inline
 * marks (bold, italic, code, link) are mapped to plain HTML tags
 * directly here — they don't need presenters.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CardPresenter } from '../components/editor/node-views/presenters/CardPresenter'
import { CalloutPresenter } from '../components/editor/node-views/presenters/CalloutPresenter'
import { ImagePresenter } from '../components/editor/node-views/presenters/ImagePresenter'
import { VideoPresenter } from '../components/editor/node-views/presenters/VideoPresenter'
import { isVideoProvider } from './videoProvider'
import { IconRenderer } from '../components/common/IconPicker'
import { renderInlineMarkdown } from './inlineMarkdown'
import { LanguageDot, languageLabel } from '../components/editor/lib/languageMeta'

export interface TiptapNode {
  type: string
  attrs?: Record<string, any>
  content?: TiptapNode[]
  marks?: Array<{ type: string; attrs?: Record<string, any> }>
  text?: string
}

export interface TiptapDoc {
  type: 'doc'
  content?: TiptapNode[]
}

export interface RenderOptions {
  /** Asset id → natural width/height map. When set, the image renderer
   *  emits explicit `width`/`height` attrs so the browser reserves
   *  layout box and the page doesn't shift when bytes arrive.
   *  Computed once at build time (image-size) by the SSG caller. */
  assetDimensions?: Map<string, { width: number; height: number }>
  /** Optional URL rewriter applied to every asset src/href. The SSG
   *  uses this to add the original extension to bare `/assets/<uuid>`
   *  URLs so SVG/PNG/etc. are served with the right Content-Type. */
  resolveAssetUrl?: (url: string) => string
}

interface Ctx {
  /** Used to generate stable React keys so renderToStaticMarkup doesn't
   *  warn. Tiptap nodes don't carry ids in the JSON, so we count. */
  counter: { n: number }
  options: RenderOptions
}

function key(ctx: Ctx): string {
  return `n${ctx.counter.n++}`
}

/** Render an array of nodes to a React fragment with stable keys. */
function renderChildren(
  nodes: TiptapNode[] | undefined,
  ctx: Ctx,
): React.ReactNode {
  if (!nodes || nodes.length === 0) return null
  return nodes.map((n) => renderNode(n, ctx))
}

/** Wrap inline content (text run) with the marks declared on that run. */
function withMarks(
  marks: TiptapNode['marks'],
  text: string,
  k: string,
): React.ReactNode {
  let el: React.ReactNode = text
  if (!marks || marks.length === 0) return <React.Fragment key={k}>{el}</React.Fragment>
  for (const m of marks) {
    switch (m.type) {
      case 'bold':
        el = <strong key={k}>{el}</strong>
        break
      case 'italic':
        el = <em key={k}>{el}</em>
        break
      case 'underline':
        el = <u key={k}>{el}</u>
        break
      case 'strike':
      case 'strikethrough':
        el = <s key={k}>{el}</s>
        break
      case 'code':
        el = <code key={k}>{el}</code>
        break
      case 'link': {
        const href = (m.attrs?.href as string | undefined) ?? '#'
        const target = (m.attrs?.target as string | undefined) ?? undefined
        const rel = target === '_blank' ? 'noopener noreferrer' : undefined
        el = (
          <a key={k} href={href} target={target} rel={rel}>
            {el}
          </a>
        )
        break
      }
      default:
        // Unknown mark — leave the text untouched.
        break
    }
  }
  return el
}

function renderNode(node: TiptapNode, ctx: Ctx): React.ReactNode {
  const k = key(ctx)
  switch (node.type) {
    // -----------------------------------------------------------------
    // Inline / text
    // -----------------------------------------------------------------
    case 'text':
      return withMarks(node.marks, node.text ?? '', k)
    case 'hardBreak':
      return <br key={k} />

    // -----------------------------------------------------------------
    // Standard block markdown nodes
    // -----------------------------------------------------------------
    case 'paragraph':
      return <p key={k}>{renderChildren(node.content, ctx)}</p>
    case 'heading': {
      const level = Math.min(Math.max(node.attrs?.level ?? 2, 1), 6)
      const children = renderChildren(node.content, ctx)
      switch (level) {
        case 1: return <h1 key={k}>{children}</h1>
        case 2: return <h2 key={k}>{children}</h2>
        case 3: return <h3 key={k}>{children}</h3>
        case 4: return <h4 key={k}>{children}</h4>
        case 5: return <h5 key={k}>{children}</h5>
        default: return <h6 key={k}>{children}</h6>
      }
    }
    case 'blockquote':
      return <blockquote key={k}>{renderChildren(node.content, ctx)}</blockquote>
    case 'bulletList':
      return <ul key={k}>{renderChildren(node.content, ctx)}</ul>
    case 'orderedList': {
      const start = node.attrs?.start as number | undefined
      return (
        <ol key={k} start={start}>
          {renderChildren(node.content, ctx)}
        </ol>
      )
    }
    case 'listItem':
      return <li key={k}>{renderChildren(node.content, ctx)}</li>
    case 'horizontalRule':
    case 'horizontalRuleBlock':
      return <hr key={k} />

    case 'codeBlock': {
      const lang = node.attrs?.language as string | undefined
      const text =
        node.content
          ?.map((c) => (c.type === 'text' ? c.text ?? '' : ''))
          .join('') ?? ''
      /* Shiki HTML is precomputed at build time in `staticContent.ts`
         (`precomputeHighlights`). When present we use it and wrap in
         a shell that hosts the copy button. Fallback: plain pre/code. */
      const highlighted = node.attrs?.highlightedHtml as string | undefined
      if (highlighted) {
        return (
          <div key={k} className="code-block-shell" data-code-block="">
            <button
              type="button"
              className="code-block__copy"
              data-code-copy
              aria-label="Copy code"
              title="Copy"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="code-block__copy-icon"
              >
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              </svg>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="code-block__check-icon"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </button>
            <div dangerouslySetInnerHTML={{ __html: highlighted }} />
          </div>
        )
      }
      return (
        <div key={k} className="code-block-shell" data-code-block="">
          <button
            type="button"
            className="code-block__copy"
            data-code-copy
            aria-label="Copy code"
            title="Copy"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="code-block__copy-icon">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="code-block__check-icon">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </button>
          <pre>
            <code className={lang ? `language-${lang}` : undefined}>{text}</code>
          </pre>
        </div>
      )
    }

    case 'mermaidBlock': {
      /* `<pre class="mermaid">` is Mermaid's documented auto-render
         hook — the client-side island calls `mermaid.run()` which
         scans the DOM for this exact selector and swaps each block
         with the rendered SVG. Until the script lands the raw
         diagram source is visible (graceful no-JS fallback). */
      const diagram = String(node.attrs?.diagram ?? '')
      const title = node.attrs?.title as string | undefined
      return (
        <figure key={k} className="mermaid-block">
          <pre className="mermaid">{diagram}</pre>
          {title ? <figcaption>{title}</figcaption> : null}
        </figure>
      )
    }

    case 'accordionBlock': {
      /* `<Accordion>` → `<div class="accordion">` with one
         `<details>` per `accordionTab` child. Native <details>
         gives us the expand/collapse interaction without JS — open
         tabs ship with the `open` attr from the parser's
         `isActive` flag.
         The dashboard's `multiple={false}` mode (only one open at
         a time) needs JS; we don't ship that for the static SSG,
         so multiple tabs may be open simultaneously. */
      const tabs = (node.content ?? []).filter(
        (c) => c.type === 'accordionTab',
      )
      return (
        <div key={k} className="accordion">
          {tabs.map((tab, i) => {
            const header = String(tab.attrs?.header ?? `Tab ${i + 1}`)
            const icon = tab.attrs?.icon as string | undefined
            const isOpen = tab.attrs?.isActive === true
            return (
              <details
                key={i}
                className="accordion__tab"
                {...(isOpen ? { open: true } : {})}
              >
                <summary className="accordion__header">
                  {icon ? (
                    <span className="accordion__icon" aria-hidden="true">
                      {/* IconRenderer handles every prefix: `pi pi-…`,
                          `fa fa-…`, `mi-…` (Material Icons via font
                          ligature → <span class="material-icons">),
                          `hi-…-solid/outline` and bare Lucide names.
                          NB: no `width`/`height` here — FA glyphs are
                          wider than 1em and an explicit em-sized box
                          clips them to a tofu square. The wrapping
                          `.accordion__icon` (36×36 flex) handles
                          layout; the `<i>` auto-sizes to the glyph. */}
                      <IconRenderer
                        iconKey={icon}
                        style={{ fontSize: '1.1rem' }}
                      />
                    </span>
                  ) : null}
                  <span className="accordion__title">{header}</span>
                  <svg
                    className="accordion__chevron"
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </summary>
                <div className="accordion__body">
                  {renderChildren(tab.content, ctx)}
                </div>
              </details>
            )
          })}
        </div>
      )
    }

    case 'stepsBlock': {
      /* mdxParser wraps every <Step> child as `stepBlock` inside a
         `stepsBlock` container. Render as a semantic <ol>, but
         materialise the step number + connector line in the walker
         (we know the index here) so the SSG ships ready-made HTML
         and we don't need CSS counters or client-side numbering. */
      const children = (node.content ?? []).filter(
        (c) => c.type === 'stepBlock',
      )
      const total = children.length
      return (
        <ol key={k} className="steps">
          {children.map((step, i) => {
            const title = String(step.attrs?.title ?? `Step ${i + 1}`)
            const isLast = i === total - 1
            return (
              <li key={i} className="step">
                <div className="step__gutter">
                  <div className="step__number">{i + 1}</div>
                  {!isLast && <div className="step__line" aria-hidden="true" />}
                </div>
                <div className="step__body">
                  <h4 className="step__title">{title}</h4>
                  <div className="step__content">
                    {renderChildren(step.content, ctx)}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )
    }

    case 'stepBlock': {
      /* Defensive fallback for the (parser-discouraged) case of a
         bare stepBlock without a stepsBlock parent. Render as a
         minimal block so the title isn't lost. */
      const title = String(node.attrs?.title ?? 'Step')
      return (
        <div key={k} className="step step--orphan">
          <div className="step__body">
            <h4 className="step__title">{title}</h4>
            <div className="step__content">{renderChildren(node.content, ctx)}</div>
          </div>
        </div>
      )
    }

    case 'tableBlock': {
      /* Static rendering of mdxParser's tableBlock. The dashboard
         renders this with a PrimeReact DataTable for sort/filter/
         paginate, but for SEO/no-JS we emit a plain semantic
         <table>. Wrapping in a horizontally-scrollable container
         keeps wide tables from breaking the article column on
         narrow viewports. */
      const columns = (node.attrs?.columns ?? []) as Array<{
        id: string
        label?: string
      }>
      const rows = (node.attrs?.rows ?? []) as Array<Record<string, unknown>>
      if (columns.length === 0) return null
      /* Inline markdown inside cells (backticks, **bold**, *italic*,
         links) goes through the same `renderInlineMarkdown` the editor
         uses, so the SSG output matches the dashboard preview exactly.
         `dangerouslySetInnerHTML` is safe here because the util escapes
         HTML first before applying the markdown substitutions. */
      return (
        <div key={k} className="table-block">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.id}
                    dangerouslySetInnerHTML={{
                      __html: renderInlineMarkdown(c.label ?? c.id),
                    }}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={String(row.id ?? i)}>
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      dangerouslySetInnerHTML={{
                        __html: renderInlineMarkdown(
                          row[c.id] != null ? String(row[c.id]) : '',
                        ),
                      }}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    // -----------------------------------------------------------------
    // Custom blocks → presenters
    // -----------------------------------------------------------------
    case 'cardBlock':
      return (
        <CardPresenter
          key={k}
          title={node.attrs?.title ?? ''}
          icon={node.attrs?.icon}
          iconAlign={node.attrs?.iconAlign}
          href={node.attrs?.href}
        >
          {renderChildren(node.content, ctx)}
        </CardPresenter>
      )

    case 'imageBlock': {
      const rawSrc = String(node.attrs?.src ?? '')
      let width: number | undefined = node.attrs?.width
      let height: number | undefined = node.attrs?.height
      /* If the caller provided dimensions for our asset library, use
         them — the browser reserves layout box, eliminating CLS when
         the bytes arrive. Asset paths look like `/assets/<uuid>`. */
      if ((!width || !height) && ctx.options.assetDimensions) {
        const m = rawSrc.match(/\/assets\/([^/?#]+)/)
        if (m && m[1]) {
          const dims = ctx.options.assetDimensions.get(m[1])
          if (dims) {
            width = dims.width
            height = dims.height
          }
        }
      }
      /* Rewrite the URL so SVGs (and other extension-typed assets)
         get the right Content-Type from the static host. */
      const src = ctx.options.resolveAssetUrl ? ctx.options.resolveAssetUrl(rawSrc) : rawSrc
      return (
        <ImagePresenter
          key={k}
          src={src}
          alt={node.attrs?.alt}
          caption={node.attrs?.caption}
          width={width}
          height={height}
        />
      )
    }

    case 'videoBlock': {
      const provider = isVideoProvider(node.attrs?.provider) ? node.attrs!.provider : 'youtube'
      const rawSrc = String(node.attrs?.src ?? '')
      /* Self-hosted files live in the asset store; rewrite the bare
         `/assets/<uuid>` path the same way images do so the host serves
         the right Content-Type. Embed URLs are passed through untouched. */
      const src =
        provider === 'file' && ctx.options.resolveAssetUrl
          ? ctx.options.resolveAssetUrl(rawSrc)
          : rawSrc
      return (
        <VideoPresenter key={k} src={src} provider={provider} title={node.attrs?.title} />
      )
    }

    case 'infoBlock': {
      /* mdxParser collapses every callout flavor (`<Info>`, `<Tip>`,
         `<Note>`, `<Warning>`, `<Danger>`, and the GFM `> [!TIP]`
         shorthands) into a single `infoBlock` node whose `attrs.type`
         carries the actual variant. Reading from `node.type` would
         always yield `info` and lose the styling distinction. */
      const raw = String(node.attrs?.type ?? 'info').toLowerCase()
      const variant = (
        ['info', 'tip', 'note', 'warning', 'danger'].includes(raw) ? raw : 'info'
      ) as 'info' | 'tip' | 'note' | 'warning' | 'danger'
      return (
        <CalloutPresenter key={k} variant={variant}>
          {renderChildren(node.content, ctx)}
        </CalloutPresenter>
      )
    }

    case 'tabsBlock': {
      /* `<Tabs>` — visual match to `TabsNodeView` in the dashboard.
         Headers strip with accent underline on the active tab; only
         the active tab's body renders visible. The `tabs.js` static
         script (loaded from BaseLayout) wires click → switch active.
         Without JS the first tab is shown, which is the same
         fall-back the dashboard's read-only preview uses. */
      const tabs = (node.content ?? []).filter((c) => c.type === 'tabBlock')
      if (tabs.length === 0) return null
      const alignment = String(node.attrs?.alignment ?? 'left')
      const justify =
        alignment === 'center' ? 'center' : alignment === 'right' ? 'flex-end' : 'flex-start'
      const initialActive = Math.max(
        0,
        tabs.findIndex((t) => t.attrs?.isActive === true),
      )
      return (
        <div
          key={k}
          className="tabs-block"
          data-tabs-block=""
        >
          <div
            className="tabs-block__headers"
            style={{ justifyContent: justify }}
          >
            {tabs.map((tab, i) => {
              const label = String(tab.attrs?.label ?? `Tab ${i + 1}`)
              const icon = tab.attrs?.icon as string | undefined
              const isActive = i === initialActive
              return (
                <button
                  key={i}
                  type="button"
                  className={`tabs-block__header${isActive ? ' is-active' : ''}`}
                  data-tab-index={String(i)}
                >
                  {icon ? (
                    <span className="tabs-block__icon" aria-hidden="true">
                      <IconRenderer iconKey={icon} style={{ fontSize: '14px' }} />
                    </span>
                  ) : null}
                  <span>{label}</span>
                  <span className="tabs-block__indicator" aria-hidden="true" />
                </button>
              )
            })}
          </div>
          {tabs.map((tab, i) => {
            const isActive = i === initialActive
            return (
              <div
                key={i}
                className="tabs-block__body"
                data-tab-body={String(i)}
                style={isActive ? undefined : { display: 'none' }}
              >
                {renderChildren(tab.content, ctx)}
              </div>
            )
          })}
        </div>
      )
    }

    case 'tabBlock': {
      /* Orphan `tabBlock` outside a `tabsBlock` — keep the content
         visible by rendering just the body, no chrome. */
      return <div key={k}>{renderChildren(node.content, ctx)}</div>
    }

    case 'columnsBlock': {
      /* `<ColumnGroup>`/`<Columns>` → CSS grid. The column count
         comes from the parser's `columnCount` attr (defaults to the
         length of the column children). */
      const cols = (node.content ?? []).filter((c) => c.type === 'column')
      const count = Number(node.attrs?.columnCount ?? cols.length) || cols.length || 1

      /* Special-case: every column holds ONLY cards, and all columns have the
         same number of cards. Lay the cards out as a single grid in
         column-major order (`grid-auto-flow: column`) so they line up
         row-by-row across columns, and the grid stretches the cards in each
         row to a shared height. Anything else (mixed content, uneven counts)
         keeps the simple per-column stack, where each `.column` flex-stacks
         its blocks with a gap (see publish-content.css). */
      const colItems = cols.map((col) => (col.content ?? []).filter((c) => c && c.type))
      const cardsOnly =
        cols.length > 1 &&
        colItems.every((items) => items.length > 0 && items.every((c) => c.type === 'cardBlock'))
      const firstColCount = colItems[0]?.length ?? 0
      const equalCounts =
        colItems.length > 0 && colItems.every((items) => items.length === firstColCount)

      if (cardsOnly && equalCounts) {
        const rows = firstColCount
        return (
          <div
            key={k}
            className="columns-block columns-block--cards"
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rows}, auto)`,
              gridAutoFlow: 'column',
              gap: '1.5rem',
            }}
          >
            {colItems.flatMap((items) => items.map((card) => renderNode(card, ctx)))}
          </div>
        )
      }

      return (
        <div
          key={k}
          className="columns-block"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
            gap: '1.5rem',
          }}
        >
          {cols.map((col, i) => (
            <div key={i} className="column">
              {renderChildren(col.content, ctx)}
            </div>
          ))}
        </div>
      )
    }

    case 'column': {
      // Orphan column — render its content plain.
      return <div key={k}>{renderChildren(node.content, ctx)}</div>
    }

    case 'rightPanel': {
      /* `<RightPanel>` — emits a tagged aside that the SSG layout
         extracts post-render and shows in the right rail (replacing
         the TOC). Inline positioning is deliberately absent so the
         host can decide where this lands — see
         `extractRightPanels()` in `publish-web/src/lib/
         staticContent.ts` and the right-column swap in
         `pages/[...all].astro`. */
      return (
        <aside key={k} className="right-panel" data-right-panel="">
          {renderChildren(node.content, ctx)}
        </aside>
      )
    }

    case 'codeGroup': {
      /* `<CodeGroup>` — multiple code samples in different langs.
         Renders as a Tabs-style block: header strip with file
         labels, only the active body visible. Bodies use the same
         shiki HTML + copy button as standalone codeBlocks. Wired
         by /tabs.js (the same script that powers regular tabs). */
      const files = (node.attrs?.files ?? []) as Array<{
        filename?: string
        language?: string
        code?: string
        highlightedHtml?: string
      }>
      if (files.length === 0) return null
      /* Detect when multiple files share the same language without
         a filename — that produces useless duplicate tab labels
         like `bash`/`bash`/`bash`. In that case, peek at the first
         identifier-ish token of each code block (`npm`, `pnpm`,
         `yarn`) to give the tabs a distinct, scannable label. */
      /* Older versions of the MDX parser fabricated `example.<lang>`
         as a fallback filename. Those got persisted, so today's
         content arrives with `example.javascript` / `example.bash`
         on every tab. Treat anything matching `example.<lang>` (or
         the legacy `example.js`) as no filename. */
      const isPlaceholderFilename = (filename: string, lang: string): boolean => {
        if (!filename) return false
        const lower = filename.toLowerCase()
        if (lower === 'example.js') return true
        return lower === `example.${lang.toLowerCase()}`
      }
      const effectiveFilename = (f: { filename?: string; language?: string }): string => {
        const fn = f.filename ?? ''
        const lang = f.language || 'plaintext'
        return isPlaceholderFilename(fn, lang) ? '' : fn
      }
      const langCounts = new Map<string, number>()
      for (const f of files) {
        if (!effectiveFilename(f)) {
          const l = (f.language || 'plaintext').toLowerCase()
          langCounts.set(l, (langCounts.get(l) ?? 0) + 1)
        }
      }
      const firstCommandToken = (code: string): string => {
        const lines = (code || '').split('\n').map((l) => l.trim())
        const first = lines.find(
          (l) => l && !l.startsWith('#') && !l.startsWith('//') && !l.startsWith('/*'),
        )
        if (!first) return ''
        const token = first.split(/\s+/)[0] ?? ''
        return /^[\w@.\-]+$/.test(token) ? token : ''
      }
      return (
        <div key={k} className="tabs-block code-group-block" data-tabs-block="">
          <div className="tabs-block__headers">
            {files.map((f, i) => {
              /* Label preference:
                   1. explicit filename
                   2. first command token IF this language is repeated
                      (so 3× bash → "npm" / "pnpm" / "yarn")
                   3. friendly language label (`bash` → `bash`)
                   4. positional fallback */
              const lang = f.language || 'plaintext'
              const fn = effectiveFilename(f)
              const duplicate = !fn && (langCounts.get(lang.toLowerCase()) ?? 0) > 1
              const fromCode = duplicate ? firstCommandToken(f.code ?? '') : ''
              const label =
                fn || fromCode || languageLabel(lang) || `Example ${i + 1}`
              const isActive = i === 0
              return (
                <button
                  key={i}
                  type="button"
                  className={`tabs-block__header${isActive ? ' is-active' : ''}`}
                  data-tab-index={String(i)}
                >
                  <LanguageDot lang={lang} />
                  <span>{label}</span>
                  <span className="tabs-block__indicator" aria-hidden="true" />
                </button>
              )
            })}
          </div>
          {files.map((f, i) => {
            const isActive = i === 0
            return (
              <div
                key={i}
                className="tabs-block__body"
                data-tab-body={String(i)}
                style={isActive ? undefined : { display: 'none' }}
              >
                <div className="code-block-shell" data-code-block="">
                  <button
                    type="button"
                    className="code-block__copy"
                    data-code-copy
                    aria-label="Copy code"
                    title="Copy"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="code-block__copy-icon">
                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                    </svg>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="code-block__check-icon">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </button>
                  {f.highlightedHtml ? (
                    <div dangerouslySetInnerHTML={{ __html: f.highlightedHtml }} />
                  ) : (
                    <pre>
                      <code className={f.language ? `language-${f.language}` : undefined}>
                        {f.code ?? ''}
                      </code>
                    </pre>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )
    }

    case 'endpointBlock': {
      /* Mirrors `packages/ui/src/components/Endpoint.tsx`: a card
         (border + subtle bg) with a colored method pill (tinted bg
         + tinted border + colored text — NOT solid color fill), a
         path inset box (mono), and a copy button. Color scheme:
         GET=green, POST=blue, PUT=amber, PATCH=violet, DELETE=red. */
      const method = String(node.attrs?.method ?? 'GET').toUpperCase()
      const path = String(node.attrs?.path ?? '/')
      const methodColors: Record<string, string> = {
        GET: '#10b981',
        POST: '#3b82f6',
        PUT: '#f59e0b',
        PATCH: '#8b5cf6',
        DELETE: '#ef4444',
      }
      const c = methodColors[method] ?? '#6b7280'
      return (
        <div
          key={k}
          className="endpoint-block"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '0.75rem',
            border: '1px solid var(--chrome-border)',
            borderRadius: 'var(--radius-xl)',
            background: 'color-mix(in srgb, var(--foreground) 2%, transparent)',
            margin: '1em 0',
          }}
        >
          <span
            style={{
              padding: '0.3rem 0.6rem',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.7rem',
              fontWeight: 600,
              fontFamily: 'inherit',
              letterSpacing: '0.02em',
              flexShrink: 0,
              backgroundColor: `color-mix(in srgb, ${c} 12%, transparent)`,
              border: `1px solid color-mix(in srgb, ${c} 22%, transparent)`,
              color: c,
            }}
          >
            {method}
          </span>
          <div
            style={{
              flex: 1,
              padding: '0.5rem 0.75rem',
              borderRadius: 'var(--radius-lg)',
              background: 'color-mix(in srgb, var(--foreground) 3%, transparent)',
              border: '1px solid var(--chrome-border)',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: '0.8rem',
              color: 'var(--foreground)',
            }}
          >
            {path}
          </div>
        </div>
      )
    }

    case 'paramBlock': {
      /* Mirrors `packages/ui/src/components/ParamField.tsx`: blue
         mono path + type pill (subtle gray bg+border, mono) +
         optional required pill (red bg+border) + description below
         + bottom separator hr (NOT top border). */
      const path = String(node.attrs?.path ?? '')
      const type = String(node.attrs?.type ?? 'string')
      const required = node.attrs?.required === true
      const description = String(node.attrs?.description ?? '')
      return (
        <div
          key={k}
          className="param-block"
          style={{ paddingTop: '4px', paddingBottom: '8px' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              flexWrap: 'wrap',
              marginBottom: '8px',
            }}
          >
            <span
              style={{
                fontWeight: 500,
                fontSize: '13px',
                color: 'var(--primary, #3b82f6)',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              }}
            >
              {path}
            </span>
            <span
              style={{
                fontWeight: 500,
                fontSize: '12px',
                color: 'inherit',
                background: 'color-mix(in srgb, var(--foreground) 6%, transparent)',
                border: '1px solid color-mix(in srgb, var(--foreground) 10%, transparent)',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                padding: '2px 8px',
                borderRadius: 'var(--radius-md)',
              }}
            >
              {type}
            </span>
            {required && (
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 500,
                  color: '#ef4444',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  borderRadius: 'var(--radius-md)',
                  padding: '2px 8px',
                  fontFamily: 'inherit',
                }}
              >
                required
              </span>
            )}
          </div>
          {description && (
            <p
              style={{
                margin: 0,
                fontSize: '14px',
                color: 'var(--muted-foreground, color-mix(in srgb, var(--foreground) 60%, var(--background) 40%))',
                lineHeight: 1.6,
              }}
              dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(description) }}
            />
          )}
          <hr
            style={{
              width: '100%',
              border: 'none',
              borderTop: '1px solid var(--chrome-border)',
              margin: '16px 0 0 0',
            }}
          />
        </div>
      )
    }

    case 'responseBlock': {
      /* Mirrors `packages/ui/src/components/Response.tsx`: entire
         container tinted with the status color (~8-12% bg + 15-20%
         border), status badge inside more opaque (15-20% bg, color
         text). No left-bar pattern. Color by HTTP range:
         2xx green, 3xx blue, 4xx amber, 5xx red. */
      const status = String(node.attrs?.status ?? '200')
      const description = String(node.attrs?.description ?? '')
      const statusInt = parseInt(status, 10)
      const c =
        statusInt >= 500 ? '#ef4444'
        : statusInt >= 400 ? '#f59e0b'
        : statusInt >= 300 ? '#3b82f6'
        : statusInt >= 200 ? '#10b981'
        : '#6b7280'
      return (
        <div
          key={k}
          className="response-block"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            padding: '0.75rem 1rem',
            borderRadius: 'var(--radius-lg)',
            background: `color-mix(in srgb, ${c} 10%, transparent)`,
            border: `1px solid color-mix(in srgb, ${c} 18%, transparent)`,
            marginBottom: '0.5rem',
            margin: '0.75em 0',
          }}
        >
          <span
            style={{
              padding: '0.25rem 0.5rem',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.75rem',
              fontWeight: 600,
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              flexShrink: 0,
              background: `color-mix(in srgb, ${c} 18%, transparent)`,
              color: c,
            }}
          >
            {status}
          </span>
          {description && (
            <div
              style={{
                flex: 1,
                fontSize: '0.875rem',
                lineHeight: 1.5,
                color: 'inherit',
              }}
              dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(description) }}
            />
          )}
        </div>
      )
    }

    case 'labelBlock': {
      /* Mirrors `packages/ui/src/components/Label.tsx`: pill with
         color-tinted bg (8-12%), color border (20-25%), color TEXT
         (full opacity) — NOT solid color fill with white text.
         radius-md, NOT 9999px. Size scale: sm/md/lg. */
      let items: Array<{ text?: string; color?: string; size?: string; icon?: string }> = []
      try {
        const raw = node.attrs?.labels
        items = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
      } catch {
        items = []
      }
      if (items.length === 0) return null
      const sizes: Record<string, { padding: string; fontSize: string }> = {
        sm: { padding: '0.2rem 0.5rem', fontSize: '0.65rem' },
        md: { padding: '0.3rem 0.75rem', fontSize: '0.75rem' },
        lg: { padding: '0.4rem 1rem', fontSize: '0.875rem' },
      }
      return (
        <div
          key={k}
          className="label-block"
          style={{
            display: 'inline-flex',
            flexWrap: 'wrap',
            gap: '0.4rem',
            margin: '0.25rem 0',
          }}
        >
          {items.map((it, i) => {
            const c = it.color || '#3b82f6'
            const s = sizes[it.size || 'md'] ?? sizes.md!
            return (
              <span
                key={i}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                  padding: s.padding,
                  fontSize: s.fontSize,
                  borderRadius: 'var(--radius-md)',
                  background: `color-mix(in srgb, ${c} 10%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${c} 22%, transparent)`,
                  color: c,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  letterSpacing: '0.01em',
                  lineHeight: 1.4,
                }}
              >
                {it.text || ''}
              </span>
            )
          })}
        </div>
      )
    }

    case 'changelogBlock': {
      /* `<Changelog>` — simple vertical stack of entries. POC has
         no timeline rail / dots: each entry is self-contained with a
         primary-colored label badge at the top. */
      const updates = (node.content ?? []).filter(
        (c) => c.type === 'updateBlock',
      )
      const title = String(node.attrs?.title ?? '')
      const description = String(node.attrs?.description ?? '')
      return (
        <section key={k} className="changelog-block">
          {(title || description) && (
            <header className="changelog-block__header">
              {title && <h1 className="changelog-block__title">{title}</h1>}
              {description && (
                <p className="changelog-block__description">{description}</p>
              )}
            </header>
          )}
          <div className="changelog-block__entries">
            {updates.map((u, i) =>
              renderChildren([u], { ...ctx, counter: { n: i } }),
            )}
          </div>
        </section>
      )
    }

    case 'updateBlock': {
      /* Two-column entry. SSG uses `.cl-entry` prefix (NOT
         `.update-entry`) to escape the bundled Update.css rules
         from the dashboard, which add `!important` padding +
         `display: none` on `.update-aside` for entries without a
         `data-narrow` attribute. With different class names we own
         the visual completely. */
      const label = String(node.attrs?.label ?? '')
      const description = String(node.attrs?.description ?? '')
      const tags = String(node.attrs?.tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const author = String(node.attrs?.author ?? '').replace(/^@/, '')
      const href = String(node.attrs?.href ?? '')
      const idAttr = String(node.attrs?.id ?? '')
      const anchorId = idAttr ? `update-${idAttr}` : undefined
      return (
        <article
          key={k}
          id={anchorId}
          className="cl-entry"
          data-update-label={label}
        >
          <aside className="cl-entry__aside">
            {label && <div className="cl-entry__label">{label}</div>}
            {tags.length > 0 && (
              <div className="cl-entry__tags">
                {tags.map((t) => (
                  <div key={t} className="cl-entry__tag">{t}</div>
                ))}
              </div>
            )}
          </aside>
          <div className="cl-entry__body">
            {description && (
              <h3 className="cl-entry__title">{description}</h3>
            )}
            <div className="cl-entry__content">{renderChildren(node.content, ctx)}</div>
            {(author || href) && (
              <footer className="cl-entry__footer">
                {author && (
                  <a
                    href={`https://github.com/${author}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    @{author}
                  </a>
                )}
                {href && (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    View on GitHub ↗
                  </a>
                )}
              </footer>
            )}
          </div>
        </article>
      )
    }

    // -----------------------------------------------------------------
    // Fallback for unmapped custom blocks: render children plain so the
    // text isn't lost. Subsequent batches will add presenters here.
    // -----------------------------------------------------------------
    default:
      if (node.content && node.content.length > 0) {
        return <div key={k} data-unmapped-type={node.type}>{renderChildren(node.content, ctx)}</div>
      }
      return null
  }
}

/** Convert a Tiptap JSON doc to a React node tree. */
export function renderTiptapToReact(
  doc: TiptapDoc,
  options: RenderOptions = {},
): React.ReactNode {
  const ctx: Ctx = { counter: { n: 0 }, options }
  return renderChildren(doc.content, ctx)
}

/** Convert a Tiptap JSON doc to a static HTML string. */
export function renderTiptapToHtml(
  doc: TiptapDoc,
  options: RenderOptions = {},
): string {
  return renderToStaticMarkup(<>{renderTiptapToReact(doc, options)}</>)
}
