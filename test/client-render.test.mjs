/**
 * Render tests for the client half.
 *
 * The panel is plain `React.createElement` calls, so a small hook runtime is enough to
 * render it for real: every component runs, every branch that draws something draws it,
 * and a typo in a table row fails here instead of turning the panel blank in a browser.
 * No dependency, no DOM, no fetch — effects are skipped on purpose.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** Hook state and refs, keyed by the component function that owns them. */
const stores = new Map()
const refs = new Map()
let cursor = 0
let refCursor = 0
let owner = null
const seen = new Map()

const React = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState(initial) {
    const list = stateOf(stores, owner)
    if (!(cursor in list)) list[cursor] = typeof initial === 'function' ? initial() : initial
    const index = cursor
    cursor += 1
    return [list[index], (next) => { list[index] = typeof next === 'function' ? next(list[index]) : next }]
  },
  // Effects and refs carry no state here, so they take no `useState` slot: the indices
  // the test seeds are then exactly the `useState` order in the component.
  useEffect() {},
  useRef(value) {
    const list = stateOf(refs, owner)
    if (!(refCursor in list)) list[refCursor] = { current: value ?? null }
    const index = refCursor
    refCursor += 1
    return list[index]
  },
}

/**
 * The per-component slot list.
 * @param {Map<object, Array>} map the store.
 * @param {object} key the owning component.
 * @returns {Array} its slots.
 */
function stateOf(map, key) {
  if (!map.has(key)) map.set(key, [])
  return map.get(key)
}

/**
 * Render one element tree, running every function component once.
 * @param {object} node the element.
 * @returns {object} the expanded tree.
 */
function renderNode(node) {
  if (Array.isArray(node)) return node.map(renderNode)
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const previousOwner = owner
    const previousCursor = cursor
    const previousRefCursor = refCursor
    owner = node.type
    cursor = 0
    refCursor = 0
    seen.set(node.type.name, node.type)
    const rendered = node.type({ ...node.props, children: node.children })
    owner = previousOwner
    cursor = previousCursor
    refCursor = previousRefCursor
    return renderNode(rendered)
  }
  return { ...node, children: node.children.map(renderNode) }
}

/**
 * Every string in a rendered tree.
 * @param {unknown} node the tree.
 * @returns {string[]} the text, in order.
 */
function textsOf(node) {
  const found = []
  const walk = (current) => {
    if (Array.isArray(current)) { current.forEach(walk); return }
    if (current === null || current === undefined) return
    if (typeof current === 'string' || typeof current === 'number') { found.push(String(current)); return }
    if (typeof current !== 'object') return
    current.children.forEach(walk)
  }
  walk(node)
  return found
}

/**
 * Every element of one className in a rendered tree.
 * @param {unknown} node the tree.
 * @param {string} name the class name to match.
 * @returns {Array<object>} the matching elements.
 */
function elementsWithClass(node, name) {
  const found = []
  const walk = (current) => {
    if (Array.isArray(current)) { current.forEach(walk); return }
    if (current === null || current === undefined || typeof current !== 'object') return
    const className = current.props?.className
    if (typeof className === 'string' && className.split(/\s+/).includes(name)) found.push(current)
    current.children.forEach(walk)
  }
  walk(node)
  return found
}

// The module expects the shell's loader and React; both are supplied here.
let registered = null
globalThis.window = { __ModuleLoader__: { load: (definition) => { registered = definition } } }
// A URL, not a path: this has to resolve the same way on Windows and on CI's Linux.
await import(new URL('../client.js', import.meta.url).href)

