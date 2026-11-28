#!/usr/bin/env node
/**
 * Render the real client half in a real browser and measure the layout.
 *
 * The unit tests render the component tree to plain objects: they prove what is drawn, not
 * what it looks like. This harness closes that gap — it loads `client.js` unchanged, gives
 * it a DOM-based React and a stubbed Host, then measures the table the browser actually
 * laid out: column widths, whether the project and action columns really stay put while the
 * middle scrolls, whether a button wrapped, whether the list scrolls sideways at all.
 *
 * Dev-only: not shipped (the package's `files` list excludes scripts/), no dependencies.
 * Chrome is found on PATH or in the usual install locations; `CHROME` overrides it.
 *
 * Usage: node scripts/visual.mjs [--keep] [--width 1600] [--height 900]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const width = Number(args[args.indexOf('--width') + 1]) || 1600
const height = Number(args[args.indexOf('--height') + 1]) || 900
const keep = args.includes('--keep')
// The detail page's previews: the same page, cropped by the window instead of by an editor.
const docs = args.includes('--docs')
const PREVIEW_HEIGHT = 620

/**
 * Find a Chrome binary.
 * @returns {string | null} the path, or null.
 */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  return candidates.find((candidate) => candidate !== '' && existsSync(candidate)) ?? null
}

/**
 * The page: a DOM React, a stubbed Host, the real client module, then a measurement pass.
 * @returns {string} the HTML.
 */
function page() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>slim-workbench visual</title>
<style>
  :root {
    --dsw-alias-bg-base: #17181c;
    --dsw-alias-bg-layer-1: #1e1f24;
    --dsw-alias-bg-layer-2: #24262c;
    --dsw-alias-border-l1: #33353d;
    --dsw-alias-border-l2: #3d4049;
    --dsw-alias-label-primary: #e8e9ec;
    --dsw-alias-label-secondary: #a9adb7;
    --dsw-alias-label-tertiary: #7d818c;
    --dsw-alias-brand-primary: #4c7ef3;
    --dsw-alias-state-error-primary: #d9534f;
    --dsw-alias-state-success-primary: #2f9e5f;
    --dsw-alias-bg-badge: #2b2f3a;
    --dsw-radius-md: 6px;
    --dsw-radius-xl: 12px;
  }
  html, body { margin: 0; height: 100%; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
    font: 13px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }
  #root { display: flex; height: 100%; }
  #pane { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100%; }
</style></head>
<body><div id="root"><div id="pane"></div></div>
<pre id="metrics" style="display:none"></pre>
<script>window.__ERRORS__ = [];
  window.onerror = (message) => { window.__ERRORS__.push('window: ' + String(message)); };
  window.addEventListener('error', (event) => { window.__ERRORS__.push('resource: ' + String(event.message ?? event.target?.src ?? '')); }, true);</script>
<script>window.__REGISTERED__ = null;
  window.__ModuleLoader__ = { load: (definition) => { window.__REGISTERED__ = definition; } };</script>
