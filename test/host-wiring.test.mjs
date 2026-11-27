/**
 * Wiring tests for the Host half.
 *
 * `apply()` is the only place that can silently stop working: a route path typo, a tool
 * that never registers, or a gate that stops refusing. None of that throws at load time —
 * the panel just loses a button. This mounts the real plugin on a stub context and drives
 * the routes over fake requests, with `DSH_HOME` pointed at a scratch directory.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(os.tmpdir(), 'swb-home-'))
process.env.DSH_HOME = home
const { apply } = await import('../index.js')

const tools = new Map()
const routes = new Map()
const disposers = []

/** The stub the Host context hands to `ctx.inject(['webServer'], …)`. */
const host = {
  effect: (run) => {
    const disposer = run()
    if (typeof disposer === 'function') disposers.push(disposer)
  },
  webServer: {
    register: (spec) => {
      routes.set(spec.path, spec)
      return () => {}
    },
  },
}

apply({
  effect: host.effect,
  inject: (_names, callback) => { callback(host) },
  get: (name) => (name === 'workingDirectory' ? { defaultDirectory: home } : undefined),
  tools: {
    register: (tool) => {
      tools.set(tool.name, tool)
      return () => {}
    },
  },
}, {})

/**
 * Drive one registered route.
 * @param {string} route the exact path.
 * @param {{ method?: string, query?: string, headers?: Record<string, string>, body?: string }} [options] request details.
 * @returns {Promise<{ status: number, payload: any }>} what the browser would receive.
 */
async function call(route, options = {}) {
  const spec = routes.get(route)
  assert.ok(spec !== undefined, `route ${route} is registered`)
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')]
  const request = {
    method: options.method ?? 'GET',
    url: `${route}${options.query ?? ''}`,
    headers: { host: '127.0.0.1:52939', ...options.headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    resume() {},
  }
  const response = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(payload) { if (payload !== undefined) this.body += payload },
  }
  await spec.handler(request, response)
  let payload = response.body
  try { payload = JSON.parse(response.body) } catch { /* a plain body stays text */ }
  return { status: response.statusCode, payload }
}

test.after(() => rmSync(home, { recursive: true, force: true }))

test('both tools register', () => {
  assert.deepEqual([...tools.keys()].sort(), ['node_version', 'workbench_status'])
  assert.equal(tools.get('node_version').name, 'node_version')
})

test('every route the browser calls is registered', () => {
  const expected = [
    'state', 'releases', 'use', 'install', 'uninstall',
    'launch/state', 'launch/save', 'launch/remove', 'launch/start', 'launch/stop',
    'launch/inspect', 'launch/probe', 'launch/refresh', 'launch/batch-enabled', 'launch/log',
  ].map((suffix) => `/slim-workbench/${suffix}`)
  assert.deepEqual([...routes.keys()].sort(), expected.sort())
})

test('the gate refuses a request that did not come from this host', async () => {
  const refused = await call('/slim-workbench/launch/state', { headers: { host: 'evil.example' } })
  assert.equal(refused.status, 403)
  const crossed = await call('/slim-workbench/launch/state', { headers: { origin: 'http://evil.example' } })
  assert.equal(crossed.status, 403)
  const allowed = await call('/slim-workbench/launch/state')
  assert.equal(allowed.status, 200)
})

test('a fresh profile lists no entries', async () => {
  const state = await call('/slim-workbench/launch/state')
  assert.deepEqual(state.payload.entries, [])
  assert.equal(state.payload.dataFile, path.join(home, 'slim-workbench', 'launchers.json'))
  // The log route answers "nothing ran" instead of failing.
  assert.equal((await call('/slim-workbench/launch/log')).payload.code, 'invalid-id')
  assert.equal((await call('/slim-workbench/launch/log', { query: '?id=nope' })).payload.code, 'no-run')
})

test('a body that is not JSON, or too large, never reaches the handler', async () => {
  const wrongType = await call('/slim-workbench/launch/save', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
  assert.equal(wrongType.status, 415)
  const tooLarge = await call('/slim-workbench/launch/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(9000) }),
  })
  assert.equal(tooLarge.status, 413)
  const wrongMethod = await call('/slim-workbench/launch/save')
  assert.equal(wrongMethod.status, 405)
})

test('the Node state says when it was read', async () => {
  const before = Date.now()
  const state = await call('/slim-workbench/state')
  assert.equal(state.status, 200)
  assert.equal(typeof state.payload.readAt, 'number', 'the payload carries the read time')
  assert.ok(state.payload.readAt >= before, 'and it is this read, not an older one')
  assert.ok(state.payload.readAt <= Date.now() + 5)
})

