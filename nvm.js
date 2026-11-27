/**
 * nvm-windows access for the nvm switcher: where the install, the version store,
 * and the Node.js symlink are, which versions exist, which one the symlink
 * currently points at, and how to switch it.
 *
 * Only `node:` builtins are imported: a bundle installed from a local directory
 * resolves its bare imports from the bundle directory, where no Harness package
 * is present.
 *
 * Every function here is a plain data-in/data-out operation, so the browser
 * routes and the `node_version` agent tool share one implementation.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** A bare `MAJOR.MINOR.PATCH`, the only version shape nvm-windows stores. */
const VERSION = /^\d+\.\d+\.\d+$/

/** Directory name of one installed version, as nvm-windows names it. */
const VERSION_DIRECTORY = /^v(\d+\.\d+\.\d+)$/

/** nvm.exe `version` answers per executable path; it cannot change without a reinstall. */
const nvmVersions = new Map()

/** The official release index nvm-windows itself installs from. */
const RELEASES_URL = 'https://nodejs.org/dist/index.json'

/** How long one release index answer is reused, in milliseconds. */
const RELEASES_TTL = 10 * 60 * 1000

/** Newest releases kept from the index: enough for every realistic install, bounded for the wire. */
const RELEASES_LIMIT = 300

/** Last successful release index; `{ at, payload }`. */
let releasesCache = null

/**
 * Report the first value that is a non-empty string.
 * @param {...unknown} values candidate values, most authoritative first.
 * @returns the first non-empty string, otherwise undefined.
 */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Report whether a path exists, never throwing on a permission error.
 * @param {string | undefined} target absolute path.
 * @returns whether something is there.
 */
function exists(target) {
  if (typeof target !== 'string' || target === '') return false
  try {
    return existsSync(target)
  } catch {
    return false
  }
}

/**
 * Run one command and settle with its outcome instead of rejecting.
 * @param {string} executable absolute executable path.
 * @param {readonly string[]} args arguments, never shell-interpolated.
 * @param {{ cwd?: string, timeout?: number }} options working directory and deadline.
 * @returns {Promise<{ ok: boolean, output: string }>} outcome and combined text.
 */
function run(executable, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      { cwd: options.cwd, timeout: options.timeout ?? 60_000, windowsHide: true },
      (error, stdout, stderr) => {
        const text = [String(stdout ?? ''), String(stderr ?? '')]
          .map((part) => part.trim())
          .filter((part) => part !== '')
          .join('\n')
        resolve({ ok: error === null || error === undefined, output: text })
      },
    )
  })
}

/**
 * Read the `root:` and `path:` lines of nvm-windows' own settings file, the
 * authority the CLI itself uses.
 * @param {string} nvmHome candidate NVM_HOME.
 * @returns {{ root?: string, link?: string }} declared store and symlink paths.
 */
function readSettings(nvmHome) {
  try {
    const text = readFileSync(path.join(nvmHome, 'settings.txt'), 'utf8')
    const root = /^[ \t]*root[ \t]*:[ \t]*(.+)$/im.exec(text)?.[1]?.trim()
    const link = /^[ \t]*path[ \t]*:[ \t]*(.+)$/im.exec(text)?.[1]?.trim()
    return {
      ...(typeof root === 'string' && root !== '' ? { root } : {}),
      ...(typeof link === 'string' && link !== '' ? { link } : {}),
    }
  } catch {
    // A missing or unreadable settings file simply declares nothing.
    return {}
  }
}

/**
 * Resolve the three paths this plugin needs, preferring explicit configuration,
 * then the environment nvm-windows publishes, then nvm's own settings file, then
 * the installer's defaults.
 * @param {{ nvmHome?: string, nvmExe?: string, symlink?: string }} overrides patch config.
 * @returns {{ nvmHome: string, nvmExe: string | null, symlink: string, checked: string[] }} resolved paths and the homes tried.
 */