<script>
/* ---- a React small enough to render the panel into real DOM ---- */
(function () {
  const hooks = new Map();
  let rootNode = null;
  let rootRender = null;

  function slotFor(type) {
    if (!hooks.has(type)) hooks.set(type, { list: [], index: 0 });
    return hooks.get(type);
  }

  function handle() { return rootRender; }

  const React = {
    Fragment: Symbol('fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() };
    },
    useState(initial) {
      const store = slotFor(handle().type);
      const index = store.index++;
      if (!(index in store.list)) store.list[index] = typeof initial === 'function' ? initial() : initial;
      const set = (value) => {
        const next = typeof value === 'function' ? value(store.list[index]) : value;
        if (Object.is(next, store.list[index])) return;
        store.list[index] = next;
        schedule();
      };
      return [store.list[index], set];
    },
    useRef(initial) {
      const store = slotFor(handle().type);
      const index = store.index++;
      if (!(index in store.list)) store.list[index] = { current: initial };
      return store.list[index];
    },
    useEffect(effect, deps) {
      const store = slotFor(handle().type);
      const index = store.index++;
      const previous = store.list[index];
      const changed = previous === undefined || deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((value, at) => !Object.is(value, previous.deps[at]));
      if (!changed) return;
      store.list[index] = { deps, cleanup: previous?.cleanup };
      pendingEffects.push(() => {
        if (typeof store.list[index]?.cleanup === 'function') store.list[index].cleanup();
        const cleanup = effect();
        if (store.list[index] !== undefined) store.list[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      });
    },
    useMemo(factory, deps) {
      const store = slotFor(handle().type);
      const index = store.index++;
      const previous = store.list[index];
      const changed = previous === undefined || deps === undefined
        || deps.some((value, at) => !Object.is(value, previous.deps[at]));
      if (changed) store.list[index] = { deps, value: factory() };
      return store.list[index].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
  };

  const pendingEffects = [];
  let ticking = false;
  function schedule() {
    if (ticking) return;
    ticking = true;
    queueMicrotask(() => {
      ticking = false;
      draw();
      flush();
    });
  }
  function flush() {
    while (pendingEffects.length > 0) {
      const run = pendingEffects.shift();
      try { run(); } catch (error) { console.error(error); }
    }
  }

  function toDom(node) {
    if (node === null || node === undefined || node === false || node === true) return document.createTextNode('');
    if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node));
    if (Array.isArray(node)) {
      const fragment = document.createDocumentFragment();
      node.forEach((child) => fragment.appendChild(toDom(child)));
      return fragment;
    }
    if (node.type === React.Fragment) {
      const fragment = document.createDocumentFragment();
      node.children.forEach((child) => fragment.appendChild(toDom(child)));
      return fragment;
    }
    if (typeof node.type === 'function') {
      const previousRender = rootRender;
      rootRender = { type: node.type };
      slotFor(node.type).index = 0;
      const rendered = node.type({ ...node.props, children: node.children });
      rootRender = previousRender;
      return toDom(rendered);
    }
    const element = document.createElement(String(node.type));
    for (const [key, value] of Object.entries(node.props ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'className') element.className = value;
      else if (key === 'style') Object.assign(element.style, value);
      else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'key' || key === 'children') continue;
      else element.setAttribute(key, String(value));
    }
    node.children.forEach((child) => element.appendChild(toDom(child)));
    return element;
  }

  function draw() {
    if (rootNode === null || rootRender === null) return
    const store = slotFor(rootRender.type)
    store.index = 0
    const tree = rootRender.type(rootRender.props)
    rootNode.textContent = ''
    rootNode.appendChild(toDom(tree))
  }

  window.React = React;
  /** Mount one component into a node and keep it live. */
  window.mountReact = (component, props, node) => {
    rootNode = node;
    rootRender = { type: component, props };
    draw();
    flush();
  };
  window.__rerender = schedule;
})();