test('a successful read is remembered in the data file', async () => {
  const state = await call('/slim-workbench/state')
  assert.equal(state.status, 200)
  // The cache write is fire-and-forget so it cannot delay the reply: give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 60))
  const file = path.join(home, 'slim-workbench', 'launchers.json')
  assert.ok(existsSync(file), 'one file holds the entries and the remembered read')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(typeof stored.nodeCache?.readAt, 'number')
  assert.ok(Array.isArray(stored.nodeCache?.versions))
  assert.deepEqual(stored.entries, [], 'the cache does not invent entries')
})

test('a saved entry comes back with its command and snapshot', async () => {
  const project = path.join(home, 'demo')
  mkdirSync(project, { recursive: true })
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'vite' } }), 'utf8')

  const saved = await call('/slim-workbench/launch/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'demo-web',
      projectPath: project,
      stack: 'frontend',
      kind: 'script',
      pm: 'pnpm',
      script: 'dev',
      port: 5173,
      priority: 2,
    }),
  })
  assert.equal(saved.payload.ok, true)
  const [entry] = saved.payload.state.entries
  assert.equal(entry.name, 'demo-web')
  assert.equal(entry.command, 'pnpm run dev')
  assert.equal(entry.status, 'stopped')
  assert.equal(entry.port, 5173)
  assert.equal(entry.priority, 2)
  assert.ok(entry.inspectedAt !== null, 'saving stamps the project snapshot')

  // The entry write must carry the section it does not own.
  const stored = JSON.parse(readFileSync(path.join(home, 'slim-workbench', 'launchers.json'), 'utf8'))
  assert.equal(typeof stored.nodeCache?.readAt, 'number', 'saving an entry keeps the remembered read')

  // The panel no longer sends a priority: editing must keep the stored one, not reset it.
  const edited = await call('/slim-workbench/launch/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: entry.id,
      name: 'demo-web-renamed',
      projectPath: project,
      stack: 'frontend',
      kind: 'script',
      pm: 'pnpm',
      script: 'dev',
      port: 5173,
    }),
  })
  assert.equal(edited.payload.ok, true)
  assert.equal(edited.payload.state.entries[0].name, 'demo-web-renamed')
  assert.equal(edited.payload.state.entries[0].priority, 2, 'an omitted priority keeps what the entry stores')

  // 0 is a real value, not a falsy one to be replaced by the default.
  const zeroed = await call('/slim-workbench/launch/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: entry.id,
      name: 'demo-web-renamed',
      projectPath: project,
      stack: 'frontend',
      kind: 'script',
      pm: 'pnpm',
      script: 'dev',
      port: 5173,
      priority: 0,
    }),
  })
  assert.equal(zeroed.payload.state.entries[0].priority, 0)

  // The refusals a user can actually hit.
  const noName = await call('/slim-workbench/launch/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: project, kind: 'custom', customCommand: 'npm run dev' }),
  })
  assert.equal(noName.payload.code, 'invalid-name')

  // Starting an entry that does not exist is refused, not attempted.
  const unknown = await call('/slim-workbench/launch/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'no-such-entry' }),
  })
  assert.equal(unknown.payload.code, 'unknown-entry')

  // Batch participation is a flag write, and it sticks.
  const toggled = await call('/slim-workbench/launch/batch-enabled', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: entry.id, batchEnabled: false }),
  })
  assert.equal(toggled.payload.state.entries[0].batchEnabled, false)

  // Removing it leaves an empty list again.
  const removed = await call('/slim-workbench/launch/remove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: entry.id }),
  })
  assert.deepEqual(removed.payload.state.entries, [])
})

test('the status tool reports what the panel shows', async () => {
  const report = await tools.get('workbench_status').execute({})
  assert.match(report.summary, /Slim workbench/)
  assert.match(report.summary, /No launcher is configured yet/)
  await assert.rejects(
    () => tools.get('workbench_status').execute({ id: 'missing' }),
    /no launcher has the id missing/,
  )
})

test('a corrupt data file is treated as empty, not as a crash', async () => {
  const file = path.join(home, 'slim-workbench', 'launchers.json')
  writeFileSync(file, '{ this is not json', 'utf8')
  const launch = await call('/slim-workbench/launch/state')
  assert.equal(launch.status, 200)
  assert.deepEqual(launch.payload.entries, [])
  const node = await call('/slim-workbench/state')
  assert.equal(node.status, 200)
  assert.equal(typeof node.payload.readAt, 'number', 'the live read still answers')
})

test('unmounting disposes every registration', () => {
  assert.ok(disposers.length > 0)
  for (const dispose of disposers) dispose()
})
