import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const directory = resolve(import.meta.dirname, '../dist')
let html = await readFile(resolve(directory, 'index.html'), 'utf8')
const script = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/)
const stylesheet = html.match(/<link[^>]*href="([^"]+\.css)"[^>]*>/)
if (!script || !stylesheet) throw new Error('Expected one bundled entry and stylesheet.')
const localPath = (name) => resolve(directory, name.replace(/^\.?\//, ''))
const css = await readFile(localPath(stylesheet[1]), 'utf8')
const js = await readFile(localPath(script[1]), 'utf8')
html = html.replace(script[0], '')
html = html.replace(stylesheet[0], () => `<style>${css.replaceAll('</style', '<\\/style')}</style>`)
html = html.replace(
  '</body>',
  () => `<script type="module">${js.replaceAll('</script', '<\\/script')}</script></body>`,
)
await writeFile(resolve(directory, 'standalone.html'), html)
console.log('Created dist/standalone.html (bundled, no external runtime dependencies).')
