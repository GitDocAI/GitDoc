/**
 * CalloutPresenter — pure visual rendering for info/tip/note/warning/
 * danger callouts. Used by the static SSG renderer in
 * `renderTiptap.tsx`. No Tiptap deps, no DOM lookups — SSR-safe.
 *
 * All colors live in CSS (`.callout--info`, `.callout--tip`, …) with
 * separate dark/light palettes, matching publish-web's
 * `InfoBlockNodeView`. The presenter only emits structure + class
 * names + the right PrimeIcon for each variant.
 */
import type { ReactNode } from 'react'

export type CalloutVariant = 'info' | 'tip' | 'note' | 'warning' | 'danger'

export interface CalloutPresenterProps {
  variant?: CalloutVariant
  children?: ReactNode
}

const ICONS: Record<CalloutVariant, string> = {
  info: 'pi pi-info-circle',
  tip: 'pi pi-lightbulb',
  note: 'pi pi-pencil',
  warning: 'pi pi-exclamation-triangle',
  danger: 'pi pi-times-circle',
}

export function CalloutPresenter({ variant = 'info', children }: CalloutPresenterProps) {
  const safe = (ICONS[variant] ? variant : 'info') as CalloutVariant
  return (
    <div className={`callout callout--${safe}`}>
      <i className={`${ICONS[safe]} callout__icon`} aria-hidden="true" />
      <div className="callout__body">{children}</div>
    </div>
  )
}
