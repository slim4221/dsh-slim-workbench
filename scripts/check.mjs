#!/usr/bin/env node
/**
 * Repository self-check for a DeepSeek Harness bundle.
 *
 * Everything here is a defect this repository has actually shipped once: a
 * byte-order mark that made the installer reject the package, a package name that
 * drifted from the name in the loader patch, and a locale `meta.detail` pointing
 * at a file that did not exist. Run it before pushing; CI runs the same file.
 *
 * No dependencies and no network: it reads files and calls `node --check`.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const notes = []
const fail = (message) => { failures.push(message) }

/** Files worth checking, walked without .git and node_modules. */
function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = walk(root)
const textFiles = files.filter((file) => /\.(json|ya?ml|js|mjs|md|svg)$/i.test(file))

// 1. No byte-order marks: a BOM in package.json is rejected by the installer.
for (const file of textFiles) {
  const bytes = readFileSync(file)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${relative(root, file)}: starts with a UTF-8 BOM, which the installer rejects`)
  }
}

// 2. Unix line endings, so a Windows write cannot churn the whole file.
for (const file of textFiles) {
  const text = readFileSync(file, 'utf8')
  if (text.includes('\r\n')) fail(`${relative(root, file)}: has CRLF line endings, expected LF`)
}

// 3. The manifest parses and declares what a bundle needs.
const manifestPath = join(root, 'package.json')
let manifest = null
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  fail(`package.json: does not parse (${error.message})`)
}

if (manifest !== null) {
  for (const field of ['name', 'version', 'description', 'license']) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') {
      fail(`package.json: "${field}" is required`)
    }
  }
  if (!/^[a-z0-9][a-z0-9._~-]*$/.test(manifest.name ?? '')) {
    fail(`package.json: name "${manifest.name}" must be lowercase, unscoped and URL-safe for a public repository`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) {
    fail(`package.json: version "${manifest.version}" is not MAJOR.MINOR.PATCH`)
  }
  if (manifest.type !== 'module') {
    fail('package.json: "type" must be "module" (the halves are ESM)')
  }

  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string') {
    fail('package.json: dsh.bundle.patch is required for a bundle')
  } else if (!existsSync(join(root, patch))) {
    fail(`package.json: dsh.bundle.patch points at a missing file: ${patch}`)
  }
  if (manifest.dsh?.client?.platform !== 'web') {
    fail('package.json: dsh.client.platform must be "web"')
  }

  // Exports must resolve to real files.
  for (const [specifier, target] of Object.entries(manifest.exports ?? {})) {
    const resolved = String(target).replace(/^\.\//, '')
    if (resolved.includes('*')) continue
    if (!existsSync(join(root, resolved))) fail(`package.json: export "${specifier}" points at a missing file: ${resolved}`)
  }

  // The packed file list must carry every runtime file the loader reads.
  const patterns = Array.isArray(manifest.files) ? manifest.files.map((entry) => String(entry)) : []
  const covered = (file) => patterns.some((pattern) => {
    if (pattern === file) return true
    if (pattern.endsWith('/*.json')) return file.startsWith(pattern.slice(0, -6)) && file.endsWith('.json')
    if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2))
    return file.startsWith(`${pattern}/`)
  })
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) {
    if (!covered(required)) fail(`package.json: "files" does not cover ${required}`)
  }
}

// 4. The loader patch must name this very package, or the bundle cannot activate.
const patchPath = join(root, 'cordis.patch.yml')
if (existsSync(patchPath) && manifest !== null) {
  const patchText = readFileSync(patchPath, 'utf8')
  const names = [...patchText.matchAll(/^\s*-?\s*name:\s*'?([^'\n]+)'?\s*$/gm)].map((match) => match[1].trim())
  if (names.length === 0) fail('cordis.patch.yml: declares no plugin row "name"')
  for (const name of names) {
    if (name !== manifest.name) fail(`cordis.patch.yml: row name "${name}" does not match package name "${manifest.name}"`)
  }
  if (!/^\s*-?\s*id:\s*\S+/m.test(patchText)) fail('cordis.patch.yml: a row is missing its "id"')
}

// 5. Locale metadata is what Plugin Manager shows without activating anything.
for (const localeFile of files.filter((file) => /locale[\\/][^\\/]+\.json$/.test(file))) {
  const label = relative(root, localeFile)
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(localeFile, 'utf8'))
  } catch (error) {
    fail(`${label}: does not parse (${error.message})`)
    continue
  }
  const meta = parsed.meta
  if (meta === null || typeof meta !== 'object') { fail(`${label}: "meta" is missing`); continue }
  if (typeof meta.title !== 'string' || meta.title === '') fail(`${label}: meta.title is required`)
  if (typeof meta.description !== 'string' || meta.description.length < 40) fail(`${label}: meta.description is missing or too short`)
  if (meta.detail !== undefined) {
    if (typeof meta.detail !== 'string' || !existsSync(join(root, meta.detail))) {
      fail(`${label}: meta.detail points at a missing file: ${String(meta.detail)}`)
    }
  }
}

// 6. Every script must parse. `node --check` honours "type": "module" from the manifest.
for (const file of files.filter((candidate) => /\.(js|mjs)$/i.test(candidate))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    const message = String(error.stderr ?? error.message).trim().split('\n').slice(0, 3).join(' ')
    fail(`${relative(root, file)}: does not parse (${message})`)
  }
}

// 7. The client module id must equal the package name: the browser pairs the loaded
//    module with the package the boot graph named, so a rename that misses this line
//    leaves a plugin whose Host half runs and whose panel never appears.
const clientPath = join(root, 'client.js')
if (existsSync(clientPath) && manifest !== null) {
  const clientText = readFileSync(clientPath, 'utf8')
  const declared = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(clientText)
  if (declared === null) {
    fail('client.js: no __ModuleLoader__.load({ id }) declaration')
  } else if (declared[1] !== manifest.name) {
    fail(`client.js: module id "${declared[1]}" does not match package name "${manifest.name}"`)
  }
}

// 8. Imports must exist and namespace use needs a namespace import. A named import
//    used as `nvm.installInfo()` throws at request time, not at load time, so only a
//    check like this one catches it before a user does.
const siblingModules = ['launcher.js', 'nvm.js']
for (const file of files.filter((candidate) => candidate.endsWith('.js') && /import\s+\{[^}]+\}\s+from\s+'\.\//.test(readFileSync(candidate, 'utf8')))) {
  const label = relative(root, file)
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\/([^']+)'/g)) {
    const names = match[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop()).filter(Boolean)
    const target = join(root, match[2])
    if (!existsSync(target)) { fail(`${label}: imports from a missing module ${match[2]}`); continue }
    const exported = new Set([...readFileSync(target, 'utf8').matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)].map((entry) => entry[1]))
    for (const name of names) {
      if (!exported.has(name)) fail(`${label}: imports "${name}" from ${match[2]}, which does not export it`)
    }
  }
  // A bare `name.member` needs `import * as name` or a local declaration. Comments and
  // string literals are stripped first: a doc comment reading "Route paths: nvm." is prose.
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  for (const namespace of ['nvm']) {
    if (!new RegExp(`\\b${namespace}\\.`).test(code)) continue
    const namespaced = new RegExp(`import\\s+\\*\\s+as\\s+${namespace}\\b`).test(code)
    const declared = new RegExp(`(?:const|let|var|function)\\s+${namespace}\\b`).test(code)
    if (!namespaced && !declared) fail(`${label}: uses "${namespace}." but never imports or declares it`)
  }
  // The other direction: a sibling export that this file calls without importing it.
  // That reads fine and fails only when the route runs, which is how `installInfo()`
  // shipped once without its import.
  const imported = new Set(
    [...text.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\/[^']+'/g)]
      .flatMap((match) => match[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop()))
      .filter(Boolean),
  )
  for (const sibling of siblingModules) {
    const siblingPath = join(root, sibling)
    if (!existsSync(siblingPath)) continue
    const exportsOfSibling = [...readFileSync(siblingPath, 'utf8').matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)].map((entry) => entry[1])
    for (const name of exportsOfSibling) {
      if (imported.has(name)) continue
      const declaredHere = new RegExp(`(?:function|const|let|var|class)\\s+${name}\\b`).test(code)
      if (declaredHere) continue
      if (new RegExp(`\\b${name}\\s*\\(`).test(code)) {
        fail(`${label}: calls ${name}() from ${sibling} without importing it`)
      }
    }
  }
}

// 9. An install script would run on the machine of anyone installing from Git.
if (manifest !== null && manifest.scripts !== undefined) {
  const scripts = Object.keys(manifest.scripts)
  for (const dangerous of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (scripts.includes(dangerous)) {
      notes.push(`package.json: the "${dangerous}" script runs on every install from Git`)
    }
  }
}

if (notes.length > 0) console.log(`note:\n  ${notes.join('\n  ')}`)

if (failures.length === 0) {
  console.log(`ok: ${relative(process.cwd(), root) || '.'} — ${files.length} files checked`)
  process.exit(0)
}
console.error(`failed: ${failures.length} problem(s)`)
for (const message of failures) console.error(`  - ${message}`)
process.exit(1)
