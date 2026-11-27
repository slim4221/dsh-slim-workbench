/**
 * A Windows job object keeper, so a started process tree can be killed as a whole.
 *
 * `taskkill /T` walks the parent chain at kill time, which misses a process that has
 * already detached itself (`start /b`, a daemonizing wrapper, a service shim). A job
 * object does not: every descendant is inside it, and `KILL_ON_JOB_CLOSE` means the
 * tree also dies when the handle is closed — including when this host dies, because
 * the keeper's stdin closing is what closes the handle.
 *
 * One keeper serves the whole session rather than one per run: a PowerShell process is
 * ~40 MB and ~300 ms to start, which is not something to pay per dev server. If the
 * keeper cannot start at all, every caller falls back to `taskkill /T`.
 */
import { spawn } from 'node:child_process'

/** How long the keeper gets to start before the caller falls back.
 *
 * Generous on purpose: the first start compiles the tiny C# helper, and a cold CI runner
 * can take several seconds over it. It is paid once per session.
 */
const START_TIMEOUT = 15000

/** How long one job operation may take before it is treated as failed. */
const OP_TIMEOUT = 3000

/**
 * The keeper script. C# does the P/Invoke that Node cannot, PowerShell does the loop.
 *
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is the whole point: the handle lives in this
 * process, so this process ending — for any reason — takes its jobs and their trees
 * with it. `release` uses `TerminateJobObject` for the same reason: it does not need to
 * walk a parent chain, so a detached grandchild cannot slip out.
 */