/* ---- the Host half, stubbed: one frontend entry in each interesting state ---- */
const NOW = Date.now();
const entries = [
  { id: 'e1', name: 'sso-login', projectPath: 'D:\\\\project\\\\sso-login', stack: 'frontend', kind: 'script',
    pm: 'npm', script: 'serve', command: 'npm run serve', port: 5173, priority: 0, status: 'stopped', phase: 'stopped',
    branch: 'old', changes: 'clean', warnings: [], tail: null, runPort: null, url: null, lanUrl: null,
    nodeVersion: '14.21.3', actualNode: null, batchEnabled: true, profile: null, inspectedAt: NOW },
  { id: 'e2', name: 'gb-web', projectPath: 'D:\\\\project\\\\gb\\\\gb-web', stack: 'frontend', kind: 'script',
    pm: 'npm', script: 'serve:slim.dev', command: 'npm run serve:slim.dev', port: 5174, priority: 1, status: 'stopped',
    phase: 'stopped', branch: 'feat/zt_fit', changes: 'clean', warnings: [], tail: null, runPort: null, url: null,
    lanUrl: null, nodeVersion: '14.21.3', actualNode: null, batchEnabled: true, profile: null, inspectedAt: NOW },
  { id: 'e3', name: 'gb-frontend-design', projectPath: 'D:\\\\project\\\\gb\\\\gb-frontend-design', stack: 'frontend',
    kind: 'script', pm: 'pnpm', script: 'dev:slim.dev', command: 'pnpm run dev:slim.dev', port: 5175, priority: 1,
    status: 'running', phase: 'ready', branch: 'dev', changes: 'clean', warnings: [], tail: null, runPort: 5175,
    url: 'http://localhost:5175', lanUrl: 'http://192.168.1.10:5175', nodeVersion: '24.14.1', actualNode: '24.14.1',
    batchEnabled: true, profile: null, inspectedAt: NOW },
  { id: 'e4', name: 'feat-risk', projectPath: 'D:\\\\project\\\\gb\\\\gb-frontend-design-worktrees\\\\feat-risk',
    stack: 'frontend', kind: 'script', pm: 'pnpm', script: 'dev:slim.dev', command: 'pnpm run dev:slim.dev',
    port: 5176, priority: 2, status: 'stopped', phase: 'stopped', branch: 'feat/risk', changes: 'dirty', warnings: [],
    tail: null, runPort: null, url: null, lanUrl: null, nodeVersion: '24.14.1', actualNode: null, batchEnabled: true,
    profile: null, inspectedAt: NOW },
];
const payloads = {
  'slim-workbench/launch/state': { entries, batch: { enabled: true, total: 3 } },
  'slim-workbench/state': { platform: 'win32', supported: true, available: true, nvmVersion: '1.1.10',
    nvmHome: 'F:\\\\nvm', symlink: 'F:\\\\nodejs', symlinkPresent: true, checked: [], current: '24.14.1',
    versions: [{ version: '24.14.1' }, { version: '14.21.3' }], readAt: NOW },
  'slim-workbench/releases': { versions: [] },
};
window.fetch = (url) => {
  const asked = String(url).split('?')[0]
  const name = Object.keys(payloads).find((candidate) => asked.endsWith(candidate)) ?? ''
  const body = payloads[name] ?? {}
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) })
};
window.__DICTIONARIES__ = null;
</script>
<script src="./client.js"></script>
<script>
/* ---- mount the panel the way the shell does, then measure the layout ---- */
(async function boot() {
  const pre = document.getElementById('metrics');
  const write = (value) => { pre.textContent = JSON.stringify(value, null, 2); };
  const hop = () => Promise.resolve();
  try {
    const registered = window.__REGISTERED__;
    if (registered === null || registered === undefined) throw new Error('client.js never called __ModuleLoader__.load');
    const plugin = registered.factory((name) => {
      if (name === 'react') return window.React;
      throw new Error('unexpected require: ' + name);
    });
    let dictionaries = null;
    let mainComponent = null;
    plugin.apply({
      effect: (run) => { const cleanup = run(); return cleanup; },
      locale: {
        register: (_namespace, value) => { dictionaries = value; return () => {}; },
        bind: () => (key) => dictionaries.zh[key] ?? dictionaries.en[key] ?? key,
      },
      slots: {
        inject: (_name, callback) => { callback(); },
        register: (registration, component) => {
          if (registration.name === 'main') mainComponent = component;
          return () => {};
        },
      },
      get: () => null,
    });
    window.__DICTIONARIES__ = dictionaries;
    window.mountReact(mainComponent, { t: (key) => dictionaries.zh[key] ?? dictionaries.en[key] ?? key },
      document.getElementById('pane'));
    // The workbench opens on Node; the query string asks for another system.
    await hop();
    const wanted = Number(new URLSearchParams(location.search).get('pane') ?? '1');
    const nav = document.querySelectorAll('.wbm-nav-item');
    if (nav.length > wanted && Number.isInteger(wanted) && wanted >= 0) nav[wanted].click();
    // The stubbed fetch resolves in a microtask, so a chain of hops is enough to let the
    // panel paint both the frame and the table — no timers, which a headless dump may skip.
    for (let index = 0; index < 40; index += 1) await hop();
    write(window.__ERRORS__.length > 0 ? { errors: window.__ERRORS__, measured: window.measure() } : window.measure());
  } catch (error) {
    write({ error: String(error && error.message ? error.message : error), errors: window.__ERRORS__ });
  }
})();

