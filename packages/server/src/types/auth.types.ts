export interface LoginCredentials {
  email: string
  password: string
}

export interface AuthTokens {
  access_token: string
  refresh_token: string
}

export interface LoginConfig {
  name: string
  organization_id: string
  audience: 'public' | 'private'
  favicon_url?: string
  theme: {
    dark: ThemeColors
    light: ThemeColors
    modes?: ('dark' | 'light')[]
    default?: 'dark' | 'light'
    font_family?: string
  }
}

interface ThemeColors {
  bg_color?: string
  text_color?: string
  accent_color?: string
  logo_url?: string
}
