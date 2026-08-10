import '@testing-library/jest-dom'

// Mock window.matchMedia for jsdom
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {}, // Deprecated
    removeListener: () => {}, // Deprecated
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }),
})

// jsdom defines window.location's own properties (reload, assign, replace,
// href, ...) as non-configurable, which makes `vi.spyOn(window.location,
// 'reload')` throw "Cannot redefine property: reload". window.location
// itself is a configurable accessor on window, so replace it with a plain
// clone whose properties are configurable and can be spied on.
Object.defineProperty(window, 'location', {
  configurable: true,
  value: { ...window.location },
})