/** Measure what the browser did. */
window.measure = () => {
  const pane = document.getElementById('pane');
  const scroll = pane.querySelector('.ndv-scroll');
  const table = pane.querySelector('.lch-table');
  const headers = [...pane.querySelectorAll('.lch-table thead th')];
  const row = pane.querySelector('.lch-trow');
  const cells = row === null ? [] : [...row.children];
  const actions = [...(row?.querySelectorAll('.lch-actions .ndv-button') ?? []),
    ...(row?.querySelectorAll('.lch-actions .ndv-caret') ?? [])];
  const nav = [...pane.querySelectorAll('.wbm-nav-item')];
  const result = {
    paneWidth: Math.round(pane.getBoundingClientRect().width),
    navItems: nav.length,
    activeNav: nav.findIndex((item) => item.getAttribute('data-active') === 'true'),
    headTitle: pane.querySelector('.ndv-head-title')?.textContent ?? null,
    bodyText: (pane.querySelector('.ndv-body')?.textContent ?? '').slice(0, 160),
    notes: [...pane.querySelectorAll('.ndv-note, .ndv-empty-text, .lch-hint')].map((node) => node.textContent),
    hasTable: pane.querySelector('.ndv-table') !== null,
    fetchType: typeof window.fetch,
    fetchImpl: String(window.fetch).slice(0, 60),
    errors: window.__ERRORS__,
    rows: pane.querySelectorAll('.lch-trow').length,
    columns: headers.length,
    headerLabels: headers.map((th) => th.textContent),
    columnWidths: headers.map((th) => Math.round(th.getBoundingClientRect().width)),
    tableWidth: table === null ? null : Math.round(table.getBoundingClientRect().width),
    scrollClientWidth: scroll === null ? null : Math.round(scroll.clientWidth),
    scrollWidth: scroll === null ? null : Math.round(scroll.scrollWidth),
    horizontalScroll: scroll === null ? null : scroll.scrollWidth > scroll.clientWidth,
    rowHeight: row === null ? null : Math.round(row.getBoundingClientRect().height),
    actionButtonTops: actions.map((node) => Math.round(node.getBoundingClientRect().top)),
    actionsWrapped: new Set(actions.map((node) => Math.round(node.getBoundingClientRect().top))).size > 1,
    overflowingCells: cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
  };
  if (scroll !== null) {
    const box = scroll.getBoundingClientRect();
    scroll.scrollLeft = 260;
    const frozenLeft = cells[0]?.getBoundingClientRect();
    const frozenRight = cells[cells.length - 1]?.getBoundingClientRect();
    result.afterScroll = {
      scrollLeft: Math.round(scroll.scrollLeft),
      firstColumnOffset: frozenLeft === undefined ? null : Math.round(frozenLeft.left - box.left),
      lastColumnOffset: frozenRight === undefined ? null : Math.round(box.right - frozenRight.right),
      firstColumnVisible: frozenLeft === undefined ? null : frozenLeft.left >= box.left - 1,
      lastColumnVisible: frozenRight === undefined ? null : frozenRight.right <= box.right + 1,
    };
    scroll.scrollLeft = 0;
  }
  // Dialog footers: the buttons must sit against the right edge, not float at the left.
  // The dialog itself is not rendered here, so this measures the real stylesheet against
  // the same markup the dialog builds.
  const probe = document.createElement('div');
  probe.className = 'lch-form-actions';
  probe.style.width = '480px';
  const cancel = document.createElement('button');
  cancel.className = 'ndv-button';
  cancel.textContent = 'cancel';
  const confirm = document.createElement('button');
  confirm.className = 'ndv-button lch-danger-solid';
  confirm.textContent = 'delete';
  probe.append(cancel, confirm);
  pane.appendChild(probe);
  const probeBox = probe.getBoundingClientRect();
  const cancelBox = cancel.getBoundingClientRect();
  const confirmBox = confirm.getBoundingClientRect();
  result.dialogFooter = {
    leftGap: Math.round(cancelBox.left - probeBox.left),
    rightGap: Math.round(probeBox.right - confirmBox.right),
  };
  probe.remove();
  // The same question for the Node pane's confirmation, which has its own footer class.
  const nodeProbe = document.createElement('div');
  nodeProbe.className = 'ndv-modal-actions';
  nodeProbe.style.width = '400px';
  const nodeCancel = document.createElement('button');
  nodeCancel.className = 'ndv-button';
  nodeCancel.textContent = 'cancel';
  const nodeConfirm = document.createElement('button');
  nodeConfirm.className = 'ndv-button ndv-danger-solid';
  nodeConfirm.textContent = 'remove';
  nodeProbe.append(nodeCancel, nodeConfirm);
  pane.appendChild(nodeProbe);
  const nodeBox = nodeProbe.getBoundingClientRect();
  result.nodeFooter = {
    leftGap: Math.round(nodeCancel.getBoundingClientRect().left - nodeBox.left),
    rightGap: Math.round(nodeBox.right - nodeConfirm.getBoundingClientRect().right),
    dangerBackground: getComputedStyle(nodeConfirm).backgroundColor,
    dangerColor: getComputedStyle(nodeConfirm).color,
    dangerRuleLoaded: [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((rule) => String(rule.cssText).includes('ndv-danger-solid'))
      } catch {
        return false
      }
    }),
    tokenValue: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-state-error-primary'),
  };
  nodeProbe.remove();
  return result;
};
</script>
</body></html>`
}

const chrome = findChrome()
if (chrome === null) {
  console.error('no Chrome or Edge found; set CHROME=<path>')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'swb-visual-'))
const html = join(work, 'index.html')
writeFileSync(html, page(), 'utf8')
writeFileSync(join(work, 'client.js'), readFileSync(join(root, 'client.js'), 'utf8'), 'utf8')

/**
 * Render the page at one window size and read the metrics back.
 * @param {number} windowWidth the window width in CSS pixels.
 * @param {string} name a name for this run's files.
 * @returns {{ metrics: object, screenshot: string }} what the browser measured.
 */
function measureAt(windowWidth, name) {
  const shot = join(work, name + '.png')
  const common = ['--headless=new', '--disable-gpu', '--allow-file-access-from-files',
    `--window-size=${windowWidth},${height}`, '--virtual-time-budget=5000', '--no-first-run',
    '--no-default-browser-check']
  const url = `file:///${html.replace(/\\/g, '/')}`
  execFileSync(chrome, [...common, `--user-data-dir=${join(work, 'profile-' + name)}`, `--screenshot=${shot}`, url],
    { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] })
  const dom = execFileSync(chrome, [...common, `--user-data-dir=${join(work, 'profile-' + name + '-dom')}`, '--dump-dom', url],
    { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] })
  const match = dom.match(/<pre id="metrics"[^>]*>([\s\S]*?)<\/pre>/)
  if (match === null) {
    writeFileSync(join(work, name + '-dom.html'), dom, 'utf8')
    throw new Error(`no metrics at ${windowWidth}px; DOM saved to ${join(work, name + '-dom.html')}`)
  }
  const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  return { metrics: JSON.parse(decoded), screenshot: shot }
}

