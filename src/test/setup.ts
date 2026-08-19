import "@testing-library/jest-dom";

// Pure-logic suites run with `@vitest-environment node`, where `window` does
// not exist. Guard the DOM shims so this shared setup file works in both
// environments instead of throwing during collection.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