function resolveInstall(overrides = {}) {
  const environment = process.env
  const appData = firstText(environment.APPDATA, path.join(os.homedir(), 'AppData', 'Roaming'))
  const homes = [
    firstText(overrides.nvmHome),
    firstText(environment.NVM_HOME),
    firstText(environment.nvm_home),
    path.join(appData, 'nvm'),
    'C:\\nvm',
  ].filter((home, index, all) => typeof home === 'string' && home !== '' && all.indexOf(home) === index)
  const executableOf = (home) => path.join(home, 'nvm.exe')
  const homeWithExecutable = homes.find((home) => exists(executableOf(home)))
  const nvmHome = homeWithExecutable ?? homes.find(exists) ?? homes[0]
  const declaredExecutable = firstText(overrides.nvmExe)
  const nvmExe = declaredExecutable !== undefined && exists(declaredExecutable)
    ? declaredExecutable
    : homeWithExecutable === undefined ? null : executableOf(homeWithExecutable)
  const settings = readSettings(nvmHome)
  const store = settings.root !== undefined && exists(settings.root) ? settings.root : nvmHome
  const programFiles = firstText(environment.ProgramFiles, 'C:\\Program Files')
  const symlink = firstText(
    overrides.symlink,
    environment.NVM_SYMLINK,
    settings.link,
    path.join(programFiles, 'nodejs'),
  )
  return { nvmHome: store, nvmExe, symlink, checked: homes }
}

/**
 * Compare two `MAJOR.MINOR.PATCH` versions numerically.
 * @param {string} left first version.
 * @param {string} right second version.
 * @returns a negative, zero, or positive number, like a comparator.
 */
function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * List the versions nvm-windows has installed, newest first.
 * @param {string} nvmHome version store.
 * @returns {Array<{ version: string }>} installed versions.
 */
function listVersions(nvmHome) {
  let entries
  try {
    entries = readdirSync(nvmHome, { withFileTypes: true })
  } catch {
    // An unreadable store has no installed versions to report.
    return []
  }
  const versions = []
  for (const entry of entries) {
    const match = VERSION_DIRECTORY.exec(entry.name)
    if (match === null) continue
    let directory = false
    try {
      directory = statSync(path.join(nvmHome, entry.name)).isDirectory()
    } catch {
      directory = false
    }
    if (!directory) continue
    versions.push({ version: match[1] })
  }
  return versions.sort((left, right) => compareVersions(right.version, left.version))
}

/**
 * Ask nvm.exe for its own version, once per executable path.
 * @param {string} nvmExe executable path.
 * @param {string} nvmHome working directory for the query.
 * @returns {Promise<string | null>} the reported version, if any.
 */
async function nvmVersionOf(nvmExe, nvmHome) {
  if (nvmVersions.has(nvmExe)) return nvmVersions.get(nvmExe)
  const result = await run(nvmExe, ['version'], { cwd: nvmHome })
  const reported = result.ok ? firstText(result.output.split(/\r?\n/)[0]) ?? null : null
  nvmVersions.set(nvmExe, reported)
  return reported
}

/**
 * Read the version the Node.js symlink points at, without running anything.
 * @param {string} symlink NVM_SYMLINK directory.
 * @returns {string | null} the version, or null when the link is absent or unreadable.
 */
function linkedVersion(symlink) {
  try {
    const target = readlinkSync(symlink)
    const name = path.basename(path.resolve(path.dirname(symlink), target))
    return VERSION_DIRECTORY.exec(name)?.[1] ?? null
  } catch {
    // Not a link, not readable, or no such directory: no answer here.
    return null
  }
}

/**
 * Read the version of the Node.js executable the symlink exposes, as a last resort.
 * @param {string} symlink NVM_SYMLINK directory.
 * @returns {Promise<string | null>} the reported version, if any.
 */
async function executableVersion(symlink) {
  const executable = path.join(symlink, 'node.exe')
  if (!exists(executable)) return null
  const result = await run(executable, ['--version'], { timeout: 15_000 })
  return result.ok ? VERSION.exec(result.output.replace(/^v/, '').trim())?.[0] ?? null : null
}

/**
 * Read the complete nvm state the browser page and the agent tool work from.
 * @param {{ nvmHome?: string, nvmExe?: string, symlink?: string }} overrides patch config.
 * @returns {Promise<object>} the state payload.
 */
