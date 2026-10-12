import type { Page, NavPage } from '../types/nav'
import type { DocEntry } from '@/types/documentation.types'

export function loadGoogleFont(fontName: string) {
  if (!fontName) return

  const fontId = `google-font-${fontName.replace(/\s+/g, '-').toLowerCase()}`
  if (document.getElementById(fontId)) return

  if (fontName.startsWith('system') || fontName.startsWith('-apple')) return

  const link = document.createElement('link')
  link.id = fontId
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;500;600;700&display=swap`
  document.head.appendChild(link)
}

export function convertEntriesToPages(
  entries: DocEntry[] | undefined | null
): Page[] {
  if (!entries || !Array.isArray(entries)) {
    return []
  }
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    children: entry.children ? convertEntriesToPages(entry.children) : [],
  }))
}

export function flattenEntriesToNavPages(
  entries: DocEntry[] | undefined | null
): NavPage[] {
  if (!entries || !Array.isArray(entries)) {
    return []
  }
  const result: NavPage[] = []
  for (const entry of entries) {
    if (entry.children && entry.children.length > 0) {
      result.push(...flattenEntriesToNavPages(entry.children))
    } else {
      result.push({ id: entry.id, title: entry.title })
    }
  }
  return result
}
