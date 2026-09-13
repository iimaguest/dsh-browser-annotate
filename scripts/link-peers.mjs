// Relink the host packages this plugin is built against.
//
// The plugin is loaded by DSH from a symlink inside a DSH profile, and Node resolves imports
// from the plugin's real path — so `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-llm` must be
// resolvable from here, not from wherever DSH happens to live. They are peer dependencies, which
// means `npm install` sees local copies as extraneous and deletes them; running this afterwards
// puts them back. If the tools disappear from a session after an install, this is why.

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** Where DSH itself is installed, and therefore where its packages live. */
function deployedRoot() {
  if (process.env.DSH_INSTALL !== undefined) return process.env.DSH_INSTALL
  try {
    // Resolving a package this plugin is certain to be loaded beside finds the deployment
    // without anyone having to say where it is.
    const require = createRequire(import.meta.url)
    return dirname(dirname(require.resolve('@deepseek-ai/dsh-tools/package.json')))
  } catch {
    return null
  }
}

const wanted = ['dsh-tools', 'dsh-llm', 'dsh-agent', 'dsh-attachment', 'cordis']
const target = join(root, 'node_modules', '@deepseek-ai')

// A candidate list, because a plugin under development is often loaded from a checkout while the
// deployment it runs inside is installed somewhere else entirely.
const candidates = [
  deployedRoot(),
  process.env.DSH_HOME === undefined ? null : join(process.env.DSH_HOME, 'node_modules', '@deepseek-ai'),
  join(process.env.HOME ?? '', '.dsh', 'node_modules', '@deepseek-ai'),
].filter(candidate => candidate !== null && existsSync(candidate))

if (candidates.length === 0) {
  console.error('Could not find a DSH install. Set DSH_INSTALL to its node_modules/@deepseek-ai directory.')
  process.exit(1)
}

mkdirSync(target, { recursive: true })
let linked = 0
for (const name of wanted) {
  const source = candidates.map(base => join(base, name)).find(path => existsSync(path))
  if (source === undefined) {
    console.log(`  ${name}: not found in any DSH install, skipped`)
    continue
  }
  const link = join(target, name)
  rmSync(link, { recursive: true, force: true })
  symlinkSync(source, link, 'dir')
  console.log(`  ${name} -> ${source}`)
  linked += 1
}
console.log(`linked ${linked} package(s) into ${target}`)
