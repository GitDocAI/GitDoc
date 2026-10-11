/**
 * CardPresenter — pure visual rendering of a card block.
 *
 * The NodeView in edit mode wraps this same presenter so the dashboard
 * preview and the static publish output look identical. No Tiptap
 * deps, no DOM lookups, no `useEffect` — safe to call from
 * `renderToStaticMarkup` inside the build-time renderer.
 *
 * Theme-sensitive colors come from CSS variables (`--card-border`,
 * `--card-icon-bg`, `--accent-color`) — defined globally in the host
 * stylesheet (publish-content.css for SSG, index.css for dashboard).
 */
import React from 'react'
import { IconRenderer } from '../../../common/IconPicker'

export interface CardPresenterProps {
  title?: string
  icon?: string
  iconAlign?: 'left' | 'center' | 'right'
  href?: string
  children?: React.ReactNode
}

export function CardPresenter({
  title,
  icon,
  iconAlign = 'left',
  href,
  children,
}: CardPresenterProps) {
  const isExternal = !!href && /^https?:/i.test(href)

  const headerJustify =
    iconAlign === 'center' ? 'center' : iconAlign === 'right' ? 'flex-end' : 'flex-start'
  const headerFlexDir =
    iconAlign === 'center' ? 'column' : iconAlign === 'right' ? 'row-reverse' : 'row'
  const titleAlign =
    iconAlign === 'center' ? 'center' : iconAlign === 'right' ? 'right' : 'left'

  /* Render anchor when there's a destination — gives native navigation
     for the static case without any JS. Internal links stay same-tab;
     external ones open in a new tab. */
  const containerStyle: React.CSSProperties = {
    display: 'block',
    textDecoration: 'none',
    color: 'inherit',
    position: 'relative',
    border: '1px solid var(--card-border, rgba(255, 255, 255, 0.08))',
    borderRadius: 'var(--radius-xl)',
    overflow: 'hidden',
    backgroundColor: 'transparent',
    transition: 'border-color 0.2s ease, background-color 0.2s ease',
    cursor: href ? 'pointer' : 'default',
  }
  const inner = (
      <div style={{ padding: '1.25rem' }} key="inner">
        <div
          style={{
            display: 'flex',
            gap: '0.875rem',
            alignItems: 'center',
            marginBottom: '0.75rem',
            justifyContent: headerJustify,
            flexDirection: headerFlexDir as 'row' | 'column' | 'row-reverse',
          }}
        >
          {icon ? (
            <div
              style={{
                flexShrink: 0,
                borderRadius: 'var(--radius-xl)',
                width: '40px',
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'var(--card-icon-bg, rgba(255, 255, 255, 0.06))',
              }}
            >
              <IconRenderer
                iconKey={icon}
                style={{
                  fontSize: '1.25rem',
                  color: 'var(--accent-color, #3b82f6)',
                  width: '24px',
                  height: '24px',
                }}
              />
            </div>
          ) : null}

          <h3
            style={{
              margin: 0,
              fontSize: '1rem',
              fontWeight: 600,
              fontFamily: 'inherit',
              /* Match the article's heading tone (publish-content.css
                 sets h1-h4 to a 90/10 fg/bg mix). Not `color: inherit`
                 — that resolves to `--content-text` which is the muted
                 body color, leaving the card title too washed out. */
              color: 'color-mix(in srgb, var(--foreground) 90%, var(--background) 10%)',
              textAlign: titleAlign as 'left' | 'center' | 'right',
              flex: 1,
              minWidth: 0,
              padding: '2px 0',
              lineHeight: 1.4,
            }}
          >
            {title || 'Untitled Card'}
          </h3>
        </div>

        <div
          style={{
            fontSize: '0.875rem',
            color: 'inherit',
            lineHeight: 1.6,
          }}
        >
          {children}
        </div>
      </div>
  )
  if (href) {
    return (
      <a
        className="card-presenter group"
        href={href}
        target={isExternal ? '_blank' : undefined}
        rel={isExternal ? 'noopener noreferrer' : undefined}
        style={containerStyle}
      >
        {inner}
      </a>
    )
  }
  return (
    <div className="card-presenter group" style={containerStyle}>
      {inner}
    </div>
  )
}
