/**
 * Self-contained styled error page for the Worker's fallback responses
 * (unknown hostname, doc missing in R2, etc.). Inline CSS + SVG only —
 * no external assets, no theme config — so it renders even when there's
 * no documentation to read styling from. Honors prefers-color-scheme.
 */

interface ErrorPageOptions {
  status: number
  title: string
  message: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function errorPage({ status, title, message }: ErrorPageOptions): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #fafafa;
    --fg: #171717;
    --muted: #6b7280;
    --card: #ffffff;
    --border: rgba(0, 0, 0, 0.08);
    --accent: #2563eb;
    --glow: rgba(37, 99, 235, 0.10);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0a0a;
      --fg: #ededed;
      --muted: #9ca3af;
      --card: #111111;
      --border: rgba(255, 255, 255, 0.10);
      --accent: #3b82f6;
      --glow: rgba(59, 130, 246, 0.14);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
  }
  .glow {
    position: absolute;
    top: -25%;
    left: 50%;
    transform: translateX(-50%);
    width: 720px;
    height: 480px;
    background: var(--glow);
    border-radius: 9999px;
    filter: blur(120px);
    pointer-events: none;
  }
  .card {
    position: relative;
    width: 100%;
    max-width: 460px;
    margin: 24px;
    padding: 40px 32px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    animation: rise 0.5s ease;
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .icon {
    width: 56px;
    height: 56px;
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--card);
    border: 1px solid var(--border);
    color: var(--accent);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  }
  .icon svg { width: 28px; height: 28px; }
  h1 {
    margin: 6px 0 0;
    font-size: 1.35rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }
  p {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.6;
    color: var(--muted);
    max-width: 360px;
  }
  .badge {
    margin-top: 4px;
    font-size: 0.75rem;
    color: var(--muted);
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px 12px;
    font-variant-numeric: tabular-nums;
  }
  .brand {
    position: absolute;
    bottom: 24px;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 0.78rem;
    color: var(--muted);
    opacity: 0.8;
  }
  .brand a { color: var(--muted); text-decoration: none; }
  .brand a:hover { color: var(--fg); }
</style>
</head>
<body>
  <div class="glow"></div>
  <main class="card">
    <div class="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    </div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <span class="badge">Error ${status}</span>
  </main>
  <div class="brand">
    Powered by <a href="https://gitdoc.ai" target="_blank" rel="noopener">GitDoc</a>
  </div>
</body>
</html>`

  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