/**
 * Render one pane into `docs/` as a still, for the plugin's detail page.
 *
 * Same page the measurements use, so a preview can never show something the code does not
 * draw. The data is the stub set in this file; the styling is the plugin's own.
 * @param {'node' | 'frontend'} pane which system to open.
 * @param {string} target the file to write.
 * @param {number} windowWidth the window width in CSS pixels.
 * @returns {void}
 */
function renderPreview(pane, target, windowWidth) {
  const profile = join(work, `profile-preview-${pane}`)
  const url = `file:///${html.replace(/\\/g, '/')}?pane=${pane === 'node' ? 0 : 1}`
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files',
    `--window-size=${windowWidth},${PREVIEW_HEIGHT}`, '--virtual-time-budget=5000', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${profile}`, `--screenshot=${target}`, url],
  { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] })
  console.log('preview:', target)
}

const problems = []
for (const windowWidth of [width, 1040]) {
  const { metrics, screenshot } = measureAt(windowWidth, `w${windowWidth}`)
  console.log(`\n--- window ${windowWidth}px (pane ${metrics.paneWidth}px) ${screenshot}`)
  console.log(JSON.stringify({
    rows: metrics.rows,
    columns: metrics.columns,
    columnWidths: metrics.columnWidths,
    tableWidth: metrics.tableWidth,
    horizontalScroll: metrics.horizontalScroll,
    scrollClientWidth: metrics.scrollClientWidth,
    scrollWidth: metrics.scrollWidth,
    rowHeight: metrics.rowHeight,
    actionsWrapped: metrics.actionsWrapped,
    overflowingCells: metrics.overflowingCells,
    afterScroll: metrics.afterScroll,
    dialogFooter: metrics.dialogFooter,
    nodeFooter: metrics.nodeFooter,
  }, null, 2))
  const problemsHere = []
  if (metrics.rows !== 4) problemsHere.push(`expected 4 rows, measured ${metrics.rows}`)
  if (metrics.columns !== 8) problemsHere.push(`expected 8 columns, measured ${metrics.columns}`)
  if (metrics.actionsWrapped) problemsHere.push('action buttons wrapped onto two lines')
  if (metrics.overflowingCells > 0) problemsHere.push(`${metrics.overflowingCells} cell(s) overflow their column`)
  if (metrics.horizontalScroll && metrics.scrollWidth - metrics.scrollClientWidth >= 100) {
    if (metrics.afterScroll.scrollLeft < 100) problemsHere.push('the middle did not scroll when it should')
  }
  if (metrics.horizontalScroll) {
    if (!metrics.afterScroll.firstColumnVisible) problemsHere.push('the project column scrolled away')
    if (!metrics.afterScroll.lastColumnVisible) problemsHere.push('the action column scrolled away')
  }
  // 8px is the footer's own gap; anything bigger means the buttons are not against the edge.
  if (metrics.dialogFooter.rightGap > 12) {
    problemsHere.push(`dialog footer buttons sit ${metrics.dialogFooter.rightGap}px from the right edge`)
  }
  if (metrics.nodeFooter.rightGap > 12) {
    problemsHere.push(`Node dialog buttons sit ${metrics.nodeFooter.rightGap}px from the right edge`)
  }
  // A destructive button with no background is a theming failure, not a preference:
  // `rgb(...)` is opaque, `rgba(..., 0)` is what a lost declaration looks like.
  if (!String(metrics.nodeFooter.dangerBackground).startsWith('rgb(')) {
    problemsHere.push(`the destructive button has no background (${metrics.nodeFooter.dangerBackground})`)
  }
  for (const message of problemsHere) problems.push(`${windowWidth}px: ${message}`)
}

if (problems.length > 0) {
  console.error('\nlayout problems:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('\nlayout ok at both widths')
if (docs) {
  // Wide enough that the table fits without scrolling: a preview is not the place to
  // demonstrate the scrollbar, and a clipped column reads as a bug.
  renderPreview('frontend', join(root, 'docs/preview-frontend.png'), 1720)
  renderPreview('node', join(root, 'docs/preview-node.png'), 1720)
}
if (!keep) {
  for (const name of ['profile-w' + width, 'profile-w' + width + '-dom', 'profile-w1040', 'profile-w1040-dom']) {
    rmSync(join(work, name), { recursive: true, force: true })
  }
}