export async function readState(overrides = {}) {
  if (process.platform !== 'win32') {
    // No nvm-windows and no machine-wide link: report what the POSIX managers have,
    // and let the browser say that switching belongs to a shell instead.
    return {
      platform: process.platform,
      supported: false,
      available: false,
      nvmVersion: null,
      nvmHome: '',
      symlink: '',
      symlinkPresent: false,
      checked: [],
      current: null,
      versions: installedVersions(overrides).map((version) => ({ version })),
      // When this answer was read. Not stored anywhere: it describes the read, so a
      // persisted copy would only ever be a stale one.
      readAt: Date.now(),
    }
  }
  const install = resolveInstall(overrides)
  const versions = listVersions(install.nvmHome)
  const current = await currentVersionOf(install)
  const nvmVersion = install.nvmExe === null ? null : await nvmVersionOf(install.nvmExe, install.nvmHome)
  return {
    platform: process.platform,
    supported: true,
    available: install.nvmExe !== null,
    nvmVersion,
    nvmHome: install.nvmHome,
    symlink: install.symlink,
    symlinkPresent: exists(install.symlink),
    checked: install.checked,
    current,
    versions,
    // When this answer was read; see the POSIX branch above.
    readAt: Date.now(),
  }
}

/**
 * Read the version the machine is on: the symlink when it is readable, else
 * nvm's own answer, else the linked executable.
 * @param {{ nvmExe: string | null, nvmHome: string, symlink: string }} install resolved install.
 * @returns {Promise<string | null>} the version, if any.
 */
async function currentVersionOf(install) {
  return linkedVersion(install.symlink)
    ?? (install.nvmExe === null ? null : await nvmCurrent(install))
    ?? await executableVersion(install.symlink)
}

/**
 * Ask nvm.exe which version the machine is on.
 * @param {{ nvmExe: string | null, nvmHome: string }} install resolved install.
 * @returns {Promise<string | null>} the reported version, if any.
 */
async function nvmCurrent(install) {
  if (install.nvmExe === null) return null
  const result = await run(install.nvmExe, ['current'], { cwd: install.nvmHome, timeout: 20_000 })
  if (!result.ok) return null
  const match = /v?(\d+\.\d+\.\d+)/.exec(result.output)
  return match === null ? null : match[1]
}

/**
 * Switch the machine-wide Node.js version with `nvm use`.
 * @param {string} version exact installed version.
 * @param {{ nvmHome?: string, nvmExe?: string, symlink?: string }} overrides patch config.
 * @returns {Promise<object>} `{ ok: true, output, state }` or `{ ok: false, code, message }`.
 */
export async function switchTo(version, overrides = {}) {
  const install = resolveInstall(overrides)
  if (install.nvmExe === null) {
    return {
      ok: false,
      code: 'nvm-not-found',
      message: `nvm.exe was not found. Looked in: ${install.checked.join(', ')}`,
    }
  }
  const wanted = typeof version === 'string' ? version.replace(/^v/, '').trim() : ''
  if (!VERSION.test(wanted)) {
    return { ok: false, code: 'invalid-version', message: `not a Node.js version: ${String(version)}` }
  }
  const installed = listVersions(install.nvmHome)
  if (!installed.some((entry) => entry.version === wanted)) {
    return {
      ok: false,
      code: 'not-installed',
      message: installed.length === 0
        ? `no Node.js versions are installed in ${install.nvmHome}`
        : `Node.js ${wanted} is not installed; installed: ${installed.map((entry) => entry.version).join(', ')}`,
    }
  }
  const result = await run(install.nvmExe, ['use', wanted], { cwd: install.nvmHome, timeout: 120_000 })
  if (!result.ok) {
    return {
      ok: false,
      code: 'switch-failed',
      message: result.output === '' ? `nvm use ${wanted} failed` : result.output,
      output: result.output,
    }
  }
  return { ok: true, output: result.output, state: await readState(overrides) }
}

/**
 * Install one released version with `nvm install`.
 * @param {string} version released version, with or without the leading `v`.
 * @param {{ nvmHome?: string, nvmExe?: string, symlink?: string }} overrides patch config.
 * @returns {Promise<object>} `{ ok: true, output, state }` or `{ ok: false, code, message }`.
 */
