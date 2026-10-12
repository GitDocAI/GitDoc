/**
 * ImagePresenter — pure visual rendering for the image block.
 *
 * Renders the same framed-image-with-caption visual as ImageNodeView's
 * read-only branch. No Tiptap deps, no DOM lookups. The lightbox
 * interaction (click → expand) is left to a small hydration island
 * (image-lightbox.ts) attached via the `data-lightbox` attribute, so
 * the static HTML still works fully without JS — clicks just navigate
 * to the image URL.
 */
export interface ImagePresenterProps {
  src: string
  alt?: string
  caption?: string
  width?: number
  height?: number
}

export function ImagePresenter({ src, alt, caption, width, height }: ImagePresenterProps) {
  if (!src) return null

  /* Plain <div> structure (no <figure>) to match ImageNodeView byte
     for byte. Browsers add `margin: 1em 40px` to figure plus padding
     that's hard to fully reset; sticking to div avoids the surprise. */
  return (
    <div
      className="image-presenter"
      style={{
        margin: '20px 0',
        textAlign: 'center',
      }}
    >
      <div
        className="image-presenter__frame"
        style={{
          border: '1px solid var(--image-frame-border, rgba(255, 255, 255, 0.1))',
          borderRadius: 12,
          padding: 10,
          backgroundImage:
            'var(--image-frame-grid, linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px))',
          backgroundSize: '20px 20px',
          maxWidth: '100%',
          display: 'inline-block',
          /* Inline-block parents leak inline baseline space; line-height:0
             plus vertical-align:top on the img eliminates the ~4px ghost
             below the image that made the bottom border look thicker. */
          lineHeight: 0,
          fontSize: 0,
        }}
      >
        <a
          href={src}
          data-lightbox
          aria-label={alt ? `Open image: ${alt}` : 'Open image'}
          style={{
            display: 'block',
            cursor: 'zoom-in',
          }}
        >
          <img
            src={src}
            alt={alt ?? ''}
            width={width}
            height={height}
            loading="lazy"
            style={{
              maxWidth: '100%',
              height: 'auto',
              display: 'block',
              borderRadius: 8,
              verticalAlign: 'top',
            }}
          />
        </a>
        {caption ? (
          <div
            style={{
              padding: '0.75rem 1rem 0.25rem',
              fontSize: 14,
              lineHeight: 1.45,
              opacity: 0.7,
              textAlign: 'center',
              fontStyle: 'italic',
            }}
          >
            {caption}
          </div>
        ) : null}
      </div>
    </div>
  )
}
