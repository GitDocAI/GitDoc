// Assemble engine/: the self-contained runtime the `gitdoc` CLI and the Docker
// image run. It needs no node_modules next to it and can live in any directory.
//
//   engine/server/entry.mjs   the server   (GITDOC_ENGINE_SERVER)
//   engine/client/            its static assets
//   engine/render.js          the renderer  (GITDOC_ENGINE_RENDER)
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const server = resolve(root, 'packages/server/dist')
const render = resolve(root, 'packages/render/dist/cli.js')
for (const p of [resolve(server, 'server/entry.mjs'), render]) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — run \`npm run build\` first`)
    process.exit(1)
  }
}

const out = resolve(root, 'engine')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(server, out, { recursive: true })
cpSync(render, resolve(out, 'render.js'))

const version = JSON.parse(readFileSync(resolve(root, 'packages/server/package.json'), 'utf-8')).version
writeFileSync(
  resolve(out, 'engine.json'),
  JSON.stringify({ name: 'gitdoc-engine', version, server: 'server/entry.mjs', renderCli: 'render.js' }, null, 2) + '\n',
)
console.log(`engine/ assembled (v${version})`)
