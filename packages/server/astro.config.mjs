// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config'
import node from '@astrojs/node'
import tailwindcss from '@tailwindcss/vite'

// Routes that only exist on a self-hosted (Node) server. They live outside
// src/pages so the app stays a plain Astro site for any other host.
const selfHostedRoutes = {
  name: 'gitdoc-self-hosted-routes',
  hooks: {
    'astro:config:setup': ({ injectRoute }) => {
      injectRoute({ pattern: '/api/publish', entrypoint: './src/node/publish.ts', prerender: false })
      injectRoute({ pattern: '/api/sites', entrypoint: './src/node/sites.ts', prerender: false })
      injectRoute({ pattern: '/api/reindex', entrypoint: './src/node/reindex.ts', prerender: false })
      injectRoute({ pattern: '/api/settings', entrypoint: './src/node/settings.ts', prerender: false })
      injectRoute({ pattern: '/api/usage', entrypoint: './src/node/settings.ts', prerender: false })
    },
  },
}

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [selfHostedRoutes],
  // sharp is a native add-on; a docs site doesn't resize images on the server.
  image: { service: passthroughImageService() },
  // Prefetch the next page as soon as its link scrolls into view.
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
  vite: {
    plugins: [tailwindcss()],
    // Bundle every dependency: dist/ then runs from any directory, with no
    // node_modules next to it (this is what the gitdoc CLI relies on).
    ssr: { noExternal: true },
  },
})