export async function installVersion(version, overrides = {}) {
  const install = resolveInstall(overrides)
  if (install.nvmExe === null) {
    return {
      ok: false,
      code: 'nvm-not-found',
      message: `nvm.exe was not found. Looked in: ${install.checked.join(', ')}`,
    }
  }
  const wanted = typeof version === 'string' ? version.replace(/^v/, '').trim() : ''
  if (!VERSION.test(wanted)) {
    return { ok: false, code: 'invalid-version', message: `not a Node.js version: ${String(version)}` }
  }
  if (listVersions(install.nvmHome).some((entry) => entry.version === wanted)) {
    return { ok: false, code: 'already-installed', message: `Node.js ${wanted} is already installed` }
  }
  // A download plus extraction: nvm-windows needs minutes on a slow link.
  const result = await run(install.nvmExe, ['install', wanted], { cwd: install.nvmHome, timeout: 900_000 })
  if (!result.ok) {
    return {
      ok: false,
      code: 'install-failed',
      message: result.output === '' ? `nvm install ${wanted} failed` : result.output,
      output: result.output,
    }
  }
  // nvm-windows exits 0 for a version it cannot find ("not yet released"), so the
  // store — not the exit code — decides whether anything was installed.
  const state = await readState(overrides)
  if (!state.versions.some((entry) => entry.version === wanted)) {
    return {
      ok: false,
      code: 'install-failed',
      message: result.output === '' ? `nvm installed no Node.js ${wanted}` : result.output,
      output: result.output,
      state,
    }
  }
  return { ok: true, output: result.output, state }
}

/**
 * Remove one installed version with `nvm uninstall`. The linked version is
 * refused first: nvm-windows can leave the machine without a `node` otherwise.
 * @param {string} version installed version, with or without the leading `v`.
 * @param {{ nvmHome?: string, nvmExe?: string, symlink?: string }} overrides patch config.
 * @returns {Promise<object>} `{ ok: true, output, state }` or `{ ok: false, code, message }`.
 */
export async function uninstallVersion(version, overrides = {}) {
  const install = resolveInstall(overrides)
  if (install.nvmExe === null) {
    return {
      ok: false,
      code: 'nvm-not-found',
      message: `nvm.exe was not found. Looked in: ${install.checked.join(', ')}`,
    }
  }
  const wanted = typeof version === 'string' ? version.replace(/^v/, '').trim() : ''
  if (!VERSION.test(wanted)) {
    return { ok: false, code: 'invalid-version', message: `not a Node.js version: ${String(version)}` }
  }
  if (!listVersions(install.nvmHome).some((entry) => entry.version === wanted)) {
    return { ok: false, code: 'not-installed', message: `Node.js ${wanted} is not installed` }
  }
  if ((await currentVersionOf(install)) === wanted) {
    return {
      ok: false,
      code: 'in-use',
      message: `Node.js ${wanted} is the version in use; switch to another version before removing it`,
    }
  }
  const result = await run(install.nvmExe, ['uninstall', wanted], { cwd: install.nvmHome, timeout: 120_000 })
  if (!result.ok) {
    return {
      ok: false,
      code: 'uninstall-failed',
      message: result.output === '' ? `nvm uninstall ${wanted} failed` : result.output,
      output: result.output,
    }
  }
  return { ok: true, output: result.output, state: await readState(overrides) }
}

/**
 * Read the released stable Node.js versions that ship a Windows build, newest
 * first, from the official index nvm-windows installs from. Answers are cached
 * for {@link RELEASES_TTL} so opening the list does not hit the network twice.
 * @returns {Promise<object>} `{ source, fetchedAt, versions }`.
 */
export async function readReleases() {
  const now = Date.now()
  if (releasesCache !== null && now - releasesCache.at < RELEASES_TTL) return releasesCache.payload
  const response = await fetch(RELEASES_URL, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`nodejs.org answered HTTP ${response.status}`)
  const index = await response.json()
  const versions = []
  for (const entry of Array.isArray(index) ? index : []) {
    const version = String(entry?.version ?? '').replace(/^v/, '')
    // Stable releases only: nvm-windows installs the published Windows builds.
    if (!VERSION.test(version)) continue
    const files = Array.isArray(entry.files) ? entry.files : []
    if (!files.includes('win-x64-zip')) continue
    versions.push({
      version,
      date: typeof entry.date === 'string' ? entry.date : '',
      lts: typeof entry.lts === 'string' ? entry.lts : null,
    })
    if (versions.length >= RELEASES_LIMIT) break
  }
  const payload = {
    source: RELEASES_URL,
    fetchedAt: new Date(now).toISOString(),
    versions,
  }
  releasesCache = { at: now, payload }
  return payload
}