const KEEPER_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$native = @'
using System;
using System.Runtime.InteropServices;
public static class SlimJail {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [StructLayout(LayoutKind.Sequential)]
  public struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  public static IntPtr Create(int pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    ExtendedLimits limits = new ExtendedLimits();
    // 0x2000 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    limits.BasicLimitInformation.LimitFlags = 0x2000;
    int size = Marshal.SizeOf(limits);
    IntPtr block = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(limits, block, false);
    SetInformationJobObject(job, 9, block, (uint)size);
    Marshal.FreeHGlobal(block);
    // 0x1F0FFF = PROCESS_ALL_ACCESS; fall back to the rights assignment actually needs.
    IntPtr process = OpenProcess(0x1F0FFF, false, pid);
    if (process == IntPtr.Zero) process = OpenProcess(0x0120 | 0x0400 | 0x0008, false, pid);
    if (process == IntPtr.Zero) { CloseHandle(job); return IntPtr.Zero; }
    bool assigned = AssignProcessToJobObject(job, process);
    CloseHandle(process);
    if (!assigned) { CloseHandle(job); return IntPtr.Zero; }
    return job;
  }
}
'@
Add-Type -TypeDefinition $native
$jobs = @{}
$out = [Console]::Out
$out.WriteLine('{"op":"ready"}')
$out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try {
    $message = $line | ConvertFrom-Json
    $key = [string]$message.pid
    switch ([string]$message.op) {
      'jail' {
        $handle = [SlimJail]::Create([int]$message.pid)
        if ($handle -eq [IntPtr]::Zero) { $out.WriteLine('{"op":"jail","ok":false}') }
        else { $jobs[$key] = $handle; $out.WriteLine('{"op":"jail","ok":true}') }
      }
      'release' {
        $found = $jobs.ContainsKey($key)
        if ($found) {
          [SlimJail]::TerminateJobObject($jobs[$key], 0) | Out-Null
          [SlimJail]::CloseHandle($jobs[$key]) | Out-Null
          $jobs.Remove($key)
        }
        # ok:false when there was no job for that pid, so the caller falls back to
        # walking the process tree instead of believing the kill happened.
        if ($found) { $out.WriteLine('{"op":"release","ok":true}') }
        else { $out.WriteLine('{"op":"release","ok":false}') }
      }
      'ping' { $out.WriteLine('{"op":"ping","ok":true}') }
      default { $out.WriteLine('{"op":"?","ok":false}') }
    }
    $out.Flush()
  } catch {
    $out.WriteLine('{"op":"error","ok":false}')
    $out.Flush()
  }
}
# stdin closed: closing the handles kills every tree still in a job.
foreach ($handle in $jobs.Values) { [SlimJail]::CloseHandle($handle) | Out-Null }
`

/** @param {string} source the script. @returns {string} base64 for `-EncodedCommand`. */
function encode(source) {
  return Buffer.from(source, 'utf16le').toString('base64')
}

/**
 * One keeper for the session, started on first use.
 */
export class JobKeeper {
  #child = null
  #buffer = ''
  /** One resolver per operation in flight, oldest first. */
  #waiting = []
  /** Non-null while the keeper is starting, so two callers share one start. */
  #starting = null
  /** Set once the keeper could not start; nothing is retried after that. */
  #broken = false
  /** Called when the keeper announces itself, or null when no start is in flight. */
  #ready = null

  /**
   * Whether a keeper is usable on this platform and has not failed yet.
   * @returns {boolean} true when {@link jail} may be called.
   */
  get usable() {
    return process.platform === 'win32' && !this.#broken
  }

  /**
   * Start the keeper if it is not running.
   * @returns {Promise<boolean>} whether it is ready.
   */
  async #ensure() {
    if (this.#broken) return false
    if (this.#child !== null && this.#child.exitCode === null) return true
    if (this.#starting !== null) return this.#starting
    this.#starting = this.#start()
    try {
      return await this.#starting
    } finally {
      this.#starting = null
    }
  }

  /**
   * Spawn the keeper and settle once it announces itself.
   *
   * Readiness comes from the keeper's own `{"op":"ready"}` line rather than from a timer:
   * the first start compiles its C# helper, so how long that takes is its answer to give.
   * @returns {Promise<boolean>} whether it started.
   */
  #start() {
    return new Promise((resolve) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(KEEPER_SOURCE)],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
      this.#child = child
      let settled = false
      let timer = null
      const finish = (ok) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        this.#ready = null
        if (!ok) this.#broken = true
        resolve(ok)
      }
      timer = setTimeout(() => {
        finish(false)
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }, START_TIMEOUT)
      this.#ready = () => finish(true)
      child.once('error', () => finish(false))
      child.once('exit', () => {
        // Closing its handles killed every tree it held; a later call may start a new one.
        this.#child = null
        this.#failAll()
        finish(false)
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.#receive(chunk))
      child.stderr.resume()
    })
  }

  /**
   * Read one line of keeper output.
   * @param {string} chunk the incoming text.
   * @returns {void}
   */
  #receive(chunk) {
    this.#buffer += chunk
    let index = this.#buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line !== '') this.#settle(line)
      index = this.#buffer.indexOf('\n')
    }
  }

  /**
   * Match one reply to the operation waiting for it.
   * @param {string} line the JSON line.
   * @returns {void}
   */
  #settle(line) {
    let reply = null
    try {
      reply = JSON.parse(line)
    } catch {
      return
    }
    if (reply.op === 'ready') {
      if (this.#ready !== null) this.#ready()
      return
    }
    const pending = this.#waiting.shift()
    if (pending !== undefined) pending(reply.ok === true)
  }

  /**
   * Fail every waiting operation, because the keeper is gone.
   * @returns {void}
   */
  #failAll() {
    while (this.#waiting.length > 0) {
      const pending = this.#waiting.shift()
      pending(false)
    }
  }

  /**
   * Send one operation and wait for its reply.
   * @param {object} message the operation.
   * @returns {Promise<boolean>} whether it succeeded.
   */
  #send(message) {
    const child = this.#child
    if (child === null || child.stdin === null || child.exitCode !== null) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer = null
      const done = (value) => {
        if (timer !== null) clearTimeout(timer)
        resolve(value)
      }
      timer = setTimeout(() => {
        const at = this.#waiting.indexOf(done)
        if (at >= 0) this.#waiting.splice(at, 1)
        resolve(false)
      }, OP_TIMEOUT)
      this.#waiting.push(done)
      child.stdin.write(`${JSON.stringify(message)}\n`)
    })
  }

  /**
   * Put a process and its future descendants into a job.
   * @param {number} pid the process id.
   * @returns {Promise<boolean>} whether it is jailed.
   */
  async jail(pid) {
    if (!this.usable || !Number.isInteger(pid)) return false
    if (!await this.#ensure()) return false
    return this.#send({ op: 'jail', pid })
  }

  /**
   * Terminate everything in that process's job.
   * @param {number} pid the process id the job was created from.
   * @returns {Promise<boolean>} whether the keeper did it.
   */
  async release(pid) {
    if (!this.usable || !Number.isInteger(pid)) return false
    if (this.#child === null) return false
    return this.#send({ op: 'release', pid })
  }

  /**
   * Stop the keeper. Closing its stdin closes every job, which is the same thing that
   * happens when this host dies — so it is also the last line of defence on unload.
   * @returns {Promise<void>} settles once it is gone.
   */
  async dispose() {
    const child = this.#child
    this.#child = null
    this.#broken = true
    this.#failAll()
    if (child === null || child.exitCode !== null) return
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } resolve() }, 1500)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      try {
        child.stdin.end()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}
