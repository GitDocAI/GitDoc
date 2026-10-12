/**
 * VideoPresenter — pure visual rendering for the video block.
 *
 * Shared by the editor NodeView (edit + read) and the static SSG renderer
 * via `renderTiptap.tsx`. No Tiptap deps, no hooks, no DOM lookups, inline
 * styles only — so it renders identically under `renderToStaticMarkup`.
 *
 * Iframe embeds (YouTube/Vimeo/Loom) only ever receive a URL produced by
 * `buildEmbedUrl()`; a provider we can't resolve renders a placeholder
 * rather than an arbitrary frame. Self-hosted files render a native <video>.
 */
import { useEffect, useState } from 'react'
import { useAssets } from '../../../../hooks/useAssets'
import { buildEmbedUrl, type VideoProvider } from '../../../../lib/videoProvider'

export interface VideoPresenterProps {
  src: string
  provider: VideoProvider
  title?: string
}

const FRAME_STYLE: React.CSSProperties = {
  border: '1px solid var(--image-frame-border, rgba(255, 255, 255, 0.1))',
  borderRadius: 12,
  overflow: 'hidden',
  maxWidth: '100%',
  backgroundColor: '#000',
}

const ASPECT_STYLE: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  paddingTop: '56.25%', // 16:9
}

const FILL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  border: 0,
  display: 'block',
}

function Caption({ title }: { title?: string }) {
  if (!title) return null
  return (
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
      {title}
    </div>
  )
}

export function VideoPresenter({ src:insrc, provider, title }: VideoPresenterProps) {
  if (!insrc) return null
  const {downloadAsset} = useAssets()
  const [src,setSrc]=useState<string>(insrc)

  useEffect(()=>{
    if(provider === 'file'){
      (
        async ()=>{
          setSrc(await downloadAsset(insrc.split('/')[2]!))
        }
      )();
    }else{
      setSrc(insrc)
    }

  },[insrc])

  let inner: React.ReactNode

  if (provider === 'file') {
    inner = (
      <div style={ASPECT_STYLE}>
        <video
          src={src}
          controls
          preload="metadata"
          playsInline
          style={{ ...FILL_STYLE, objectFit: 'contain', backgroundColor: '#000' }}
        >
          {title ? `Your browser does not support embedded video: ${title}` : null}
        </video>
      </div>
    )
  } else {
    const embedUrl = buildEmbedUrl(provider, src)
    if (!embedUrl) {
      // Known iframe provider but unparseable URL (or unsupported provider):
      // show a quiet placeholder instead of leaking a raw src into a frame.
      inner = (
        <div
          style={{
            ...ASPECT_STYLE,
            paddingTop: 0,
            minHeight: 120,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.6)',
            fontSize: 13,
          }}
        >
          Unsupported or invalid video URL
        </div>
      )
    } else {
      inner = (
        <div style={ASPECT_STYLE}>
          <iframe
            src={embedUrl}
            title={title || 'Embedded video'}
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            style={FILL_STYLE}
          />
        </div>
      )
    }
  }

  return (
    <div className="video-presenter" style={{ margin: '20px 0' }}>
      <div className="video-presenter__frame" style={FRAME_STYLE}>
        {inner}
      </div>
      <Caption title={title} />
    </div>
  )
}