/**
 * Render one state as the text an agent reads.
 * @param {object} state {@link readState} payload.
 * @returns {string} the human-readable summary.
 */
export function describeState(state) {
  if (state.supported === false) {
    // No machine-wide link exists here: a version belongs to a shell, and saying
    // "nvm.exe was not found" would send a macOS user looking for a Windows tool.
    const found = Array.isArray(state.versions) ? state.versions.length : 0
    return `Machine-wide switching is unavailable on ${String(state.platform)}: there a Node.js version belongs to a `
      + 'shell (nvm alias default / fnm default / volta pin). '
      + (found === 0
        ? 'No installed version was found either.'
        : `${found} installed version(s) were found; launcher entries can pin one each.`)
  }
  if (!state.available) {
    return `nvm-windows was not found: no nvm.exe in ${state.checked.join(', ')}. `
      + 'Install nvm-windows, or set `nvmHome`/`nvmExe` in this plugin\'s configuration.'
  }
  const lines = [
    `nvm-windows ${state.nvmVersion ?? 'unknown'} · NVM_HOME ${state.nvmHome} · NVM_SYMLINK ${state.symlink}`,
    state.current === null
      ? 'No Node.js version is currently linked.'
      : `Currently using Node.js ${state.current}.`,
    state.versions.length === 0
      ? 'No installed versions.'
      : `Installed: ${state.versions.map((entry) => (entry.version === state.current ? `${entry.version} (in use)` : entry.version)).join(', ')}`,
  ]
  return lines.join('\n')
}

/**
 * The per-version layouts of the POSIX managers this workbench can read.
 *
 * macOS has no nvm-windows and no machine-wide `node` symlink, so a version is
 * just a directory that gets prepended to a child's `PATH`. These are the four
 * layouts worth knowing; a missing one is simply skipped.
 * @returns {Array<{ manager: string, list: string, bin: (serial: string) => string, prefixed: boolean }>} layouts, in order of preference.
 */
function posixLayouts() {
  const home = os.homedir()
  const nvmDirectory = firstText(process.env.NVM_DIR) ?? path.join(home, '.nvm')
  return [
    {
      manager: 'nvm',
      list: path.join(nvmDirectory, 'versions', 'node'),
      bin: (serial) => path.join(nvmDirectory, 'versions', 'node', `v${serial}`, 'bin'),
      prefixed: true,
    },
    {
      manager: 'fnm',
      list: path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
      bin: (serial) => path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions', `v${serial}`, 'installation', 'bin'),
      prefixed: true,
    },
    {
      manager: 'fnm',
      list: path.join(home, '.local', 'share', 'fnm', 'node-versions'),
      bin: (serial) => path.join(home, '.local', 'share', 'fnm', 'node-versions', `v${serial}`, 'installation', 'bin'),
      prefixed: true,
    },
    {
      manager: 'volta',
      list: path.join(home, '.volta', 'tools', 'image', 'node'),
      bin: (serial) => path.join(home, '.volta', 'tools', 'image', 'node', serial, 'bin'),
      prefixed: false,
    },
    {
      manager: 'asdf',
      list: path.join(home, '.asdf', 'installs', 'nodejs'),
      bin: (serial) => path.join(home, '.asdf', 'installs', 'nodejs', serial, 'bin'),
      prefixed: false,
    },
  ]
}

/**
 * Version names under one POSIX manager's store, without a leading `v`.
 * @param {{ list: string, prefixed: boolean }} layout the layout.
 * @returns {string[]} serials.
 */
function posixSerials(layout) {
  if (!exists(layout.list)) return []
  let names
  try {
    names = readdirSync(layout.list)
  } catch {
    return []
  }
  return names
    .map((name) => (layout.prefixed ? name.replace(/^v/i, '') : name))
    .filter((name) => /^\d+\.\d+\.\d+/.test(name))
}

/**
 * Sort serials newest first, by their numeric parts.
 * @param {string[]} serials candidates.
 * @returns {string[]} sorted serials.
 */