const plugin = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require("${name}")`)
})

let dictionaries = null
let mainComponent = null
plugin.apply({
  effect: (run) => { run() },
  locale: {
    register: (_namespace, value) => { dictionaries = value; return () => {} },
    bind: () => (key) => key,
  },
  slots: {
    // The panel registers from inside `inject`, so the callback has to run here too.
    inject: (_name, callback) => { callback() },
    register: (registration, component) => {
      if (registration.name === 'main') mainComponent = component
      return () => {}
    },
  },
  get: () => null,
})

/** Render the workbench panel with the key-echoing translator the slot injects. */
function renderPanel() {
  return renderNode(React.createElement(mainComponent, { t: (key) => key }))
}

test('the panel draws its frame and all three systems', () => {
  const tree = renderPanel()
  assert.deepEqual(elementsWithClass(tree, 'wbm-nav-item').length, 3)
  assert.ok(textsOf(tree).includes(dictionaries.en.workbench))

  const nav = elementsWithClass(tree, 'wbm-nav-item')
  assert.equal(nav[0].props['data-active'], 'true')

  // Selecting the second system must show the frontend pane, the third the backend one.
  // Copy comes from the English dictionary: the translator falls back to it when the
  // bound one echoes the key, which is exactly what a missing entry looks like.
  nav[1].props.onClick()
  const frontend = renderPanel()
  assert.ok(textsOf(frontend).includes(dictionaries.en.launchTitle))
  assert.equal(elementsWithClass(frontend, 'wbm-nav-item')[1].props['data-active'], 'true')

  elementsWithClass(frontend, 'wbm-nav-item')[2].props.onClick()
  const backend = renderPanel()
  assert.ok(textsOf(backend).includes(dictionaries.en.backendTitle))
  assert.ok(textsOf(backend).includes(dictionaries.en.launchLoading) || textsOf(backend).includes(dictionaries.en.launchFrontendEmpty))

  elementsWithClass(backend, 'wbm-nav-item')[0].props.onClick()
  assert.ok(textsOf(renderPanel()).includes(dictionaries.en.title))
})

/**
 * The `useState` slots this test reaches into, in LauncherSystem's call order.
 *
 * They are positional because React state is: the runtime here has no other way to
 * address one slot. The length assertion below makes a reordering fail loudly here
 * instead of quietly seeding the wrong state.
 */
const HOOK = { data: 0, insp: 6, menu: 8, logTarget: 9, logView: 10, batchOpen: 11, batchRun: 13, total: 14 }

test('an entry row draws its command, state, and actions', () => {
  // Bring the frontend pane up, then hand its data state a ready payload: the row
  // rendering code is what a typo would blank out, so it has to actually run.
  elementsWithClass(renderPanel(), 'wbm-nav-item')[1].props.onClick()
  renderPanel()
  const launcher = seen.get('LauncherSystem')
  assert.ok(launcher !== undefined, 'the launcher pane renders')
  const state = stateOf(stores, launcher)
  assert.equal(state.length, HOOK.total, 'LauncherSystem\'s hook order changed: update HOOK')
  state[HOOK.data] = {
    status: 'ready',
    error: null,
    payload: {
      defaultProjectPath: 'D:\\work\\demo',
      dataFile: 'C:\\Users\\x\\.dsh\\slim-workbench\\launchers.json',
      lanAddress: '192.168.1.10',
      nvm: { available: true, supported: true, managers: ['nvm-windows'] },
      nodeVersions: ['20.11.1'],
      currentVersion: '20.11.1',
      entries: [{
        id: 'entry-1',
        name: 'demo-web',
        stack: 'frontend',
        kind: 'script',
        pm: 'pnpm',
        script: 'dev',
        customCommand: null,
        nodeVersion: '20.11.1',
        port: 5173,
        priority: 2,
        batchEnabled: true,
        projectPath: 'D:\\work\\demo',
        command: 'pnpm run dev',
        status: 'running',
        phase: 'ready',
        runPort: 5173,
        url: 'http://localhost:5173',
        lanUrl: 'http://192.168.1.10:5173',
        actualNode: '20.11.1',
        tail: 'ready in 412 ms',
        branch: 'main',
        changes: 3,
        warnings: [],
      }],
    },
  }
  const tree = renderPanel()
  const text = textsOf(tree)
  assert.ok(text.includes('demo-web'))
  assert.ok(text.includes('pnpm run dev'))
  assert.ok(text.includes('192.168.1.10:5173'))
  // The stored priority is shown, even though nothing orders by it.
  assert.ok(text.some((line) => line.includes(dictionaries.en.launchPriorityChip.replace('{count}', '2'))))
  // The actions a row offers, including the output view this version added.
  const actions = elementsWithClass(tree, 'lch-actions')
  assert.equal(actions.length, 1)
  // Two actions and a menu: the row must not carry five buttons into a second line.
  const buttons = actions[0].children
  assert.equal(buttons.length, 3)
  assert.equal(textsOf(buttons[0]).join(''), dictionaries.en.launchStop)
  assert.equal(textsOf(buttons[1]).join(''), dictionaries.en.launchEdit)
  assert.ok(textsOf(buttons[2]).join('').startsWith(dictionaries.en.actionsMore))
})

test('the editor keeps the priority control', () => {
  const launcher = seen.get('LauncherSystem')
  const state = stateOf(stores, launcher)
  const entry = state[HOOK.data].payload.entries[0]
  // A form carrying the stored priority: the control is editable, it just has no consumer.
  state[1] = {
    id: entry.id,
    name: entry.name,
    projectPath: entry.projectPath,
    kind: 'script',
    pm: 'pnpm',
    script: 'dev',
    customCommand: '',
    nodeVersion: '20.11.1',
    port: '5173',
    priority: 2,
    batchEnabled: true,
    builder: null,
    profile: null,
  }
  const tree = renderPanel()
  const text = textsOf(tree)
  assert.ok(text.includes(dictionaries.en.launchPriorityLabel))
  assert.ok(text.includes(dictionaries.en.launchPriorityHint), 'the hint says nothing consumes it yet')
  // The control is an input holding the stored value.
  const inputs = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.type === 'input' && node.props.value === '2') inputs.push(node)
    node.children.forEach(walk)
  }
  walk(tree)
  assert.ok(inputs.length > 0, 'the priority input holds the stored value')
  state[1] = null
})

test('the More menu holds the actions the row no longer shows', () => {
  const launcher = seen.get('LauncherSystem')
  const state = stateOf(stores, launcher)
  state[HOOK.menu] = { entry: state[HOOK.data].payload.entries[0], left: 40, top: 40 }
  const tree = renderPanel()
  const menu = elementsWithClass(tree, 'lch-menu')
  assert.equal(menu.length, 1)
  const items = elementsWithClass(menu[0], 'lch-menu-item')
  assert.deepEqual(
    items.map((item) => textsOf(item).join('')),
    [dictionaries.en.launchLog, dictionaries.en.launchRefresh, dictionaries.en.launchRemove],
  )
  state[HOOK.menu] = null
})

test('the batch dialog offers both start modes', () => {
  const launcher = seen.get('LauncherSystem')
  const state = stateOf(stores, launcher)
  state[HOOK.batchOpen] = true
  const tree = renderPanel()
  const text = textsOf(tree)
  assert.ok(text.includes(dictionaries.en.batchMode))
  assert.ok(text.includes(dictionaries.en.batchModeParallel))
  assert.ok(text.includes(dictionaries.en.batchModeSerial))
  assert.ok(text.includes(dictionaries.en.batchParallelHint))
  state[HOOK.batchOpen] = false
})

test('the output dialog draws the buffered lines', () => {
  const launcher = seen.get('LauncherSystem')
  const state = stateOf(stores, launcher)
  const entry = state[HOOK.data].payload.entries[0]
  state[HOOK.logTarget] = entry
  state[HOOK.logView] = { status: 'ready', text: 'first line\nsecond line', truncated: true, running: true, error: null }
  const tree = renderPanel()
  const log = elementsWithClass(tree, 'lch-log')
  assert.equal(log.length, 1)
  assert.deepEqual(textsOf(log[0]), ['first line\nsecond line'])
  const hint = textsOf(tree).find((line) => line.startsWith(dictionaries.en.launchLogHint))
  assert.ok(hint !== undefined, 'the dialog explains where the output comes from')
  const truncated = dictionaries.en.launchLogTruncated.replace('{count}', '200')
  assert.ok(textsOf(tree).some((line) => line.trim() === truncated), 'a truncated log says how much it shows')
})

test('a refresh of the installed list shows that it is loading', () => {
  // Back to the Node pane, then hand it a refresh in flight over data already on screen.
  const nav = elementsWithClass(renderPanel(), 'wbm-nav-item')
  nav[0].props.onClick()
  renderPanel()
  const node = seen.get('NodeSystem')
  assert.ok(node !== undefined, 'the Node pane renders')
  const state = stateOf(stores, node)
  const payload = {
    platform: 'win32',
    supported: true,
    available: true,
    nvmVersion: '1.1.10',
    nvmHome: 'F:\\nvm',
    symlink: 'F:\\nodejs',
    symlinkPresent: true,
    checked: [],
    current: '24.14.1',
    versions: [{ version: '24.14.1' }, { version: '14.21.3' }],
    readAt: Date.parse('2026-11-27T09:18:09Z'),
  }
  state[0] = { phase: 'ready', state: payload, error: null }
  const idle = renderPanel()
  assert.deepEqual(elementsWithClass(idle, 'ndv-loading'), [], 'no indicator while idle')
  // The strip says when the list was read, so a stale answer is recognisable.
  assert.ok(
    textsOf(idle).some((line) => line.startsWith(dictionaries.en.updatedAt)),
    'the status strip shows the update time',
  )

  state[0] = { phase: 'loading', state: payload, error: null }
  const tree = renderPanel()
  const loading = elementsWithClass(tree, 'ndv-loading')
  assert.equal(loading.length, 1)
  assert.ok(textsOf(loading[0]).includes(dictionaries.en.refreshingInstalled))
  // The button carries a spinner and says what it is doing.
  const button = elementsWithClass(tree, 'ndv-refresh')[0]
  assert.equal(elementsWithClass(button, 'ndv-spin').length, 1)
  assert.ok(textsOf(button).includes(dictionaries.en.refreshing))
  // The rows stay, dimmed: they are the previous answer until the new one lands.
  const scroller = elementsWithClass(tree, 'ndv-scroll')[0]
  assert.equal(scroller.props['data-busy'], 'true')
  assert.ok(textsOf(tree).includes('v24.14.1'), 'the installed rows are still there')

  state[0] = { phase: 'ready', state: payload, error: null }
})

test('the dictionaries the panel registers stay in step', () => {
  const keys = Object.keys(dictionaries.en)
  assert.equal(keys.length, Object.keys(dictionaries.zh).length)
  for (const key of keys) {
    assert.equal(typeof dictionaries.zh[key], 'string', `${key} has no Chinese copy`)
    assert.equal(/[\u4e00-\u9fff]/.test(dictionaries.en[key]), false, `${key} leaks Chinese into English`)
  }
})
