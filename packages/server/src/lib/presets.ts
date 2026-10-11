/**
 * Theme presets — single source of truth for any LAYOUT decision that
 * varies between curated identities. The manifest's `theme.preset`
 * field names the preset; the POC resolves it here and threads the
 * resulting object through the layout / components.
 *
 * Anything that's the same across every preset (shape always soft,
 * sidebar derives from page bg, navbar derives from page bg, logo
 * pinned left) is NOT a field on `Preset` — it's baked into the
 * components directly.
 */

export type PresetId = 'pearl' | 'mist' | 'onyx' | 'slate' | 'jade'

/** Order in which the right cluster of the navbar lays out its three
 *  groups: the search button, the configured CTA links, and the theme
 *  toggle. Each preset can reorder them. */
export type RightClusterItem = 'search' | 'links' | 'theme'

/** Where the section tabs render.
 *  - `navbar_left`: inline in the left cluster, right after the logo (Pearl).
 *  - `navbar_center`: in the center zone of the navbar (Onyx).
 *  - `subbar`: in a dedicated row below the navbar (Mist). */
export type SectionsPlacement = 'navbar_left' | 'navbar_center' | 'subbar'

export interface PresetHeader {
  rightClusterOrder: RightClusterItem[]
  sectionsPlacement: SectionsPlacement
  /** When true, the search + Ask AI pills render in the CENTER zone of
   *  the navbar instead of inline in the right cluster — pearl=false,
   *  mist=true. The right cluster's order should NOT include 'search'
   *  when this is true. */
  searchInCenter: boolean
  /** When true, search + Ask AI live at the TOP of the sidebar instead
   *  of in the navbar. Mutually exclusive with `searchInCenter`; the
   *  navbar's `rightClusterOrder` also drops 'search' in this case. */
  searchInSidebar: boolean
}

/** Corner-radius scale. Soft is the conventional ~0.5rem (matches every
 *  preset today); sharp pins everything to 0 for an enterprise wiki
 *  vibe; round goes up to ~1rem for a friendlier consumer feel. */
export type PresetShape = 'sharp' | 'soft' | 'round'

/** Overall chrome arrangement.
 *  - `full-width`: navbar, subbar, and body span the full viewport
 *    width edge-to-edge (Pearl, default).
 *  - `centered`: navbar, subbar, and body content are constrained to
 *    a centered max-width container — Mintlify-style (Mist). The
 *    bottom borders still span full width for visual continuity. */
export type PresetArrangement = 'full-width' | 'centered'

export interface Preset {
  id: PresetId
  header: PresetHeader
  shape: PresetShape
  arrangement: PresetArrangement
  /** When true the TOC is hoisted out of the article column and
   *  anchors to the right edge of the body row (= the viewport for
   *  `full-width` presets). When false the TOC sits flush with the
   *  right side of the article inside the content area. */
  tocAtFarRight: boolean
}

const pearl: Preset = {
  id: 'pearl',
  header: {
    rightClusterOrder: ['search', 'links', 'theme'],
    sectionsPlacement: 'navbar_left',
    searchInCenter: false,
    searchInSidebar: false,
  },
  shape: 'soft',
  arrangement: 'full-width',
  tocAtFarRight: false,
}

const mist: Preset = {
  id: 'mist',
  header: {
    rightClusterOrder: ['links', 'theme'],
    sectionsPlacement: 'subbar',
    searchInCenter: true,
    searchInSidebar: false,
  },
  shape: 'round',
  arrangement: 'centered',
  tocAtFarRight: false,
}

const onyx: Preset = {
  id: 'onyx',
  /* Onyx mirrors Pearl's chrome but anchors sections at the center
     of the navbar (brand-forward symmetric feel) and uses a rounder
     corner radius. Palette lives in the manifest. */
  header: {
    rightClusterOrder: ['search', 'links', 'theme'],
    sectionsPlacement: 'navbar_center',
    searchInCenter: false,
    searchInSidebar: false,
  },
  shape: 'round',
  arrangement: 'full-width',
  tocAtFarRight: true,
}

const slate: Preset = {
  id: 'slate',
  /* Slate is the dense reference-doc layout: full-width body row
     (TOC anchored at the viewport's right edge), sections living in
     a subbar under the navbar, and search + Ask AI centered like a
     command palette beacon. Vivid yellow accent — the palette is
     set in the manifest. */
  header: {
    rightClusterOrder: ['links', 'theme'],
    sectionsPlacement: 'subbar',
    searchInCenter: true,
    searchInSidebar: false,
  },
  shape: 'soft',
  arrangement: 'full-width',
  tocAtFarRight: true,
}

const jade: Preset = {
  id: 'jade',
  /* Jade is the classic "aside" layout: full-width body row with the
     TOC sitting flush with the article (not anchored to the viewport
     edge), sections inline next to the logo. Search lives at the top
     of the sidebar rather than the navbar — a tighter editorial feel
     where the navbar holds only sections + CTAs. Teal accent —
     palette in manifest. */
  header: {
    rightClusterOrder: ['links', 'theme'],
    sectionsPlacement: 'navbar_left',
    searchInCenter: false,
    searchInSidebar: true,
  },
  shape: 'soft',
  arrangement: 'full-width',
  tocAtFarRight: false,
}

export const PRESETS = { pearl, mist, onyx, slate, jade } as const

/** Resolves the preset by id, defaulting to pearl when the manifest
 *  omits the field or names an unknown preset. */
export function resolvePreset(name: string | undefined | null): Preset {
  if (name && name in PRESETS) return (PRESETS as Record<string, Preset>)[name]!
  return pearl
}
