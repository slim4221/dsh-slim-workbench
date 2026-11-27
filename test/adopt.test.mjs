/**
 * Adoption of runs that outlived the host that started them.
 *
 * The interesting half is the refusal: a stored pid proves nothing on its own, because pids
 * are reused. A record is only adopted when the process answering to it is the one recorded.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'swb-adopt-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'slim-workbench'), { recursive: true })

const {
  adoptRuns, readLauncherState, saveEntry, stopEntry, disposeKeeper,
} = await import('../launcher.js')

const context = { defaultProjectPath: home }

/**
 * Write the runs section beside existing entries, the way a crash would leave it.
 * @param {Array<object>} records the records to store.
 * @returns {void}
 */
function storeRuns(records) {
  const file = join(home, 'slim-workbench', 'launchers.json')
  const document = JSON.parse(readFileSync(file, 'utf8'))
  document.runs = records
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

/**
 * Whether a pid is alive.
 *
 * Three cases, and they are not the same: no such process, a running one, and a zombie —
 * a killed child whose parent has not reaped it yet still answers signal 0. On Linux the
 * process state has to be read to tell the last two apart; the absence of /proc/<pid>
 * there means the process is gone, while the absence of /proc at all means the platform
 * has no procfs and signal 0 was the whole answer.
 * @param {number} pid the process id.
 * @returns {boolean} true when it is really running.
 */
function alive(pid) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error.code === 'EPERM'
  }
  if (!existsSync('/proc/self')) return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const end = stat.lastIndexOf(')')
    return stat.slice(end + 2, end + 3) !== 'Z'
  } catch {
    // procfs is there but this pid is not: it has exited and been reaped.
    return false
  }
}

/**
 * Wait for a predicate.
 * @param {() => boolean} predicate the check.
 * @param {number} timeout how long to wait.
 * @returns {Promise<boolean>} whether it held.
 */
async function waitFor(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return predicate()
}

test.after(() => {
  rmSync(home, { recursive: true, force: true })
  void disposeKeeper()
})

test('an adopted run is still running, and one stop kills it', { timeout: 40000 }, async () => {
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  const saved = await saveEntry({
    name: 'adopted-web',
    projectPath: project,
    stack: 'frontend',
    kind: 'custom',
    customCommand: 'node -e sleep',
    port: null,
  }, context)
  assert.equal(saved.ok, true)
  const id = saved.state.entries[0].id

  // A process that looks like one this plugin started, with no pipes left to anyone.
  // Node is used rather than PowerShell so the same test runs on both platforms.
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'],
    { stdio: 'ignore', windowsHide: true })
  // Keep the handle: the exit listener is what makes this process reap its child, and an
  // unreaped child on Linux is a zombie that still answers signal 0.
  orphan.on('exit', () => {})
  orphan.unref()
  assert.ok(await waitFor(() => alive(orphan.pid)), 'the orphan is running')
  storeRuns([{
    id,
    name: 'adopted-web',
    pid: orphan.pid,
    startedAt: Date.now() - 60000,
    port: null,
    command: `node -e sleep`,
  }])

  const found = await adoptRuns(context)
  assert.deepEqual(found, { adopted: 1, dropped: 0 })
  const state = await readLauncherState(context)
  assert.equal(state.entries[0].status, 'running', 'the panel shows it running')
  assert.equal(state.entries[0].orphan, true, 'and marks it as adopted')

  const stopped = await stopEntry({ id }, context)
  assert.equal(stopped.ok, true)
  assert.ok(await waitFor(() => !alive(orphan.pid)), 'one stop killed the process tree')
  const after = await readLauncherState(context)
  assert.equal(after.entries[0].status, 'stopped')
})

test('a record whose process is gone, or is a different program, is dropped', { timeout: 40000 }, async () => {
  const project = join(home, 'project2')
  mkdirSync(project, { recursive: true })
  const saved = await saveEntry({
    name: 'stale-web',
    projectPath: project,
    stack: 'frontend',
    kind: 'custom',
    customCommand: 'node -e sleep',
    port: null,
  }, context)
  assert.equal(saved.ok, true)
  const id = saved.state.entries[0].id

  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'],
    { stdio: 'ignore', windowsHide: true })
  other.on('exit', () => {})
  other.unref()
  assert.ok(await waitFor(() => alive(other.pid)), 'the unrelated process is running')

  // Two records: a dead pid, and a live pid whose recorded command names another program.
  // The second is the case that matters — adopting it would hand the user a Stop button
  // that kills a process this plugin never started.
  storeRuns([
    { id, name: 'stale-web', pid: 999999, startedAt: Date.now(), port: null, command: 'node -e sleep' },
    { id, name: 'stale-web', pid: other.pid, startedAt: Date.now(), port: null, command: 'python -m http.server' },
  ])
  const found = await adoptRuns(context)
  assert.deepEqual(found, { adopted: 0, dropped: 2 })
  assert.ok(alive(other.pid), 'the unrelated process was left alone')
  const state = await readLauncherState(context)
  assert.equal(state.entries[0].status, 'stopped')
  try { other.kill('SIGKILL') } catch { /* already gone */ }
})
