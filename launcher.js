/**
 * The launcher: project entries the Workbench starts, watches, and stops.
 *
 * Entries live in this plugin's own JSON file under `$DSH_HOME/slim-workbench/`,
 * so the profile's patch file stays the user's. Runs live in this process: a
 * child is spawned with the shell (a command is user-authored text, so shell
 * interpretation is intended), its output is kept in a bounded ring buffer, and
 * stopping kills the whole tree, because `npm run dev` leaves grandchildren.
 *
 * Read-only on the project: this module reads `package.json`, lockfiles,
 * `.nvmrc`, and `git status`, and never writes inside a project directory,
 * never installs dependencies, and never runs a git command that mutates.
 *
 * Only `node:` builtins are imported: a bundle installed from a local directory
 * resolves bare imports from its own directory, where no Harness package exists.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** On-disk file version, so a later layout change can migrate instead of guess. */
const FILE_VERSION = 2

/** Output kept per run, in bytes. */
const LOG_LIMIT = 64 * 1024

/** The one output line returned inline with the state, for a run's row. */
const TAIL_LINES = 1

/** How many output lines the log view returns, and the ceiling a request may ask for. */
const LOG_VIEW_LINES = 200
const LOG_VIEW_LINES_MAX = 1000

/** Entry field limits. */
const NAME_LIMIT = 60
const CUSTOM_LIMIT = 500
const SCRIPT_LIMIT = 64
const PROFILE_LIMIT = 64

/** The package managers an entry may pick, and how a script is appended to each. */
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun']
/** Build tools a backend entry can start through. */
const BUILDERS = ['maven', 'gradle']

/** The stacks the workbench manages: one shared engine, two panes. */
const STACKS = ['frontend', 'backend']

/** The start goal each builder runs, by default. */
const BUILDER_GOALS = { maven: 'spring-boot:run', gradle: 'bootRun' }

/** Priority range: smaller starts earlier; `0` is the most urgent level. */
const PRIORITY_MIN = 0
const PRIORITY_MAX = 99
/** What a new entry gets, and what a missing value means: one step below the top. */
const PRIORITY_DEFAULT = 1

/** Port range accepted for readiness probes. */
const PORT_MIN = 1
const PORT_MAX = 65535

/** How often a starting run's port is probed, and how long that is worth doing. */
const READY_POLL_MS = 1000
const READY_TIMEOUT_MS = 3 * 60 * 1000
/** A backend entry builds before it listens, so it gets a longer budget. */
const READY_TIMEOUT_BACKEND_MS = 5 * 60 * 1000

/** Connect timeout for one port probe: a listening socket answers instantly. */
const PROBE_TIMEOUT_MS = 400

/** Project facts are re-read at most this often per directory. */
const PROJECT_CACHE_MS = 5000

/** Lockfiles, most specific first, with the package manager each implies. */
const LOCKFILES = [
  { name: 'pnpm-lock.yaml', pm: 'pnpm' },
  { name: 'yarn.lock', pm: 'yarn' },
  { name: 'bun.lockb', pm: 'bun' },
  { name: 'package-lock.json', pm: 'npm' },
]

/** Live runs by entry id. */
const runs = new Map()

/** Cached project reads by directory: `{ at, value }`. */
const projectCache = new Map()

/**
 * Report the first non-empty string.
 * @param {...unknown} values candidate values.
 * @returns {string | undefined} the first non-empty string.
 */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Run one command and settle with its outcome instead of rejecting.
 *
 * Asynchronous on purpose: `git status` on a large or network-backed checkout takes
 * seconds, and a synchronous call would stall this Host — and every request and tool
 * call sharing it — for that whole time.
 * @param {string} executable command name or absolute path.
 * @param {readonly string[]} args arguments, never shell-interpolated.
 * @param {{ cwd?: string, timeout?: number }} options working directory and deadline.
 * @returns {Promise<{ ok: boolean, output: string }>} outcome and combined text.
 */
function run(executable, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      { cwd: options.cwd, timeout: options.timeout ?? 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
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
 * Read a file as text without throwing.
 *
 * A leading byte-order mark is stripped: editors and PowerShell's `Set-Content`
 * write one, and `JSON.parse` rejects it.
 * @param {string} target file path.
 * @returns {string | null} the text, or null when unreadable.
 */
function readText(target) {
  try {
    return readFileSync(target, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

/**
 * Read the `scripts` object of one `package.json`, tolerating every failure.
 * @param {string} directory project directory.
 * @returns {{ exists: boolean, parsed: boolean, name: string | null, packageManager: string | null, scripts: Array<{ name: string, value: string }>, enginesNode: string | null }} the facts.
 */
function readPackageFacts(directory) {
  const text = readText(path.join(directory, 'package.json'))
  if (text === null) {
    return { exists: false, parsed: false, name: null, packageManager: null, scripts: [], enginesNode: null }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { exists: true, parsed: false, name: null, packageManager: null, scripts: [], enginesNode: null }
  }
  const scripts = []
  const source = parsed !== null && typeof parsed === 'object' ? parsed.scripts : undefined
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') scripts.push({ name: key, value })
    }
  }
  const engines = parsed !== null && typeof parsed === 'object' ? parsed.engines : undefined
  return {
    exists: true,
    parsed: true,
    name: firstText(parsed?.name) ?? null,
    packageManager: firstText(parsed?.packageManager) ?? null,
    scripts,
    enginesNode: firstText(engines?.node) ?? null,
  }
}

/**
 * Report the lockfile present in one directory.
 * @param {string} directory project directory.
 * @returns {{ name: string, pm: string } | null} the lockfile, if any.
 */
function detectLockfile(directory) {
  for (const candidate of LOCKFILES) {
    if (existsSync(path.join(directory, candidate.name))) return { name: candidate.name, pm: candidate.pm }
  }
  return null
}

/**
 * Read one project's git facts, read-only.
 * @param {string} directory project directory.
 * @returns {Promise<{ branch: string | null, changes: number | null, error: string | null }>} the facts.
 */
async function readGit(directory) {
  const options = { cwd: directory, timeout: 5000 }
  const head = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], options)
  if (!head.ok) return { branch: null, changes: null, error: head.output === '' ? 'git rev-parse failed' : head.output }
  const status = await run('git', ['status', '--porcelain'], options)
  const branch = head.output.split(/\r?\n/)[0].trim()
  return {
    branch: branch === '' ? null : branch,
    changes: status.ok ? status.output.split(/\r?\n/).filter((line) => line.trim() !== '').length : null,
    error: null,
  }
}

/**
 * Report whether a directory exists.
 * @param {string} target absolute path.
 * @returns {boolean} true when it is a directory.
 */
function isDirectory(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * The directory this plugin owns its data in.
 * @returns {string} `<DSH_HOME>/slim-workbench`.
 */
function dataDirectory() {
  const home = firstText(process.env.DSH_HOME) ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'slim-workbench')
}

/**
 * The launcher file path.
 * @returns {string} absolute path.
 */
function dataFile() {
  return path.join(dataDirectory(), 'launchers.json')
}

/**
 * Normalize a version string to `MAJOR.MINOR.PATCH`, or null.
 * @param {unknown} value candidate.
 * @returns {string | null} the version without a leading `v`.
 */
function normalizeVersion(value) {
  const text = firstText(value)
  if (text === undefined) return null
  const bare = text.replace(/^v/i, '')
  return /^\d+\.\d+\.\d+$/.test(bare) ? bare : null
}

/**
 * Normalize a port to an integer in range, or null.
 * @param {unknown} value candidate.
 * @returns {number | null} the port.
 */
function normalizePort(value) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(number) || number < PORT_MIN || number > PORT_MAX) return null
  return number
}

