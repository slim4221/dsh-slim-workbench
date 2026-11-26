/**
 * Host half of the nvm switcher and its Workbench systems.
 *
 * Two operation sets, each reachable from the browser over `exact` routes on the
 * composition's `webServer`, every request asking the host's `connection` gate
 * for a rejection first (its Host/Origin fence plus the browser login):
 *
 * - nvm-windows: state, released versions, switch, install, remove. The model
 *   reaches the same functions through the `node_version` tool.
 * - the launcher: user-defined commands started, watched, and stopped. There is
 *   deliberately no tool for it — it runs arbitrary user-authored commands, and
 *   starting long-lived processes is a user action, not a model one.
 *
 * The only outbound request is the release index at `https://nodejs.org/dist/index.json`,
 * the same index nvm-windows installs from.
 *
 * Only `node:` builtins and local modules are imported: a bundle installed from
 * a local directory resolves bare imports from its own directory, where no
 * Harness package exists.
 */

import {
  inspectProject, probePort, readLauncherState, refreshEntry, removeEntry, saveEntry, setBatchEnabled, startEntry,
  stopAll, stopEntry,
} from './launcher.js'
import {
  currentLinkedVersion, describeState, installedVersions, installInfo, installVersion, readReleases, readState,
  switchTo, uninstallVersion, versionDirectory,
} from './nvm.js'

/** Route paths: nvm. */
const ROUTE_STATE = '/slim-workbench/state'
const ROUTE_RELEASES = '/slim-workbench/releases'
const ROUTE_USE = '/slim-workbench/use'
const ROUTE_INSTALL = '/slim-workbench/install'
const ROUTE_UNINSTALL = '/slim-workbench/uninstall'

/** Route paths: launcher. */
const ROUTE_LAUNCH_STATE = '/slim-workbench/launch/state'
const ROUTE_LAUNCH_SAVE = '/slim-workbench/launch/save'
const ROUTE_LAUNCH_REMOVE = '/slim-workbench/launch/remove'
const ROUTE_LAUNCH_START = '/slim-workbench/launch/start'
const ROUTE_LAUNCH_STOP = '/slim-workbench/launch/stop'
const ROUTE_LAUNCH_INSPECT = '/slim-workbench/launch/inspect'
const ROUTE_LAUNCH_PROBE = '/slim-workbench/launch/probe'
const ROUTE_LAUNCH_REFRESH = '/slim-workbench/launch/refresh'
const ROUTE_LAUNCH_BATCH_ENABLED = '/slim-workbench/launch/batch-enabled'

/** Request bodies are one small JSON object; anything larger is hostile. */
const MAX_BODY_BYTES = 8 * 1024

/** How many released versions the tool's text summary lists. */
const RELEASES_IN_SUMMARY = 20

/** The tool registry, and nothing optional: the routes wait for `webServer` instead. */
export const inject = ['tools']

/**
 * Read this row's configuration, without validating it: every field is an
 * optional path override, and an invalid one only loses its own preference.
 * @param {unknown} config the row's config mapping.
 * @returns {{ nvmHome?: string, nvmExe?: string, symlink?: string }} path overrides.
 */
function readOverrides(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const text = (key) => (typeof source[key] === 'string' && source[key].trim() !== '' ? source[key].trim() : undefined)
  return { nvmHome: text('nvmHome'), nvmExe: text('nvmExe'), symlink: text('symlink') }
}

/**
 * Answer one request with JSON and no caching.
 * @param {import('node:http').ServerResponse} response the response to complete.
 * @param {number} status HTTP status.
 * @param {unknown} payload value to serialize.
 * @returns {void}
 */
function sendJson(response, status, payload) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(payload))
}

/**
 * Answer a request whose method the route does not serve.
 * @param {import('node:http').ServerResponse} response the response to complete.
 * @param {'GET' | 'POST'} allow the one served method.
 * @returns {void}
 */
