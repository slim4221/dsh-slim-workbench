/**
 * Behaviour tests for the version ordering the panel depends on.
 *
 * "Newest first" is a comparison, not a string sort: without the numeric comparison
 * v9.11.2 would sit above v20.11.1, and the Node pane would quietly recommend the
 * wrong version.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { internals } from '../nvm.js'

test('compareVersions orders numerically, not as text', () => {
  assert.ok(internals.compareVersions('20.11.1', '9.11.2') > 0)
  assert.ok(internals.compareVersions('9.11.2', '20.11.1') < 0)
  assert.equal(internals.compareVersions('20.11.1', '20.11.1'), 0)
  assert.ok(internals.compareVersions('20.11.1', '20.11.0') > 0)
  assert.ok(internals.compareVersions('20.2.0', '20.10.0') < 0)
})

test('sortSerials puts the newest first', () => {
  assert.deepEqual(
    internals.sortSerials(['20.9.0', '9.11.2', '20.11.1', '18.0.0']),
    ['20.11.1', '20.9.0', '18.0.0', '9.11.2'],
  )
  assert.deepEqual(
    internals.sortSerials(['14.21.3', '24.0.0', '24.14.1']),
    ['24.14.1', '24.0.0', '14.21.3'],
  )
})