/**
 * Normalize a priority into `0…99`.
 *
 * A missing value becomes {@link PRIORITY_DEFAULT}; `0` is accepted as the most
 * urgent level but is never applied on its own, so an entry only sorts ahead of
 * the rest when its priority was set by hand.
 * @param {unknown} value candidate.
 * @returns {number} the priority.
 */
function normalizePriority(value) {
  if (value === null || value === undefined || value === '') return PRIORITY_DEFAULT
  const number = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(number)) return PRIORITY_DEFAULT
  return Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, Math.round(number)))
}

/**
 * Normalize one stored record, migrating the version-1 `command` shape.
 * @param {unknown} raw stored record.
 * @param {number} index position in the stored array, used for a stable order.
 * @returns {object | null} the entry, or null when it cannot be represented.
 */
function normalizeEntry(raw, index) {
  if (raw === null || typeof raw !== 'object') return null
  const name = firstText(raw.name)
  if (name === undefined) return null
  // projectPath is the project directory; a legacy cwd key is still honored.
  const projectPath = firstText(raw.projectPath) ?? firstText(raw.cwd) ?? os.homedir()
  const legacy = firstText(raw.command)
  const stack = STACKS.includes(raw.stack) ? raw.stack : 'frontend'
  const builder = BUILDERS.includes(raw.builder) ? raw.builder : null
  const goal = firstText(raw.goal) ?? null
  const profile = firstText(raw.profile) ?? null
  const pm = PACKAGE_MANAGERS.includes(raw.pm) ? raw.pm : null
  const script = firstText(raw.script) ?? null
  const custom = firstText(raw.customCommand) ?? null
  let kind = raw.kind === 'script' ? 'script' : 'custom'
  if (kind === 'script' && stack === 'frontend' && (pm === null || script === null)) kind = 'custom'
  // `??` yields undefined when both are nullish, which would slip past the guard below
  // and store an entry whose command is the empty string.
  const customCommand = kind === 'custom' ? custom ?? legacy ?? null : custom
  if (kind === 'custom' && customCommand === null) return null
  return {
    id: firstText(raw.id) ?? randomUUID(),
    name: name.slice(0, NAME_LIMIT),
    projectPath,
    stack,
    kind,
    builder: stack === 'backend' ? builder : null,
    goal: stack === 'backend' && kind === 'script' ? goal ?? (builder === null ? null : BUILDER_GOALS[builder]) : null,
    profile: stack === 'backend' ? profile : null,
    pm,
    script: kind === 'script' ? script : null,
    customCommand: kind === 'custom' ? customCommand : null,
    nodeVersion: normalizeVersion(raw.nodeVersion),
    port: normalizePort(raw.port),
    priority: normalizePriority(raw.priority),
    // Whether this entry takes part in a batch start. Entries written before this
    // field existed participate by default, and a legacy atch key is still honored.
    batchEnabled: (raw.batchEnabled ?? raw.batch) !== false,
    facts: normalizeFacts(raw.facts),
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now() + index,
  }
}

/**
 * Read the stored entries, dropping anything unusable and preserving file order.
 * @returns {Array<object>} stored entries.
 */
function readEntries() {
  const text = readText(dataFile())
  if (text === null) return []
  let stored
  try {
    stored = JSON.parse(text)
  } catch {
    return []
  }
  const entries = Array.isArray(stored?.entries) ? stored.entries : []
  return entries.flatMap((entry, index) => {
    const normalized = normalizeEntry(entry, index)
    return normalized === null ? [] : [normalized]
  })
}

/**
 * Replace the stored entries, atomically.
 * @param {Array<object>} entries the complete list.
 * @returns {void}
 */
function writeEntries(entries) {
  mkdirSync(dataDirectory(), { recursive: true })
  const text = `${JSON.stringify({ version: FILE_VERSION, entries }, null, 2)}\n`
  const temporary = `${dataFile()}.tmp`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, dataFile())
}

/** Tail of the mutation queue: writes are serialized so two callers cannot interleave. */
let mutations = Promise.resolve()

/**
 * Run one read-modify-write of the data file without interleaving another.
 *
 * Every mutation reads the whole file, decides, and writes it back; two of them at
 * once (two browser tabs, say) would otherwise lose one update. This serializes them
 * inside this process, which is where the panel's requests all arrive.
 * @template T
 * @param {() => Promise<T>} task the mutation.
 * @returns {Promise<T>} the task's own result.
 */
function serialize(task) {
  const next = mutations.then(task, task)
  // A failed mutation must not poison the queue for the next one.
  mutations = next.then(() => undefined, () => undefined)
  return next
}

/**
 * The command an entry runs, composed from the remembered choice.
 * @param {object} entry the entry.
 * @returns {string} the shell command.
 */
function commandOf(entry) {
  if (entry.kind === 'script') {
    if (entry.stack === 'backend') {
      if (entry.builder === null) return entry.customCommand ?? ''
      const goal = entry.goal ?? BUILDER_GOALS[entry.builder] ?? ''
      return `${buildProgramOf(entry)} ${goal}`
    }
    if (entry.pm !== null && entry.script !== null) return `${entry.pm} run ${entry.script}`
  }
  return entry.customCommand ?? ''
}

/**
 * The Maven/Gradle program one backend entry runs.
 *
 * A project's own wrapper wins only when it is complete: a half-copied `mvnw` fails
 * before it ever reaches Maven, and the global executable is what such a machine has.
 * @param {{ builder: 'maven' | 'gradle', projectPath: string }} entry the backend entry.
 * @returns {string} the program to run, as the shell resolves it.
 */
function buildProgramOf(entry) {
  const windows = process.platform === 'win32'
  const present = (relative) => existsSync(path.join(entry.projectPath, relative))
  if (entry.builder === 'gradle') {
    const wrapper = windows ? 'gradlew.bat' : 'gradlew'
    return present(wrapper) ? (windows ? wrapper : './gradlew') : 'gradle'
  }
  const wrapper = windows ? 'mvnw.cmd' : 'mvnw'
  const complete = present(wrapper) && present(path.join('.mvn', 'wrapper', 'maven-wrapper.properties'))
  return complete ? (windows ? wrapper : './mvnw') : 'mvn'
}

/**
 * A fresh bounded output buffer.
 * @returns {{ chunks: string[], size: number }} the buffer.
 */
function createLog() {
  return { chunks: [], size: 0 }
}