function sendMethodNotAllowed(response, allow) {
  response.statusCode = 405
  response.setHeader('allow', allow)
  response.end()
}

/**
 * Read one header as a single trimmed string.
 * @param {string | string[] | undefined} value the raw header.
 * @returns {string | undefined} the value, if present.
 */
function firstHeader(value) {
  const text = Array.isArray(value) ? value[0] : value
  return typeof text === 'string' && text !== '' ? text : undefined
}

/**
 * Decide whether a request may reach these routes, using the host's own gate
 * when it is mounted.
 *
 * `connection` initializes asynchronously, so it is read per request rather
 * than at mount time. Without it, a loopback-only Host/Origin check stands in.
 * @param {{ get(name: string): unknown }} ctx the Host context.
 * @returns {(request: import('node:http').IncomingMessage) => 401 | 403 | undefined} the rejection, if any.
 */
function requestGateOf(ctx) {
  const loopbackOnly = (request) => {
    const host = firstHeader(request.headers.host)
    if (host === undefined) return 403
    const name = host.replace(/:\d+$/, '').toLowerCase()
    if (!(name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1')) return 403
    const origin = firstHeader(request.headers.origin)
    // A same-origin GET may omit Origin; a cross-site one never matches.
    if (origin === undefined) return undefined
    try {
      return new URL(origin).host.toLowerCase() === host.toLowerCase() ? undefined : 403
    } catch {
      return 403
    }
  }
  return (request) => {
    const connection = ctx.get('connection')
    const gate = connection === null || typeof connection !== 'object' ? undefined : connection.requestRejection
    if (typeof gate === 'function') {
      const rejection = gate.call(connection, request)
      return rejection === 401 || rejection === 403 ? rejection : undefined
    }
    return loopbackOnly(request)
  }
}

/**
 * Collect a bounded request body.
 * @param {import('node:http').IncomingMessage} request the request to drain.
 * @returns {Promise<string | null>} the UTF-8 body, or null past the ceiling.
 */
async function readBoundedBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      request.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Parse a JSON body that must be an object.
 * @param {string} text raw body.
 * @returns {Record<string, unknown> | null} the object, or null when malformed.
 */
function parseObjectBody(text) {
  try {
    const body = JSON.parse(text)
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null
  } catch {
    // A non-JSON body is exactly the malformed case.
    return null
  }
}

/**
 * Read the `id` query parameter of one request.
 * @param {import('node:http').IncomingMessage} request the request.
 * @returns {string | undefined} the id, if present.
 */
function queryId(request) {
  return queryParam(request, 'id')
}

/**
 * Read one query parameter of a request.
 * @param {import('node:http').IncomingMessage} request the request.
 * @param {string} name parameter name.
 * @returns {string | undefined} the value, if present.
 */
function queryParam(request, name) {
  try {
    const value = new URL(String(request.url), 'http://localhost').searchParams.get(name)
    return value === null || value.trim() === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * The directory a new launcher entry starts from.
 * @param {{ get(name: string): unknown }} ctx the Host context.
 * @returns {string} an absolute directory.
 */
function defaultProjectPathOf(ctx) {
  const service = ctx.get('workingDirectory')
  const value = service === null || typeof service !== 'object' ? undefined : service.defaultDirectory
  return typeof value === 'string' && value !== '' ? value : process.cwd()
}

/**
 * Render the release index as the text an agent reads.
 * @param {object} releases {@link readReleases} payload.
 * @returns {string} the human-readable summary.
 */
function describeReleases(releases) {
  const newest = releases.versions.slice(0, RELEASES_IN_SUMMARY).map((entry) => (
    entry.lts === null ? `v${entry.version}` : `v${entry.version} (LTS ${entry.lts})`
  ))
  return [
    `Released Node.js versions with a Windows build (${releases.versions.length} in the index, newest ${newest.length} listed), from ${releases.source}:`,
    newest.join(', '),
    'Pass one of these to action "install" with its version.',
  ].join('\n')
}

/**
 * The model-facing tool over the same nvm operations the Workbench uses.
 * @param {{ state: () => Promise<object>, releases: () => Promise<object> }} api the shared reads.
 * @param {{ use: (version: string) => Promise<object>, install: (version: string) => Promise<object>, uninstall: (version: string) => Promise<object> }} actions the shared mutations.
 * @returns {object} a registry-ready tool definition.
 */
function nodeVersionTool(api, actions) {
  /**
   * Run one versioned action and describe both the outcome and the new state.
   * @param {(version: string) => Promise<object>} action the shared operation.
   * @param {string} version requested version.
   * @param {(current: string) => string} headline the sentence that names the action.
   * @returns {Promise<{ summary: string }>} the tool result.
   */
  const runAction = async (action, version, headline) => {
    const outcome = await action(version)
    if (!outcome.ok) throw new Error(outcome.message)
    return { summary: `${headline(String(outcome.state?.current ?? version))}\n${describeState(outcome.state)}` }
  }
  return {
    name: 'node_version',
    description: 'Manage the machine-wide Node.js version nvm-windows links. Actions: "list" reads installed and current '
      + 'versions; "releases" lists the released versions that have a Windows build; "use" switches to an installed '
      + 'version; "install" downloads and installs a released version; "uninstall" removes an installed version that is '
      + 'not the one in use. A switch affects new processes only; already-running programs keep the version they started with.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'releases', 'use', 'install', 'uninstall'],
          description: 'list installed versions, list released versions, or use/install/uninstall one version.',
        },
        version: {
          type: 'string',
          description: 'Exact version for use/install/uninstall, for example "20.11.1".',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary'],
        properties: { summary: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
    },
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {}
      if (input.action === 'list') return { summary: describeState(await api.state()) }
      if (input.action === 'releases') return { summary: describeReleases(await api.releases()) }
      if (input.action === 'use' || input.action === 'install' || input.action === 'uninstall') {
        if (typeof input.version !== 'string' || input.version.trim() === '') {
          throw new Error(`\`version\` is required for action "${input.action}"`)
        }
        const version = input.version.trim()
        if (input.action === 'use') return runAction(actions.use, version, (current) => `Switched to Node.js ${current}.`)
        if (input.action === 'install') return runAction(actions.install, version, (current) => `Installed Node.js ${version}. Currently using ${current}.`)
        return runAction(actions.uninstall, version, (current) => `Removed Node.js ${version}. Currently using ${current}.`)
      }
      throw new Error('`action` must be "list", "releases", "use", "install", or "uninstall"')
    },
  }
}

/**
 * Register the routes and the tool.
 * @param {object} ctx the plugin context.
 * @param {unknown} config the row's config mapping.
 * @returns {void}
 */
export function apply(ctx, config) {
  const overrides = readOverrides(config)
  const reads = {
    state: () => readState(overrides),
    releases: () => readReleases(),
  }
  const actions = {
    use: (version) => switchTo(version, overrides),
    install: (version) => installVersion(version, overrides),
    uninstall: (version) => uninstallVersion(version, overrides),
  }
  const launcher = () => ({
    defaultProjectPath: defaultProjectPathOf(ctx),
    node: {
      install: () => installInfo(overrides),
      installed: () => installedVersions(overrides),
      current: () => currentLinkedVersion(overrides),
      directory: (version) => versionDirectory(version, overrides),
    },
  })
  ctx.effect(() => ctx.tools.register(nodeVersionTool(reads, actions)), 'slim-workbench: node_version tool')
  // A dev server the user started must not outlive the plugin that reports it.
  ctx.effect(() => () => { stopAll() }, 'slim-workbench: launcher runs')
  ctx.inject(['webServer'], (hostCtx) => {
    const reject = requestGateOf(ctx)

    /**
     * Serve one GET route behind the gate.
     * @param {string} path the route path.
     * @param {(request: import('node:http').IncomingMessage) => Promise<unknown>} load the payload to answer.
     * @returns {void}
     */
    const getRoute = (path, load) => {
      hostCtx.effect(() => hostCtx.webServer.register({
        kind: 'exact',
        path,
        handler: async (request, response) => {
          const rejection = reject(request)
          if (rejection !== undefined) {
            response.statusCode = rejection
            response.end()
            return
          }
          if (request.method !== 'GET') {
            sendMethodNotAllowed(response, 'GET')
            return
          }
          try {
            sendJson(response, 200, await load(request))
          } catch (error) {
            sendJson(response, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }), `slim-workbench: GET ${path}`)
    }

    /**
     * Serve one POST route that takes a JSON object, behind the gate.
     * @param {string} path the route path.
     * @param {(body: Record<string, unknown>) => Promise<unknown>} handle the operation.
     * @returns {void}
     */
    const postRoute = (path, handle) => {
      hostCtx.effect(() => hostCtx.webServer.register({
        kind: 'exact',
        path,
        handler: async (request, response) => {
          const rejection = reject(request)
          if (rejection !== undefined) {
            response.statusCode = rejection
            response.end()
            return
          }
          if (request.method !== 'POST') {
            sendMethodNotAllowed(response, 'POST')
            return
          }
          const essence = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
          if (essence !== 'application/json') {
            sendJson(response, 415, { ok: false, message: 'content-type must be application/json' })
            return
          }
          let text
          try {
            text = await readBoundedBody(request)
          } catch {
            sendJson(response, 400, { ok: false, message: 'request body unreadable' })
            return
          }
          if (text === null) {
            sendJson(response, 413, { ok: false, message: 'request body is too large' })
            return
          }
          const body = parseObjectBody(text)
          if (body === null) {
            sendJson(response, 400, { ok: false, message: 'request body must be a JSON object' })
            return
          }
          try {
            sendJson(response, 200, await handle(body))
          } catch (error) {
            sendJson(response, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }), `slim-workbench: POST ${path}`)
    }

    /**
     * Serve one POST route whose body names a Node.js version.
     * @param {string} path the route path.
     * @param {(version: string) => Promise<object>} action the operation to run.
     * @returns {void}
     */
    const versionRoute = (path, action) => {
      postRoute(path, async (body) => {
        const version = typeof body.version === 'string' ? body.version.trim() : ''
        if (version === '') return { ok: false, message: 'request body must be JSON with a string "version"' }
        return action(version)
      })
    }

    getRoute(ROUTE_STATE, reads.state)
    getRoute(ROUTE_RELEASES, reads.releases)
    versionRoute(ROUTE_USE, actions.use)
    versionRoute(ROUTE_INSTALL, actions.install)
    versionRoute(ROUTE_UNINSTALL, actions.uninstall)

    getRoute(ROUTE_LAUNCH_STATE, async () => readLauncherState(launcher()))
    getRoute(ROUTE_LAUNCH_INSPECT, async (request) => inspectProject({ dir: queryParam(request, 'dir') }))
    getRoute(ROUTE_LAUNCH_PROBE, async (request) => {
      const port = Number.parseInt(String(queryParam(request, 'port') ?? ''), 10)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, code: 'invalid-port', message: 'port must be 1-65535' }
      }
      return { ok: true, port, inUse: await probePort(port) }
    })
    postRoute(ROUTE_LAUNCH_SAVE, async (body) => saveEntry(body, launcher()))
    postRoute(ROUTE_LAUNCH_REFRESH, async (body) => refreshEntry(body, launcher()))
    postRoute(ROUTE_LAUNCH_BATCH_ENABLED, async (body) => setBatchEnabled(body, launcher()))
    postRoute(ROUTE_LAUNCH_REMOVE, async (body) => removeEntry(body, launcher()))
    postRoute(ROUTE_LAUNCH_START, async (body) => startEntry(body, launcher()))
    postRoute(ROUTE_LAUNCH_STOP, async (body) => stopEntry(body, launcher()))
  })
}
