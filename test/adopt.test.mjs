/**
 * Adoption of runs that outlived the host that started them.
 *
 * The interesting half is the refusal: a stored pid proves nothing on its own, because pids
 * are reused. A record is only adopted when the process answering to it is the one recorded.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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
 * @param {number} pid the process id.
 * @returns {boolean} true when it answers.
 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
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