/**
 * Append output, keeping the buffer under {@link LOG_LIMIT}.
 * @param {{ chunks: string[], size: number }} log the buffer.
 * @param {string} chunk new text.
 * @returns {void}
 */
function appendLog(log, chunk) {
  if (chunk === '') return
  log.chunks.push(chunk)
  log.size += chunk.length
  while (log.size > LOG_LIMIT && log.chunks.length > 1) {
    const dropped = log.chunks.shift()
    log.size -= dropped === undefined ? 0 : dropped.length
  }
}
/**
 * Drop terminal colour/control sequences from captured output.
 *
 * Dev servers colour their logs (`\u001b[32m…\u001b[39m`); rendered as text those
 * escapes are noise, so a row's tail is stripped before it leaves the Host.
 * @param {string} text raw output.
 * @returns {string} the same text without ANSI sequences.
 */
function stripAnsi(text) {
  // CSI colour/style sequences, OSC hyperlinks/titles, and lone carriage returns.
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\r(?!\n)/g, '')
}

/**
 * The last lines of one buffer, colour codes stripped.
 * @param {{ chunks: string[] } | undefined} log the buffer.
 * @param {number} count how many lines to keep.
 * @param {boolean} [trim] whether to drop blank lines and indentation, as a row's tail does.
 * @returns {string} the lines.
 */
function logLines(log, count, trim = true) {
  const text = log === undefined ? '' : log.chunks.join('')
  // A trailing newline would otherwise occupy one of the requested lines.
  const stripped = stripAnsi(text).replace(/\r\n/g, '\n').replace(/\n+$/, '')
  const lines = trimmedLines(stripped, trim)
  return lines.slice(Math.max(0, lines.length - count)).join('\n').trim()
}

/**
 * Split output into lines, optionally dropping blank ones and indentation.
 * @param {string} text the output.
 * @param {boolean} trim whether to trim each line and drop the empty ones.
 * @returns {string[]} the lines.
 */
function trimmedLines(text, trim) {
  const lines = text.split('\n')
  return trim ? lines.map((line) => line.trim()).filter((line) => line !== '') : lines
}

/**
 * The last {@link TAIL_LINES} lines of one buffer.
 * @param {{ chunks: string[] } | undefined} log the buffer.
 * @returns {string} the tail.
 */
function logTail(log) {
  return logLines(log, TAIL_LINES)
}

/**
 * The first non-internal IPv4 address of this machine.
 * @returns {string | null} the address, if any.
 */
function lanAddress() {
  const interfaces = os.networkInterfaces()
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (/loopback|vethernet|virtual|vmware|hyper-v/i.test(name)) continue
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

/**
 * Find the port a dev server announced in its own output.
 * @param {string} text output so far.
 * @returns {number | null} the port, if one is recognizable.
 */
function detectPort(text) {
  const withScheme = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/i.exec(text)
  if (withScheme !== null) return normalizePort(withScheme[1])
  const bare = /\blocalhost:(\d{2,5})\b/i.exec(text)
  if (bare !== null) return normalizePort(bare[1])
  return null
}

/**
 * Probe one loopback port: connect only, never listen.
 *
 * Both loopback families are tried: a dev server configured as `::1` (or one that
 * resolved `localhost` to IPv6) accepts on `::1` only, and an IPv4-only probe would
 * leave the row "starting" until its budget ran out.
 * @param {number} port TCP port.
 * @returns {Promise<boolean>} true when something accepts connections.
 */
export function probePort(port) {
  return probeHost(port, '127.0.0.1').then((inUse) => inUse || probeHost(port, '::1'))
}

/**
 * Probe one loopback address.
 * @param {number} port TCP port.
 * @param {string} host loopback address.
 * @returns {Promise<boolean>} true when it accepts a connection.
 */
function probeHost(port, host) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (inUse) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(inUse)
    }
    // A destroyed socket can still emit its own error; that is not worth a crash.
    socket.on('error', () => { finish(false) })
    socket.setTimeout(PROBE_TIMEOUT_MS, () => { finish(false) })
    socket.once('connect', () => { finish(true) })
    socket.connect(port, host)
  })
}

/**
 * Mark a run ready once its port answers, and publish the two links.
 * @param {object} run the run to update.
 * @param {number | null} port configured or detected port.
 * @returns {void}
 */
function startReadinessWatch(run, port) {
  if (run.readyTimer !== null) clearInterval(run.readyTimer)
  if (port === null) {
    run.readyTimer = null
    return
  }
  const target = normalizePort(port)
  if (target === null) {
    run.readyTimer = null
    return
  }
  const startedAt = Date.now()
  run.port = target
  run.readyTimer = setInterval(() => {
    if (run.child === null) {
      clearInterval(run.readyTimer)
      run.readyTimer = null
      return
    }
    if (Date.now() - startedAt > (run.readyBudget ?? READY_TIMEOUT_MS)) {
      clearInterval(run.readyTimer)
      run.readyTimer = null
      return
    }
    void probePort(target).then((inUse) => {
      if (!inUse || run.readyAt !== null) return
      run.readyAt = Date.now()
      const lan = lanAddress()
      run.url = `http://localhost:${target}`
      run.lanUrl = lan === null ? null : `http://${lan}:${target}`
      if (run.readyTimer !== null) {
        clearInterval(run.readyTimer)
        run.readyTimer = null
      }
    })
  }, READY_POLL_MS)
}

/**
 * Stop one run's whole process tree.
 *
 * Both platforms need the grandchildren, not just the shell: `npm run dev` spawns
 * `node`, and signalling only the shell orphans it.
 *
 * - Windows: `taskkill /T` walks the tree, which must happen while the shell is
 *   still alive (killing the shell first — what `child.kill()` does — loses the walk).
 * - POSIX: the child is spawned `detached`, so it leads its own process group and
 *   signalling the negative pid reaches the shell and everything it started.
 *   SIGTERM first, SIGKILL if it is still there after a grace period.
 * @param {object} run the run to terminate.
 * @returns {Promise<void>} settles when the kill was attempted.
 */
function terminate(run) {
  const child = run.child
  const pid = run.pid
  if (run.readyTimer !== null) {
    clearInterval(run.readyTimer)
    run.readyTimer = null
  }
  run.stopped = true
  run.child = null
  run.endedAt = Date.now()
  appendLog(run.log, '\n[launcher] stopped\n')
  if (child === null) return Promise.resolve()
  if (process.platform === 'win32') {
    if (typeof pid !== 'number') {
      try {
        child.kill()
      } catch {
        // Already gone: nothing left to signal.
      }
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => { resolve() })
    })
  }
  if (typeof pid !== 'number') {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
    return Promise.resolve()
  }
  const signal = (name) => {
    try {
      process.kill(-pid, name)
    } catch {
      try {
        child.kill(name)
      } catch {
        // Already gone.
      }
    }
  }
  signal('SIGTERM')
  const escalation = setTimeout(() => { signal('SIGKILL') }, 4000)
  if (typeof escalation.unref === 'function') escalation.unref()
  return Promise.resolve()
}

