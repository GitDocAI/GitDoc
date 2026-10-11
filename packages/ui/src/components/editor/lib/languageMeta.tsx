/**
 * Shared language metadata + a tiny <LanguageDot> component used by
 * the code-block + code-group node views. Kept in one place so the
 * selector trigger + dropdown render identically across both.
 */

/* GitHub-style palette — a small color swatch next to the language
   name in the selector trigger + dropdown. Fallback to a neutral
   gray for anything not in the curated list. */
const LANG_COLORS: Record<string, string> = {
  javascript: '#f1e05a',
  js: '#f1e05a',
  jsx: '#f1e05a',
  typescript: '#3178c6',
  ts: '#3178c6',
  tsx: '#3178c6',
  python: '#3572a5',
  py: '#3572a5',
  go: '#00add8',
  rust: '#dea584',
  rs: '#dea584',
  java: '#b07219',
  kotlin: '#a97bff',
  swift: '#f05138',
  csharp: '#239120',
  'c++': '#f34b7d',
  cpp: '#f34b7d',
  c: '#555555',
  ruby: '#701516',
  rb: '#701516',
  php: '#4f5d95',
  html: '#e34c26',
  css: '#563d7c',
  scss: '#c6538c',
  sass: '#a53b70',
  json: '#cbcb41',
  yaml: '#cb171e',
  yml: '#cb171e',
  markdown: '#083fa1',
  md: '#083fa1',
  mdx: '#1a1a1a',
  bash: '#89e051',
  shell: '#89e051',
  sh: '#89e051',
  zsh: '#89e051',
  fish: '#89e051',
  sql: '#e38c00',
  graphql: '#e10098',
  dockerfile: '#0db7ed',
  docker: '#0db7ed',
  toml: '#9c4221',
  ini: '#d1dbe0',
  xml: '#0060ac',
  plaintext: '#888888',
  text: '#888888',
}

export function langColor(lang: string): string {
  return LANG_COLORS[lang.toLowerCase()] ?? '#888'
}

/* Friendlier display label — `javascript` → `JavaScript`. */
const LANG_LABELS: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  jsx: 'JSX',
  tsx: 'TSX',
  csharp: 'C#',
  cpp: 'C++',
  mdx: 'MDX',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  json: 'JSON',
  yaml: 'YAML',
  markdown: 'Markdown',
  graphql: 'GraphQL',
  dockerfile: 'Dockerfile',
  plaintext: 'Plain text',
}

export function languageLabel(lang: string): string {
  return LANG_LABELS[lang.toLowerCase()] ?? lang
}

export function LanguageDot({ lang }: { lang: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: langColor(lang),
        flexShrink: 0,
      }}
      aria-hidden="true"
    />
  )
}
