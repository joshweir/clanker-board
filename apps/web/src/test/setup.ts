import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// RTL auto-cleanup only fires with global afterEach; vitest here runs without
// globals, so register it explicitly.
afterEach(cleanup)

// jsdom has no layout, so the router's scroll-to-top on navigation logs a noisy
// "Not implemented" warning. Stub it - scroll position is not under test.
window.scrollTo = () => {}
