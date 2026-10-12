import assert from 'node:assert/strict'
import test from 'node:test'

import { capClaudeMode, claudeModeFor, claudeModeForSession } from '../src/permission.js'

test('each permission preset maps to the CLI mode it allows', () => {
  assert.equal(claudeModeFor('read-only', 'ask'), 'read-only')
  assert.equal(claudeModeFor('workspace-write', 'ask'), 'edit')
  assert.equal(claudeModeFor('danger-full-access', 'never'), 'full')
  // The CLI cannot ask the harness user, so a session that still asks keeps its checks.
  assert.equal(claudeModeFor('danger-full-access', 'ask'), 'edit')
  assert.equal(claudeModeFor(undefined, 'never'), undefined)
})

test('a session mode is read from the host permission services', () => {
  const session = { id: 's1' }
  const seen = []
  const ctx = {
    get: name => ({
      sandboxPolicy: { resolve: request => (seen.push(request.session), { mode: 'danger-full-access' }) },
      approval: { effectivePolicy: target => (seen.push(target), 'never') },
    })[name],
  }
  assert.equal(claudeModeForSession(ctx, session), 'full')
  assert.deepEqual(seen, [session, session])
  assert.equal(claudeModeForSession(ctx, undefined), undefined)
  assert.equal(claudeModeForSession({ get: () => undefined }, session), undefined)
  assert.equal(claudeModeForSession({ get: () => { throw new Error('inactive') } }, session), undefined)
})

test('a requested mode never exceeds the session ceiling', () => {
  assert.equal(capClaudeMode('full', 'edit'), 'edit')
  assert.equal(capClaudeMode('read-only', 'full'), 'read-only')
  assert.equal(capClaudeMode(undefined, 'full'), 'full')
  assert.equal(capClaudeMode('full', undefined), 'full')
  assert.equal(capClaudeMode(undefined, undefined), undefined)
})
