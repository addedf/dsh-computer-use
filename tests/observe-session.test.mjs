import test from 'node:test'
import assert from 'node:assert/strict'

import { withSession, CUA_SESSION } from '../lib/cua.js'

test('withSession adds the configured CUA session unless explicitly overridden', () => {
  assert.deepEqual(withSession({ pid: 42 }), { session: CUA_SESSION, pid: 42 })
  assert.deepEqual(withSession({ session: 'custom', pid: 42 }), { session: 'custom', pid: 42 })
})
