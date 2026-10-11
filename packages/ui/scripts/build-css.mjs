// The published pages need the content styles (`.tiptap-editor …`, update
// timelines). They are plain CSS files: concatenate them into dist/styles.css.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const sheets = ['src/components/editor/tiptap.css', 'src/components/Update.css']
mkdirSync('dist', { recursive: true })
const css = sheets.map((f) => `/* ${f} */\n${readFileSync(f, 'utf-8')}`).join('\n')
writeFileSync('dist/styles.css', css)
console.log(`built dist/styles.css (${sheets.length} sheets, ${css.length} bytes)`)
