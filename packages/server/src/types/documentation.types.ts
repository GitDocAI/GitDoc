export type AudienceType = 'public' | 'private'

export type DocumentationStatus = 'pending' | 'generating' | 'generated' | 'published' | 'error'

export type ThemeMode = 'dark' | 'light'

export interface ThemeColors {
  bg_color?: string
  text_color?: string
  accent_color?: string
  logo_url?: string
}

export interface ThemeConfig {
  dark: ThemeColors
  light: ThemeColors
  modes?: ThemeMode[]
  default?: ThemeMode
  font_family?: string
  /** Optional override applied only to h1-h6. When unset, headings
   *  inherit `font_family`. */
  heading_font?: string
  show_name?: boolean
  /** Preset anchor — informational, doesn't affect rendering. */
  preset?: string
}

export interface AssistantConfig {
  enabled?: boolean
  floating?: boolean
  custom_instructions?: string
}

export interface SEOConfig {
  site_title?: string
  title_template?: string
  default_description?: string
  default_og_image?: string
  google_analytics_id?: string
}

export interface LinkButton {
  label?: string
  url: string
  icon?: string
  style?: 'default' | 'primary' | 'subtle'
}

export interface FooterConfig {
  enabled?: boolean
  links?: LinkButton[]
  copyright?: string
}

export interface KBConfig {
  enabled: boolean
  name?: string
  icon?: string
  hero_title?: string
  hero_description?: string
  hero_placeholder?: string
  search_suggestions?: string[]
  show_categories?: boolean
  show_popular_articles?: boolean
  popular_title?: string
  popular_articles?: string[]
}

export interface DocumentationConfig {
  theme: ThemeConfig
  favicon_url?: string
  seo: SEOConfig
  navbar?: LinkButton[]
  footer?: FooterConfig
  kb: KBConfig
  assistant?: AssistantConfig
  generation_instructions?: string
}

export type VersionSelectorPosition = 'navbar_right' | 'after_logo'

export interface Documentation {
  id: string
  organization_id: string
  name: string
  description?: string
  audience: AudienceType
  status: DocumentationStatus
  config: DocumentationConfig
  version_selector_enabled: boolean
  version_selector_position: VersionSelectorPosition
  created_at: string
  updated_at: string
}

export interface Version {
  id: string
  documentation_id: string
  name: string
  slug: string
  is_latest: boolean
  is_default: boolean
  is_deprecated: boolean
  released_at?: string
  created_at: string
  updated_at: string
}

export type SectionType = 'product_documentation' | 'api_reference' | 'changelog' | 'describe_with_ai'

export interface Section {
  id: string
  version_id: string
  name: string
  slug: string
  type: SectionType
  icon?: string
  order: number
  visible: boolean
  prompt?: string
  created_at: string
  updated_at: string
}

export type DocEntryType = 'page' | 'folder'

export interface DocEntryReleaseInfo {
  tag_name: string
  html_url?: string
  is_prerelease?: boolean
  release_id?: number
}

export interface DocEntryMetadata {
  author?: string
  author_avatar?: string
  reading_time?: number
  description?: string
  tags?: string[]
  published_at?: string
  last_edited_by?: string
  /** Populated for changelog pages so the timeline UI skips markdown parsing. */
  release?: DocEntryReleaseInfo
}

export interface DocEntry {
  id: string
  section_id: string
  parent_id?: string
  title: string
  slug: string
  type: DocEntryType
  content?: string
  icon?: string
  order: number
  metadata?: DocEntryMetadata
  created_at: string
  updated_at: string
  children?: DocEntry[]
}
