/**
 * Behaviour tests for the launcher's pure half.
 *
 * These are the rules that fail silently when they break: a stored record migrated
 * wrong, a version or port accepted when it should not be, a Spring port read out of
 * the wrong block, a command composed from the wrong tool. None of them throw — they
 * just make the panel say something untrue — so they get tests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { internals } from '../launcher.js'

/**
 * Create a throwaway project directory.
 * @param {(directory: string) => void} [fill] writes the fixture's files.
 * @returns {string} the directory.
 */
function project(fill) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swb-test-'))
  if (typeof fill === 'function') fill(directory)
  return directory
}

/**
 * Write one file under a project directory, creating its parents.
 * @param {string} directory project directory.
 * @param {string} relative file path inside it.
 * @param {string} content file content.
 * @returns {void}
 */
function put(directory, relative, content) {
  const target = path.join(directory, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

test('normalizeEntry migrates the version-1 command shape', () => {
  const entry = internals.normalizeEntry({ name: 'legacy', cwd: 'D:\\proj', command: 'npm run dev' }, 0)
  assert.equal(entry.projectPath, 'D:\\proj')
  assert.equal(entry.kind, 'custom')
  assert.equal(entry.customCommand, 'npm run dev')
  assert.equal(entry.priority, 1)
  assert.equal(entry.batchEnabled, true)
})

test('normalizeEntry drops what it cannot represent', () => {
  assert.equal(internals.normalizeEntry(null, 0), null)
  assert.equal(internals.normalizeEntry({ command: 'npm run dev' }, 0), null)
  // A script entry with no package manager and no command to fall back on is unusable.
  assert.equal(internals.normalizeEntry({ name: 'x', projectPath: 'D:\\p', kind: 'script' }, 0), null)
})

test('normalizeEntry keeps a script entry runnable only with both choices', () => {
  const runnable = internals.normalizeEntry({
    name: 'web', projectPath: 'D:\\p', kind: 'script', pm: 'pnpm', script: 'dev',
  }, 0)
  assert.equal(runnable.kind, 'script')
  assert.equal(runnable.pm, 'pnpm')
  // The legacy batch key is still honoured, and its absence means participation.
  assert.equal(internals.normalizeEntry({ name: 'a', projectPath: 'D:\\p', kind: 'custom', customCommand: 'x', batch: false }, 0).batchEnabled, false)
  assert.equal(internals.normalizeEntry({ name: 'a', projectPath: 'D:\\p', kind: 'custom', customCommand: 'x' }, 0).batchEnabled, true)
})

test('normalizePort accepts 1-65535 and rejects everything else', () => {
  assert.equal(internals.normalizePort(5173), 5173)
  assert.equal(internals.normalizePort('3000'), 3000)
  assert.equal(internals.normalizePort(1), 1)
  assert.equal(internals.normalizePort(65535), 65535)
  assert.equal(internals.normalizePort(0), null)
  assert.equal(internals.normalizePort(65536), null)
  assert.equal(internals.normalizePort(8080.5), null)
  assert.equal(internals.normalizePort('abc'), null)
  assert.equal(internals.normalizePort(null), null)
})

test('normalizePriority defaults to 1 and clamps to 0-99', () => {
  assert.equal(internals.normalizePriority(undefined), 1)
  assert.equal(internals.normalizePriority(''), 1)
  assert.equal(internals.normalizePriority('x'), 1)
  assert.equal(internals.normalizePriority(-5), 0)
  assert.equal(internals.normalizePriority(1000), 99)
  assert.equal(internals.normalizePriority('3'), 3)
})

test('normalizeVersion accepts a bare or v-prefixed triple only', () => {
  assert.equal(internals.normalizeVersion('v20.11.1'), '20.11.1')
  assert.equal(internals.normalizeVersion(' 20.11.1 '), '20.11.1')
  assert.equal(internals.normalizeVersion('V18.0.0'), '18.0.0')
  assert.equal(internals.normalizeVersion('20.11'), null)
  assert.equal(internals.normalizeVersion('latest'), null)
  assert.equal(internals.normalizeVersion(null), null)
})

test('detectPort reads the announcements a dev server prints', () => {
  assert.equal(internals.detectPort('  ➜  Local:   http://localhost:5173/'), 5173)
  assert.equal(internals.detectPort('listening on http://127.0.0.1:8080'), 8080)
  assert.equal(internals.detectPort('bound to http://0.0.0.0:3000'), 3000)
  assert.equal(internals.detectPort('open http://[::1]:4200'), 4200)
  assert.equal(internals.detectPort('ready at localhost:9000'), 9000)
  // Anything else is not an announcement this plugin may act on.
  assert.equal(internals.detectPort('Tomcat started on port(s): 8080 (http)'), null)
  assert.equal(internals.detectPort('see http://example.com:9999'), null)
  assert.equal(internals.detectPort('nothing here'), null)
})

test('stripAnsi drops colour and control sequences', () => {
  assert.equal(internals.stripAnsi('\u001b[32mready\u001b[39m'), 'ready')
  assert.equal(internals.stripAnsi('\u001b]0;title\u0007text'), 'text')
  assert.equal(internals.stripAnsi('50%\r75%'), '50%75%')
})

test('logTail keeps the last non-empty line, logLines keeps the shape', () => {
  assert.equal(internals.logTail({ chunks: ['line one\n', 'line two\n', '\n'], size: 20 }), 'line two')
  assert.equal(internals.logTail(undefined), '')
  const log = { chunks: ['\u001b[36mfirst\u001b[39m\nsecond\nthird\n'], size: 30 }
  assert.equal(internals.logLines(log, 2, false), 'second\nthird')
  assert.equal(internals.logLines(log, 1, true), 'third')
})

test('commandOf composes the command the user chose', () => {
  assert.equal(internals.commandOf({ kind: 'script', stack: 'frontend', pm: 'pnpm', script: 'dev:slim.dev' }), 'pnpm run dev:slim.dev')
  assert.equal(internals.commandOf({ kind: 'custom', stack: 'frontend', customCommand: 'pnpm --filter web dev' }), 'pnpm --filter web dev')
  assert.equal(internals.commandOf({ kind: 'custom', stack: 'backend', customCommand: 'mvn -q spring-boot:run' }), 'mvn -q spring-boot:run')
  // A script entry with no package manager or script never silently runs something else.
  assert.equal(internals.commandOf({ kind: 'script', stack: 'frontend', pm: null, script: null, customCommand: null }), '')
})

test('buildProgramOf prefers a complete wrapper and falls back to the global tool', () => {
  const bare = project()
  const maven = { builder: 'maven', projectPath: bare }
  const gradle = { builder: 'gradle', projectPath: bare }
  try {
    // No wrapper on disk: the global executable is what such a project actually has.
    assert.equal(internals.buildProgramOf(maven), 'mvn')
    assert.equal(internals.buildProgramOf(gradle), 'gradle')
    // A wrapper without its configuration would fail before reaching Maven.
    put(bare, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw', '@echo off\n')
    assert.equal(internals.buildProgramOf(maven), 'mvn')
    put(bare, path.join('.mvn', 'wrapper', 'maven-wrapper.properties'), 'distributionUrl=https://example.invalid/maven.zip\n')
    assert.equal(internals.buildProgramOf(maven), process.platform === 'win32' ? 'mvnw.cmd' : './mvnw')
    put(bare, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew', '#!/bin/sh\n')
    assert.equal(internals.buildProgramOf(gradle), process.platform === 'win32' ? 'gradlew.bat' : './gradlew')
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

test('inspectBackend reads what Spring Boot itself would read', (t) => {
  const directory = project((root) => {
    put(root, 'pom.xml', [
      '<project>',
      '  <parent>',
      '    <groupId>org.springframework.boot</groupId>',
      '    <artifactId>spring-boot-starter-parent</artifactId>',
      '  </parent>',
      '  <artifactId>demo-service</artifactId>',
      '  <properties><java.version>21</java.version></properties>',
      '</project>',
    ].join('\n'))
    // A second `port:` that belongs to redis, not to the application's own connector.
    put(root, path.join('src', 'main', 'resources', 'application.yaml'), [
      'server:',
      '  port: 8080',
      'spring:',
      '  redis:',
      '    port: 6379',
      '  profiles:',
      '    active: dev',
    ].join('\n'))
    put(root, path.join('src', 'main', 'resources', 'application-dev.yaml'), 'server:\n  port: 9090\n')
  })
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const facts = internals.inspectBackend(directory)
  assert.equal(facts.maven.present, true)
  assert.equal(facts.maven.artifactId, 'demo-service')
  assert.equal(facts.maven.javaVersion, '21')
  assert.equal(facts.serverPort, 8080)
  assert.equal(facts.activeProfile, 'dev')
  assert.deepEqual(facts.profiles, ['dev'])
  assert.equal(facts.profilePorts.dev, 9090)
  assert.deepEqual(facts.warnings, [])
})

test('inspectBackend explains an empty directory instead of guessing', (t) => {
  const directory = project()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const facts = internals.inspectBackend(directory)
  assert.equal(facts.maven.present, false)
  assert.equal(facts.gradle.present, false)
  assert.equal(facts.serverPort, null)
  assert.equal(facts.profiles.length, 0)
  const codes = facts.warnings.map((warning) => warning.code)
  assert.deepEqual(codes, ['no-backend-build', 'no-server-port'])
})

test('validateEntry refuses what would not run', async (t) => {
  const directory = project((root) => {
    put(root, 'package.json', JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }))
  })
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const context = { defaultProjectPath: directory, node: { installed: () => ['20.11.1'] } }
  const refusal = async (input) => {
    const result = await internals.validateEntry(input, context)
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(input)}`)
    return result.code
  }

  assert.equal(await refusal({ projectPath: directory }), 'invalid-name')
  assert.equal(await refusal({ name: 'x', projectPath: 'relative/dir' }), 'invalid-directory')
  assert.equal(await refusal({ name: 'x', projectPath: path.join(directory, 'missing') }), 'missing-directory')
  assert.equal(await refusal({ name: 'x', projectPath: directory, kind: 'script', script: 'dev' }), 'invalid-pm')
  assert.equal(await refusal({ name: 'x', projectPath: directory, kind: 'script', pm: 'npm' }), 'invalid-script')
  assert.equal(await refusal({ name: 'x', projectPath: directory, kind: 'script', pm: 'npm', script: 'nope' }), 'script-missing')
  assert.equal(await refusal({ name: 'x', projectPath: directory, kind: 'custom', customCommand: '' }), 'invalid-command')
  assert.equal(await refusal({ name: 'x', projectPath: directory, stack: 'backend', kind: 'script' }), 'invalid-builder')
  assert.equal(await refusal({ name: 'x', projectPath: directory, stack: 'backend', kind: 'script', builder: 'maven' }), 'no-pom')
  assert.equal(
    await refusal({ name: 'x', projectPath: directory, kind: 'custom', customCommand: 'npm run dev', nodeVersion: '18.0.0' }),
    'node-not-installed',
  )
})

test('validateEntry keeps a real choice intact', async (t) => {
  const directory = project((root) => {
    put(root, 'package.json', JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }))
  })
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const context = { defaultProjectPath: directory, node: { installed: () => ['20.11.1'] } }
  const result = await internals.validateEntry({
    name: 'gb-web',
    projectPath: directory,
    stack: 'frontend',
    kind: 'script',
    pm: 'pnpm',
    script: 'dev',
    port: '5173',
    nodeVersion: 'v20.11.1',
  }, context)
  assert.equal(result.ok, true)
  assert.equal(result.value.pm, 'pnpm')
  assert.equal(result.value.script, 'dev')
  assert.equal(result.value.port, 5173)
  assert.equal(result.value.nodeVersion, '20.11.1')
  assert.equal(result.value.batchEnabled, true)
  // No priority in the request: the caller decides whether to keep the stored one.
  assert.equal(result.value.priority, undefined)
  // A value that is present is still normalized, so the field keeps working when reused.
  const kept = await internals.validateEntry({
    name: 'gb-web',
    projectPath: directory,
    kind: 'custom',
    customCommand: 'npm run dev',
    priority: '0',
  }, context)
  assert.equal(kept.value.priority, 0)
})