function sortSerials(serials) {
  const weight = (serial) => serial.split(/[.\-+]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  return [...serials].sort((left, right) => {
    const a = weight(left)
    const b = weight(right)
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return b[index] - a[index]
    }
    return 0
  })
}

/**
 * Whether this machine has a Node version manager at all, read synchronously.
 *
 * The launcher asks this before offering a pinned version: "no nvm" and "nvm has no
 * such version" are different problems, and only the second one is solved by
 * installing a version. Nothing here runs a process, so polling stays cheap.
 * @param {{ nvmHome?: string, nvmExe?: string, symlink?: string }} [overrides] patch config.
 * @returns {{ supported: boolean, available: boolean, managers: string[], home: string, symlink: string, versions: number, checked: string[] }} what exists.
 */
export function installInfo(overrides = {}) {
  if (process.platform !== 'win32') {
    // POSIX managers switch per shell; report whichever stores exist.
    const managers = []
    let versions = 0
    for (const layout of posixLayouts()) {
      const serials = posixSerials(layout)
      if (serials.length === 0) continue
      managers.push(layout.manager)
      versions += serials.length
    }
    return {
      supported: false,
      available: managers.length > 0,
      managers: [...new Set(managers)],
      home: '',
      symlink: '',
      versions,
      checked: [],
    }
  }
  const install = resolveInstall(overrides)
  const versions = listVersions(install.nvmHome).length
  return {
    supported: true,
    available: install.nvmExe !== null,
    managers: install.nvmExe === null ? [] : ['nvm-windows'],
    home: install.nvmHome,
    symlink: install.symlink,
    versions,
    checked: install.checked,
  }
}

/**
 * Versions the machine has installed, newest first, read synchronously.
 *
 * The launcher asks this to offer one version per entry; it starts no process.
 * Windows reads the nvm-windows store; macOS/Linux read whichever POSIX manager
 * layouts exist (nvm, fnm, volta, asdf).
 * @param {{ nvmHome?: string, nvmExe?: string, symlink?: string }} [overrides] patch config.
 * @returns {string[]} installed versions without a leading `v`.
 */
export function installedVersions(overrides = {}) {
  if (process.platform === 'win32') {
    return listVersions(resolveInstall(overrides).nvmHome).map((entry) => entry.version)
  }
  const found = new Set()
  for (const layout of posixLayouts()) {
    for (const serial of posixSerials(layout)) found.add(serial)
  }
  return sortSerials([...found])
}

/**
 * The version the Node.js symlink points at, read synchronously.
 * @param {{ nvmHome?: string, nvmExe?: string, symlink?: string }} [overrides] patch config.
 * @returns {string | null} the linked version without a leading `v`.
 */
export function currentLinkedVersion(overrides = {}) {
  if (process.platform !== 'win32') {
    // POSIX managers switch per shell, so there is no machine-wide link to read.
    return null
  }
  return linkedVersion(resolveInstall(overrides).symlink)
}

/**
 * The directory holding one installed version's executables.
 *
 * The launcher prepends it to a child's `PATH` so one entry can run on a version
 * other than the machine-wide one, without switching anything globally. Windows
 * returns the version directory (it holds `node.exe`); POSIX returns its `bin`
 * directory, which is what `PATH` needs.
 * @param {string} version installed version, with or without a leading `v`.
 * @param {{ nvmHome?: string, nvmExe?: string, symlink?: string }} [overrides] patch config.
 * @returns {{ directory: string, exists: boolean }} the version directory.
 */
export function versionDirectory(version, overrides = {}) {
  const serial = String(version).replace(/^v/i, '')
  if (process.platform === 'win32') {
    const install = resolveInstall(overrides)
    const directory = path.join(install.nvmHome, `v${serial}`)
    return { directory, exists: exists(directory) }
  }
  for (const layout of posixLayouts()) {
    if (!posixSerials(layout).includes(serial)) continue
    const directory = layout.bin(serial)
    if (exists(directory)) return { directory, exists: true }
  }
  return { directory: '', exists: false }
}

/**
 * The pure helpers, for the test suite only.
 *
 * Nothing in the plugin reads this object; it exists so `test/` can check the version
 * ordering that decides which release the panel calls "newest".
 */
export const internals = { compareVersions, sortSerials }