/**
 * Read one backend project's start facts, read-only.
 *
 * A backend entry composes its command from a build tool instead of a package
 * manager, so it needs what the build declares: which tool exists, which Spring
 * profiles the project ships, and which port it will listen on.
 * @param {string} directory project directory.
 * @returns {object} the backend facts and the warnings they imply.
 */
function inspectBackend(directory) {
  const exists = (relative) => existsSync(path.join(directory, relative))
  const read = (relative) => readText(path.join(directory, relative))
  const warnings = []

  const pom = read('pom.xml')
  const gradle = read('build.gradle') ?? read('build.gradle.kts')
  const wrapperProperties = exists('.mvn/wrapper/maven-wrapper.properties')
  const wrapperScript = exists(process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw')
  const gradlewScript = exists(process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')

  // The project's own artifactId: the parent block declares its own, which is not ours.
  const ownPom = pom === null ? null : pom.replace(/<parent>[\s\S]*?<\/parent>/, '')
  const artifactId = ownPom === null ? null : /<artifactId>([^<]+)<\/artifactId>/.exec(ownPom)?.[1] ?? null
  const property = (name) => ownPom === null ? null : new RegExp('<' + name + '>([^<]+)</' + name + '>').exec(ownPom)?.[1] ?? null
  const resolve = (value) => {
    if (value === null) return null
    const reference = /^\$\{([^}]+)\}$/.exec(value)
    return reference === null ? value : property(reference[1])
  }
  const javaVersion = resolve(
    property('java.version')
    ?? property('jdk.version')
    ?? property('maven.compiler.source')
    ?? property('maven.compiler.target')
    ?? /<release>([^<]+)<\/release>/.exec(ownPom ?? '')?.[1]
    ?? /<source>([^<]+)<\/source>/.exec(ownPom ?? '')?.[1]
    ?? null,
  )

  // Spring Boot reads application[-<profile>].{yaml,yml,properties} from the classpath.
  const resources = path.join(directory, 'src', 'main', 'resources')
  const profiles = []
  const profilePorts = {}
  let basePort = null
  let activeProfile = null
  /**
   * The port a Spring config file will listen on.
   *
   * port: appears many times in these files (redis, rabbitmq, mail, a second HTTP
   * connector). Only the shallowest one inside the top-level server block is the
   * application's own, so indentation decides, not the order of appearance.
   */
  const portOf = (content) => {
    if (content === null) return null
    const properties = /^server\.port\s*=\s*(\d{2,5})\s*$/m.exec(content)
    if (properties !== null) return Number.parseInt(properties[1], 10)
    const lines = content.split(/\r?\n/)
    let inside = false
    let best = null
    for (const line of lines) {
      if (/^server:\s*(?:#.*)?$/.test(line)) {
        inside = true
        continue
      }
      if (!inside) continue
      if (/^\S/.test(line) && !/^\s*#/.test(line)) break
      const match = /^(\s+)port:\s*(\d{2,5})\s*(?:#.*)?$/.exec(line)
      if (match === null) continue
      const indent = match[1].length
      if (best === null || indent < best.indent) best = { indent, port: Number.parseInt(match[2], 10) }
    }
    return best === null ? null : best.port
  }
  const readSettings = (file) => {
    const content = readText(path.join(resources, file))
    if (content === null) return null
    const active = /^[ \t]*active:\s*([A-Za-z0-9_,.-]+)\s*(?:#.*)?$/m.exec(content)?.[1]
      ?? /^spring\.profiles\.active\s*=\s*([A-Za-z0-9_,.-]+)\s*$/m.exec(content)?.[1]
    return { port: portOf(content), active: active ?? null }
  }
  const baseSettings = readSettings('application.yaml') ?? readSettings('application.yml') ?? readSettings('application.properties')
  if (baseSettings !== null) {
    basePort = baseSettings.port
    activeProfile = baseSettings.active
  }
  let names = []
  try {
    names = readdirSync(resources)
  } catch {
    names = []
  }
  for (const fileName of names) {
    const match = /^application-([A-Za-z0-9_.-]+)\.(?:ya?ml|properties)$/.exec(fileName)
    if (match === null) continue
    profiles.push(match[1])
    const settings = readSettings(fileName)
    if (settings?.port !== null && settings?.port !== undefined) profilePorts[match[1]] = settings.port
  }
  profiles.sort()

  if (pom === null && gradle === null) {
    warnings.push({ code: 'no-backend-build', level: 'notice', text: '没找到 pom.xml 或 build.gradle：请改用自定义命令' })
  }
  if (pom !== null && wrapperScript && !wrapperProperties) {
    warnings.push({ code: 'wrapper-incomplete', level: 'notice', text: 'mvnw 缺少 .mvn/wrapper 配置，启动会用全局 mvn' })
  }
  if (basePort === null) {
    warnings.push({ code: 'no-server-port', level: 'notice', text: '配置里没读到 server.port：端口请自己填' })
  }
  if (profiles.length === 0 && pom !== null) {
    warnings.push({ code: 'no-profiles', level: 'info', text: '没有 application-<profile> 配置文件：只用默认配置启动' })
  }

  return {
    maven: { present: pom !== null, wrapper: wrapperProperties, artifactId, javaVersion },
    gradle: { present: gradle !== null, wrapper: gradlewScript },
    profiles,
    profilePorts,
    activeProfile,
    serverPort: basePort,
    warnings,
  }
}

/**
 * Normalize the stored inspection snapshot of one entry.
 *
 * Reading a project is done when the entry is saved or refreshed on demand, so
 * the list needs no disk or git access. This is what a stored snapshot looks
 * like after being read back.
 * @param {unknown} raw stored value.
 * @returns {{ at: number | null, branch: string | null, changes: number | null, warnings: Array<object> } | null} the snapshot.
 */
function normalizeFacts(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.flatMap((warning) => {
      if (warning === null || typeof warning !== 'object') return []
      const code = firstText(warning.code)
      if (code === undefined) return []
      const level = warning.level === 'block' || warning.level === 'notice' ? warning.level : 'info'
      return [{ code, level, text: firstText(warning.text) ?? code }]
    })
    : []
  return {
    at: Number.isFinite(raw.at) ? Number(raw.at) : null,
    branch: firstText(raw.branch) ?? null,
    changes: Number.isFinite(raw.changes) ? Number(raw.changes) : null,
    warnings,
  }
}

/**
 * Read one directory's facts, optionally ignoring the short-lived cache.
 * @param {string} directory project directory.
 * @param {boolean} [fresh] bypass the cache, for an explicit refresh.
 * @returns {Promise<object>} the facts.
 */
async function projectFacts(directory, fresh = false) {
  if (fresh) projectCache.delete(directory)
  const cached = projectCache.get(directory)
  if (cached !== undefined && Date.now() - cached.at < PROJECT_CACHE_MS) return cached.value
  const warnings = []
  const directoryExists = isDirectory(directory)
  const pkg = readPackageFacts(directory)
  const lockfile = detectLockfile(directory)
  const nvmrc = readText(path.join(directory, '.nvmrc'))
  const git = directoryExists ? await readGit(directory) : { branch: null, changes: null, error: null }
  const hasModules = existsSync(path.join(directory, 'node_modules'))
  if (!directoryExists) {
    warnings.push({ code: 'missing-directory', level: 'block', text: `目录不存在或无法访问：${directory}` })
  } else {
    if (!pkg.exists) warnings.push({ code: 'no-package-json', level: 'notice', text: '该目录没有 package.json：脚本下拉为空，可直接写自定义命令' })
    else if (!pkg.parsed) warnings.push({ code: 'package-json-unparsable', level: 'notice', text: 'package.json 解析失败：不读它的 scripts，请用自定义命令' })
    if (pkg.exists && !hasModules) warnings.push({ code: 'no-node-modules', level: 'notice', text: '依赖尚未安装（插件不会替你装）' })
    if (git.error !== null) warnings.push({ code: 'no-git', level: 'info', text: '这里不是 git 仓库（或 git 不可用），不显示分支' })
  }
  const value = {
    directory,
    exists: directoryExists,
    projectName: pkg.name,
    hasPackageJson: pkg.exists,
    parsed: pkg.parsed,
    scripts: pkg.scripts,
    packageManagerField: pkg.packageManager,
    enginesNode: pkg.enginesNode,
    nvmrc: firstText(nvmrc ?? undefined) ?? null,
    lockfile,
    git,
    hasNodeModules: hasModules,
    backend: directoryExists ? inspectBackend(directory) : null,
    warnings,
  }
  projectCache.set(directory, { at: Date.now(), value })
  return value
}

/** Facts about package.json and node_modules that mean nothing to a backend entry. */
const FRONTEND_ONLY_WARNINGS = new Set(['no-package-json', 'package-json-unparsable', 'no-node-modules'])

/**
 * Inspect one entry's project and return the snapshot stored with it.
 *
 * This runs when an entry is saved or refreshed by hand, never on every state
 * read: opening the panel must not walk every project's directory or spawn git.
 * @param {object} entry the entry.
 * @param {{ node?: object }} context host-supplied facts.
 * @param {boolean} [fresh] bypass the fact cache.
 * @returns {Promise<{ at: number, branch: string | null, changes: number | null, warnings: Array<object> }>} the snapshot.
 */
async function snapshotOf(entry, context, fresh = false) {
  const facts = await projectFacts(entry.projectPath, fresh)
  const backend = entry.stack === 'backend'
  const warnings = facts.warnings.filter((warning) => !backend || !FRONTEND_ONLY_WARNINGS.has(warning.code))
  // The build tool has its own facts: which Maven/Gradle exists, which profiles ship.
  if (backend) {
    for (const warning of facts.backend?.warnings ?? []) warnings.push(warning)
  }
  if (entry.kind === 'script' && facts.hasPackageJson && facts.parsed
    && entry.script !== null && !facts.scripts.some((candidate) => candidate.name === entry.script)) {
    warnings.push({ code: 'script-missing', level: 'block', text: `脚本 ${entry.script} 已不存在：请重新选择` })
  }
  if (entry.pm !== null && facts.lockfile !== null && facts.lockfile.pm !== entry.pm) {
    warnings.push({
      code: 'pm-mismatch',
      level: 'notice',
      text: `这条用 ${entry.pm}，但目录里是 ${facts.lockfile.name}`,
    })
  }
  if (entry.nodeVersion !== null && typeof context.node?.installed === 'function') {
    const installed = context.node.installed()
    const info = typeof context.node?.install === 'function' ? context.node.install() : null
    if (info !== null && info.available === false) {
      warnings.push({
        code: 'nvm-absent',
        level: 'notice',
        text: `这台机器没装 nvm：锁定的 v${entry.nodeVersion} 不生效，会用系统默认 Node`,
      })
    } else if (!installed.includes(entry.nodeVersion)) {
      warnings.push({
        code: 'node-missing',
        level: 'block',
        text: `锁定版本 v${entry.nodeVersion} 未安装：先到 Node.js 系统安装或改回跟随工作台`,
      })
    }
  }
  return {
    at: Date.now(),
    branch: facts.git.branch ?? null,
    changes: facts.git.changes ?? null,
    warnings,
  }
}

/**
 * Read one entry's runtime facts for the browser.
 * @param {object} entry the entry.
 * @returns {object} the run view.
 */
function runView(entry) {
  const run = runs.get(entry.id)
  const branch = entry.facts?.branch ?? null
  const changes = entry.facts?.changes ?? null
  if (run === undefined) {
    return {
      status: 'stopped',
      phase: 'idle',
      startedAt: null,
      endedAt: null,
      code: null,
      url: null,
      lanUrl: null,
      actualNode: null,
      tail: '',
      branch,
      changes,
    }
  }
  const status = run.child !== null ? 'running' : run.stopped ? 'stopped' : 'exited'
  const phase = run.readyAt !== null ? 'ready' : status === 'running' ? 'starting' : status
  return {
    status,
    phase,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    code: run.code,
    url: run.url,
    lanUrl: run.lanUrl,
    // The port this run actually uses: configured, or detected from its output.
    // `entry.port` stays the user's own configuration, so the editor prefills it.
    runPort: run.port ?? null,
    actualNode: run.actualNode,
    tail: logTail(run.log),
    branch,
    changes,
  }
}

/**
 * The complete launcher payload: entries, runtime facts, warnings, and the
 * installed Node.js versions the form offers.
 *
 * Every stored entry carries its own inspection snapshot, so this reads one JSON
 * file plus the installed-version list — nothing inside a project directory. An entry
 * saved before snapshots existed is inspected here without being written back: a GET
 * must not mutate the data file (see {@link migrateEntries} for the one-time stamp).
 * @param {{ defaultProjectPath: string, node?: object }} context host-supplied facts.
 * @returns {Promise<object>} the state payload.
 */
export async function readLauncherState(context) {
  const stored = readEntries()
  const entries = await Promise.all(stored.map(async (entry) => (
    entry.facts !== null ? entry : { ...entry, facts: await snapshotOf(entry, context) }
  )))
  const installed = typeof context.node?.installed === 'function' ? context.node.installed() : []
  const nvm = typeof context.node?.install === 'function' ? context.node.install() : null
  return {
    defaultProjectPath: context.defaultProjectPath ?? context.defaultCwd ?? '',
    dataFile: dataFile(),
    lanAddress: lanAddress(),
    nvm,
    nodeVersions: installed,
    currentVersion: typeof context.node?.current === 'function' ? context.node.current() : null,
    entries: entries.map((entry) => {
      const warnings = [...(entry.facts?.warnings ?? [])]
      // Kept live: installing or removing a version changes this without touching the entry.
      if (entry.nodeVersion !== null && !warnings.some((warning) => warning.code === 'node-missing')) {
        if (nvm !== null && nvm.available === false) {
          // No manager at all: the pin cannot apply, and "version not installed" would
          // send the user looking for a version that could never be used here.
          warnings.push({
            code: 'nvm-absent',
            level: 'notice',
            text: `这台机器没装 nvm：锁定的 v${entry.nodeVersion} 不生效，会用系统默认 Node`,
          })
        } else if (installed.length > 0 && !installed.includes(entry.nodeVersion)) {
          warnings.push({
            code: 'node-missing',
            level: 'block',
            text: `锁定版本 v${entry.nodeVersion} 未安装：先到 Node.js 系统安装或改回跟随工作台`,
          })
        }
      }
      return {
        ...entry,
        command: commandOf(entry),
        ...runView(entry),
        warnings,
        inspectedAt: entry.facts?.at ?? null,
      }
    }),
  }
}

/**
 * Validate one submitted entry.
 * @param {unknown} input the request body.
 * @param {{ defaultProjectPath: string, node?: object }} context host-supplied facts.
 * @returns {Promise<{ ok: true, value: object } | { ok: false, code: string, message: string }>} the entry or a refusal.
 */
async function validateEntry(input, context) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const name = firstText(source.name)
  const projectPath = firstText(source.projectPath) ?? firstText(source.cwd) ?? context.defaultProjectPath ?? context.defaultCwd
  if (name === undefined) return { ok: false, code: 'invalid-name', message: 'a name is required' }
  if (name.length > NAME_LIMIT) return { ok: false, code: 'invalid-name', message: `a name is limited to ${NAME_LIMIT} characters` }
  if (!path.isAbsolute(projectPath)) return { ok: false, code: 'invalid-directory', message: `the directory must be an absolute path: ${projectPath}` }
  if (!isDirectory(projectPath)) return { ok: false, code: 'missing-directory', message: `the directory does not exist: ${projectPath}` }

  const stack = STACKS.includes(source.stack) ? source.stack : 'frontend'
  const kind = source.kind === 'script' ? 'script' : 'custom'
  const builder = BUILDERS.includes(source.builder) ? source.builder : null
  const profile = firstText(source.profile) ?? null
  const pm = PACKAGE_MANAGERS.includes(source.pm) ? source.pm : null
  const script = firstText(source.script) ?? null
  const customCommand = firstText(source.customCommand) ?? null

  if (kind === 'script' && stack === 'backend') {
    if (builder === null) return { ok: false, code: 'invalid-builder', message: '请先选择构建工具（Maven / Gradle）' }
    const facts = inspectBackend(projectPath)
    if (builder === 'maven' && !facts.maven.present) {
      return { ok: false, code: 'no-pom', message: '该目录没有 pom.xml：Maven 项目才能这样启动' }
    }
    if (builder === 'gradle' && !facts.gradle.present) {
      return { ok: false, code: 'no-gradle', message: '该目录没有 build.gradle(.kts)：Gradle 项目才能这样启动' }
    }
    if (profile !== null && profile.length > PROFILE_LIMIT) {
      return { ok: false, code: 'invalid-profile', message: `a profile name is limited to ${PROFILE_LIMIT} characters` }
    }
  } else if (kind === 'script') {
    if (pm === null) return { ok: false, code: 'invalid-pm', message: '请先选择包管理器（npm / pnpm / yarn / bun）' }
    if (script === null) return { ok: false, code: 'invalid-script', message: '请先选择启动脚本' }
    if (script.length > SCRIPT_LIMIT) return { ok: false, code: 'invalid-script', message: `a script name is limited to ${SCRIPT_LIMIT} characters` }
    const facts = await projectFacts(projectPath)
    if (!facts.hasPackageJson) {
      return { ok: false, code: 'no-package-json', message: '该目录没有 package.json：请改用自定义命令' }
    }
    if (!facts.scripts.some((candidate) => candidate.name === script)) {
      return { ok: false, code: 'script-missing', message: `package.json 里没有脚本 ${script}` }
    }
  } else if (customCommand === null) {
    return { ok: false, code: 'invalid-command', message: '请填写要执行的命令' }
  } else if (customCommand.length > CUSTOM_LIMIT) {
    return { ok: false, code: 'invalid-command', message: `a command is limited to ${CUSTOM_LIMIT} characters` }
  }

  const nodeVersion = normalizeVersion(source.nodeVersion)
  if (nodeVersion !== null && typeof context.node?.installed === 'function'
    && !context.node.installed().includes(nodeVersion)) {
    return { ok: false, code: 'node-not-installed', message: `Node.js v${nodeVersion} 没有安装` }
  }

  const declaredId = firstText(source.id)
  return {
    ok: true,
    value: {
      ...declaredId === undefined ? {} : { id: declaredId },
      name,
      projectPath,
      kind,
      stack,
      builder: stack === 'backend' ? builder : null,
      goal: stack === 'backend' && kind === 'script' ? (builder === null ? null : BUILDER_GOALS[builder]) : null,
      profile: stack === 'backend' ? profile : null,
      pm: stack === 'backend' ? null : pm,
      script: kind === 'script' && stack !== 'backend' ? script : null,
      customCommand: kind === 'custom' ? customCommand : null,
      nodeVersion,
      port: normalizePort(source.port),
      // The panel sends this back on every save, so it round-trips; a request that omits it
      // (a hand-made POST, an older client) must still mean "keep what is stored", because
      // silently resetting a value the user set would be a data loss nobody asked for.
      priority: source.priority === undefined ? undefined : normalizePriority(source.priority),
      batchEnabled: source.batchEnabled !== false,
    },
  }
}

/**
 * Stamp the entries that predate inspection snapshots.
 *
 * The panel reads only the stored snapshot, so an entry written by an older version
 * has to be inspected once. That write belongs to plugin start, not to a GET: reading
 * the list must not mutate the data file, and doing it here keeps the cost to one run.
 * @param {{ defaultProjectPath: string, node?: object }} context host-supplied facts.
 * @returns {Promise<number>} how many entries gained a snapshot.
 */
export function migrateEntries(context) {
  return serialize(async () => {
    const entries = readEntries()
    const missing = entries.filter((entry) => entry.facts === null)
    if (missing.length === 0) return 0
    const stamped = await Promise.all(missing.map(async (entry) => [entry.id, await snapshotOf(entry, context, true)]))
    const byId = new Map(stamped)
    writeEntries(entries.map((entry) => (byId.has(entry.id) ? { ...entry, facts: byId.get(entry.id) } : entry)))
    return missing.length
  })
}

/**
 * Create or update one entry.
 * @param {unknown} input the request body.
 * @param {{ defaultProjectPath: string, node?: object }} context host-supplied facts.
 * @returns {Promise<object>} `{ ok: true, state }` or `{ ok: false, code, message }`.
 */
export function saveEntry(input, context) {
  return serialize(async () => {
    const checked = await validateEntry(input, context)
    if (!checked.ok) return checked
    const entries = readEntries()
    const existing = checked.value.id === undefined ? undefined : entries.find((entry) => entry.id === checked.value.id)
    if (checked.value.id !== undefined && existing === undefined) {
      return { ok: false, code: 'unknown-entry', message: `no launcher has the id ${checked.value.id}` }
    }
    const entry = {
      id: existing?.id ?? randomUUID(),
      name: checked.value.name,
      projectPath: checked.value.projectPath,
      stack: checked.value.stack,
      kind: checked.value.kind,
      builder: checked.value.builder,
      goal: checked.value.goal,
      profile: checked.value.profile,
      pm: checked.value.pm,
      script: checked.value.script,
      customCommand: checked.value.customCommand,
      nodeVersion: checked.value.nodeVersion,
      port: checked.value.port,
      priority: checked.value.priority ?? existing?.priority ?? PRIORITY_DEFAULT,
      batchEnabled: checked.value.batchEnabled,
      createdAt: existing?.createdAt ?? Date.now(),
    }
    const next = existing === undefined
      ? [...entries, entry]
      : entries.map((current) => (current.id === entry.id ? entry : current))
    projectCache.delete(entry.projectPath)
    // Stamp the project's facts now, so the list never has to read the directory.
    entry.facts = await snapshotOf(entry, context, true)
    writeEntries(next)
    return { ok: true, state: await readLauncherState(context) }
  })
}

/**
 * Re-inspect one entry's project and store the fresh snapshot.
 *
 * This is the manual counterpart of the inspection done on save: the list itself
 * costs no disk or git access, so branch and warnings are only as fresh as the
 * last save or refresh.
 * @param {unknown} input the request body: `{ id }`.
 * @param {{ defaultProjectPath: string, node?: object }} context host-supplied facts.
 * @returns {Promise<object>} `{ ok: true, state }` or `{ ok: false, code, message }`.
 */
export function refreshEntry(input, context) {
  return serialize(async () => {
    const id = firstText(input?.id)
    if (id === undefined) return { ok: false, code: 'invalid-id', message: 'an id is required' }
    const entries = readEntries()
    const entry = entries.find((candidate) => candidate.id === id)
    if (entry === undefined) return { ok: false, code: 'unknown-entry', message: `no launcher has the id ${id}` }
    const facts = await snapshotOf(entry, context, true)
    writeEntries(entries.map((current) => (current.id === id ? { ...current, facts } : current)))
    return { ok: true, state: await readLauncherState(context) }
  })
}

/**
 * Set whether one entry takes part in a batch start.
 *
 * Only the flag is written: toggling participation must not re-run the project
 * inspection or re-validate the command.
 * @param {unknown} input the request body: `{ id, batchEnabled }`.
 * @param {{ defaultProjectPath: string, node?: object }} context host-supplied facts.
 * @returns {Promise<object>} `{ ok: true, state }` or `{ ok: false, code, message }`.
 */
export function setBatchEnabled(input, context) {
  return serialize(async () => {
    const id = firstText(input?.id)
    if (id === undefined) return { ok: false, code: 'invalid-id', message: 'an id is required' }
    const entries = readEntries()
    if (!entries.some((entry) => entry.id === id)) {
      return { ok: false, code: 'unknown-entry', message: `no launcher has the id ${id}` }
    }
    const flag = input?.batchEnabled !== false
    writeEntries(entries.map((entry) => (entry.id === id ? { ...entry, batchEnabled: flag } : entry)))
    return { ok: true, state: await readLauncherState(context) }
  })
}

/**
 * Remove one entry, stopping it first when it is running.
 * @param {unknown} input the request body: `{ id }`.
 * @param {{ defaultProjectPath: string, node?: object }} context host-supplied facts.
 * @returns {Promise<object>} `{ ok: true, state }` or `{ ok: false, code, message }`.
 */
export function removeEntry(input, context) {
  return serialize(async () => {
    const id = firstText(input?.id)
    if (id === undefined) return { ok: false, code: 'invalid-id', message: 'an id is required' }
    const entries = readEntries()
    if (!entries.some((entry) => entry.id === id)) {
      return { ok: false, code: 'unknown-entry', message: `no launcher has the id ${id}` }
    }
    await stopEntry({ id })
    runs.delete(id)
    writeEntries(entries.filter((entry) => entry.id !== id))
    return { ok: true, state: await readLauncherState(context) }
  })
}

/**
 * Take one chunk of a run's output: buffer it, and learn its port if it announced one.
 * @param {object} run the run.
 * @param {string} text the chunk.
 * @returns {void}
 */
function onOutput(run, text) {
  appendLog(run.log, text)
  if (run.readyAt !== null) return
  const detected = detectPort(text)
  if (detected !== null && detected !== run.port) {
    run.port = detected
    startReadinessWatch(run, detected)
  }
}

/**
 * Start one entry's command.
 * @param {unknown} input the request body: `{ id }`.
 * @param {{ defaultProjectPath: string, node?: object }} context host-supplied facts.
 * @returns {Promise<object>} `{ ok: true, state }` or `{ ok: false, code, message }`.
 */
export async function startEntry(input, context) {
  const id = firstText(input?.id)
  if (id === undefined) return { ok: false, code: 'invalid-id', message: 'an id is required' }
  const entry = readEntries().find((candidate) => candidate.id === id)
  if (entry === undefined) return { ok: false, code: 'unknown-entry', message: `no launcher has the id ${id}` }
  const current = runs.get(id)
  if (current !== undefined && current.child !== null) {
    return { ok: false, code: 'already-running', message: `"${entry.name}" is already running` }
  }
  if (!isDirectory(entry.projectPath)) {
    return { ok: false, code: 'missing-directory', message: `the directory does not exist: ${entry.projectPath}` }
  }
  const command = commandOf(entry)
  if (command === '') {
    return { ok: false, code: 'invalid-command', message: 'this entry has no command to run' }
  }

  const facts = await projectFacts(entry.projectPath)
  if (entry.kind === 'script' && facts.hasPackageJson && facts.parsed
    && entry.script !== null && !facts.scripts.some((candidate) => candidate.name === entry.script)) {
    return { ok: false, code: 'script-missing', message: `package.json 里没有脚本 ${entry.script}，请重新选择` }
  }
  if (entry.port !== null && await probePort(entry.port)) {
    return { ok: false, code: 'port-in-use', message: `端口 ${entry.port} 已被占用：换端口或先停掉占用者` }
  }

  const env = { ...process.env }
  // A Spring profile travels as an environment variable, so the same setting works
  // for spring-boot:run, bootRun, a fat jar, and a hand-written command.
  if (entry.stack === 'backend' && entry.profile !== null) env.SPRING_PROFILES_ACTIVE = entry.profile
  let nodeDirectory = null
  if (entry.nodeVersion !== null && typeof context.node?.directory === 'function') {
    const resolved = context.node.directory(entry.nodeVersion)
    if (resolved?.exists === true) {
      nodeDirectory = resolved.directory
      // Windows keeps `Path` in process.env, not `PATH`: writing a second key would
      // leave the original (unpinned) entry to win or lose by accident of ordering.
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
      env[pathKey] = `${nodeDirectory}${path.delimiter}${env[pathKey] ?? ''}`
    } else {
      // The panel disables Start for this case; refusing here too keeps the promise off
      // the browser. A machine with no version manager at all is different: there the pin
      // simply cannot apply, and the run proceeds on the system default with a notice.
      const manager = typeof context.node.install === 'function' ? context.node.install() : null
      if (manager !== null && manager.available === true) {
        return {
          ok: false,
          code: 'node-missing',
          message: `锁定版本 v${entry.nodeVersion} 没装在这台机器上：先安装它，或改回跟随工作台`,
        }
      }
    }
  }

  const run = {
    child: null,
    pid: null,
    startedAt: Date.now(),
    endedAt: null,
    code: null,
    stopped: false,
    log: createLog(),
    port: entry.port,
    readyAt: null,
    url: null,
    lanUrl: null,
    actualNode: null,
    readyTimer: null,
    readyBudget: entry.stack === 'backend' ? READY_TIMEOUT_BACKEND_MS : READY_TIMEOUT_MS,
  }
  let child
  try {
    child = spawn(command, {
      cwd: entry.projectPath,
      shell: true,
      windowsHide: true,
      // POSIX: lead a process group so stopping reaches the whole tree (§ terminate).
      // Windows has taskkill /T instead, and ignores this option.
      detached: process.platform !== 'win32',
      env,
    })
  } catch (error) {
    return {
      ok: false,
      code: 'spawn-failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  run.child = child
  run.pid = child.pid ?? null
  runs.set(id, run)
  appendLog(run.log, `[launcher] ${command} in ${entry.projectPath}\n`)
  if (nodeDirectory !== null) appendLog(run.log, `[launcher] node from ${nodeDirectory}\n`)

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => { onOutput(run, String(chunk)) })
  // Announcements reach stderr too (webpack, Gradle, anything using a progress line).
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => { onOutput(run, String(chunk)) })
  child.on('error', (error) => {
    appendLog(run.log, `\n[launcher] ${error.message}\n`)
    run.child = null
    run.endedAt = Date.now()
    run.code = -1
    if (run.readyTimer !== null) {
      clearInterval(run.readyTimer)
      run.readyTimer = null
    }
  })
  child.on('exit', (code, signal) => {
    appendLog(run.log, `\n[launcher] exited: ${code === null ? signal ?? 'unknown' : `code ${code}`}\n`)
    run.child = null
    run.endedAt = Date.now()
    run.code = code ?? -1
    if (run.readyTimer !== null) {
      clearInterval(run.readyTimer)
      run.readyTimer = null
    }
  })

  // The version actually in effect proves the loop back to the Node.js system.
  execFile('node', ['--version'], { cwd: entry.projectPath, env, windowsHide: true, timeout: 15000 }, (error, stdout) => {
    const reported = firstText(error === null ? stdout : '')
    if (reported !== undefined) run.actualNode = reported.replace(/^v/i, '')
  })

  if (entry.port !== null) startReadinessWatch(run, entry.port)
  return { ok: true, state: await readLauncherState(context) }
}

/**
 * Wait until nothing answers on one port any more.
 *
 * A kill is asynchronous: `taskkill` and a process group signal both return before
 * the listening socket is gone. Waiting here means "stopped" in the panel is true
 * when it is shown, not a second later.
 * @param {number} port the port the run used.
 * @param {number} budget how long to wait, in milliseconds.
 * @returns {Promise<boolean>} whether the port came free.
 */
async function waitForPortRelease(port, budget) {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    if (!await probePort(port)) return true
    await new Promise((resolve) => { setTimeout(resolve, 150) })
  }
  return !await probePort(port)
}

/**
 * Stop one entry's process tree.
 * @param {unknown} input the request body: `{ id }`.
 * @param {{ defaultProjectPath: string, node?: object }} [context] host-supplied facts.
 * @returns {Promise<object>} `{ ok: true, state? }` or `{ ok: false, code, message }`.
 */
export async function stopEntry(input, context) {
  const id = firstText(input?.id)
  if (id === undefined) return { ok: false, code: 'invalid-id', message: 'an id is required' }
  const run = runs.get(id)
  if (run === undefined || run.child === null) {
    return { ok: false, code: 'not-running', message: 'that launcher is not running' }
  }
  const port = run.port
  await terminate(run)
  // Forget the run entirely: a stopped entry reports no url, port, output, or Node
  // version — only what is stored on the entry itself.
  runs.delete(id)
  if (typeof port === 'number') await waitForPortRelease(port, 3000)
  return context === undefined
    ? { ok: true }
    : { ok: true, state: await readLauncherState(context) }
}

/**
 * Inspect one project directory, read-only, for the entry form.
 * @param {unknown} input `{ dir, fresh }` from the query string or a body.
 * @returns {Promise<object>} the facts, or `{ ok: false, code, message }`.
 */
export async function inspectProject(input) {
  const directory = firstText(input?.dir ?? input?.directory)
  if (directory === undefined) return { ok: false, code: 'invalid-directory', message: 'dir is required' }
  if (!path.isAbsolute(directory)) {
    return { ok: false, code: 'invalid-directory', message: `the directory must be an absolute path: ${directory}` }
  }
  // `fresh` is what the editor sends: the user asked to see this folder as it is now.
  const facts = await projectFacts(directory, input?.fresh === true)
  return { ok: true, ...facts }
}

/**
 * The last lines one run printed, for the panel's log view.
 *
 * The ring buffer keeps {@link LOG_LIMIT} bytes per run, but a row only shows its last
 * line; this is where the rest becomes reachable without a terminal.
 * @param {string} id entry id.
 * @param {number} [lines] how many lines to return, clamped to the ceiling.
 * @returns {{ running: boolean, status: string, text: string, truncated: boolean } | null} the tail, or null when this process never ran the entry.
 */
export function readRunLog(id, lines = LOG_VIEW_LINES) {
  const run = runs.get(id)
  if (run === undefined) return null
  const wanted = Number.isFinite(lines) ? Math.min(LOG_VIEW_LINES_MAX, Math.max(1, Math.trunc(lines))) : LOG_VIEW_LINES
  const total = stripAnsi(run.log.chunks.join('')).split('\n').length
  return {
    running: run.child !== null,
    status: run.child !== null ? 'running' : run.stopped ? 'stopped' : 'exited',
    text: logLines(run.log, wanted, false),
    truncated: total > wanted,
  }
}

/**
 * Stop every run, for plugin disposal.
 *
 * The records are dropped afterwards, so a reloaded plugin starts from nothing
 * rather than from a half-remembered run.
 * @returns {void}
 */
export function stopAll() {
  for (const run of runs.values()) {
    if (run.child === null) continue
    void terminate(run)
  }
  runs.clear()
}

/**
 * The pure helpers, for the test suite only.
 *
 * Nothing in the plugin reads this object: `index.js` imports the operations above,
 * and the browser talks to them over the routes. It exists so `test/` can exercise the
 * parsing and validation rules without a Host, a shell, or a project on disk.
 */
export const internals = {
  buildProgramOf,
  commandOf,
  detectPort,
  inspectBackend,
  logLines,
  logTail,
  normalizeEntry,
  normalizePort,
  normalizePriority,
  normalizeVersion,
  stripAnsi,
  validateEntry,
}
