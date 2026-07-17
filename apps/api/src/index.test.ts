import { expect, test } from 'vitest'

import { name } from './index'

test('exposes the package name', () => {
  expect(name).toBe('@clanker/api')
})
