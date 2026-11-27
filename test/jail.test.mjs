/**
 * The job keeper, against real Windows processes.
 *
 * The claim being tested is the one `taskkill /T` cannot make: a process that has already
 * detached itself (`start /b`, a daemonizing wrapper) is still killed. The choreography is
 * deliberate — the parent waits for a trigger file before starting the detached child, so
 * the job is in place before that child exists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobKeeper } from '../jail.js'

const windows = process.platform === 'win32'

/**
 * Whether a pid is still running.
 * @param {number} pid the process id.
 * @returns {boolean} true when it is alive.
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Wait until a file exists, or give up.
 * @param {string} file the path.
 * @param {number} timeout how long to wait.
 * @returns {Promise<boolean>} whether it appeared.
 */
async function waitForFile(file, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

/**
 * Wait until a predicate holds, or give up.
 * @param {() => boolean} predicate the check.
 * @param {number} timeout how long to wait.
 * @returns {Promise<boolean>} whether it held.
 */
async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return predicate()
}

test('a detached grandchild is killed with its job', { skip: !windows, timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swb-jail-'))
  const ready = join(dir, 'ready.txt')
  const trigger = join(dir, 'go.txt')
  const grandchildPidFile = join(dir, 'grandchild.txt')
  const grandchildScript = join(dir, 'grandchild.ps1')
  writeFileSync(grandchildScript, `$PID | Set-Content '${grandchildPidFile}'\nStart-Sleep 60\n`, 'utf8')
  const keeper = new JobKeeper()

  try {
    // The parent: announces itself, waits for the trigger, then detaches a child through
    // `start /b`, which re-parents it into its own console — exactly what `taskkill /T`
    // cannot follow. The child records its own pid and sleeps.
    const script = [
      `'ready' | Set-Content '${ready}'`,
      `$deadline = (Get-Date).AddSeconds(20)`,
      `while (-not (Test-Path '${trigger}') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }`,
      `cmd.exe /c start "" /b powershell -NoProfile -NonInteractive -File '${grandchildScript}'`,
      `Start-Sleep 60`,
    ].join('; ')
    const parent = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    assert.ok(await waitForFile(ready), 'the parent started')

    const jailed = await keeper.jail(parent.pid)
    assert.equal(jailed, true, 'the keeper accepted the job')

    writeFileSync(trigger, 'go', 'utf8')
    assert.ok(await waitForFile(grandchildPidFile), 'the detached grandchild started')
    const grandchild = Number.parseInt(readFileSync(grandchildPidFile, 'utf8').trim(), 10)
    assert.ok(alive(grandchild), 'the grandchild is running before the kill')

    const released = await keeper.release(parent.pid)
    assert.equal(released, true, 'the keeper terminated the job')
    assert.ok(await waitFor(() => !alive(grandchild)), 'the detached grandchild is gone')
    assert.ok(await waitFor(() => !alive(parent.pid)), 'the parent is gone')
  } finally {
    await keeper.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disposing the keeper takes its trees with it', { skip: !windows, timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swb-jail-'))
  const ready = join(dir, 'ready.txt')
  const keeper = new JobKeeper()
  let child = null
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `'ready' | Set-Content '${ready}'; Start-Sleep 60`], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
    assert.ok(await waitForFile(ready), 'the child started')
    assert.equal(await keeper.jail(child.pid), true)
    // Closing the keeper is what happens when this host dies: no cleanup code runs.
    await keeper.dispose()
    assert.ok(await waitFor(() => !alive(child.pid)), 'the child died with the keeper')
  } finally {
    try { child?.kill('SIGKILL') } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true })
  }
})
