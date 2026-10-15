import assert from 'node:assert/strict'
import test from 'node:test'

import { live } from '../src/preferences.js'

test('live marks a schema volatile on the schema version the host requires', async () => {
  const { default: z } = await import('@deepseek-ai/schemastery')
  assert.equal(live(z.string()).meta.volatile, true)
})

test('live names the shadowed schemastery instead of throwing a bare TypeError', () => {
  assert.throws(
    () => live({}),
    error => {
      assert.match(error.message, /@deepseek-ai\/schemastery \^3\.18\.4/)
      assert.match(error.message, /node_modules/)
      assert.match(error.message, /uninstall the plugin and install it again/)
      return true
    },
  )
})
