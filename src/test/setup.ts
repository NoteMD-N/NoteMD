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

// jsdom in this setup does not provide a complete Storage implementation, so
// tests covering locally-cached PHI need a real one. Install an in-memory
// Storage when the environment's version is missing or incomplete.
if (typeof globalThis !== "undefined") {
  const needsPolyfill =
    typeof (globalThis as { localStorage?: Storage }).localStorage === "undefined" ||
    typeof (globalThis as { localStorage?: Storage }).localStorage?.clear !== "function";

  if (needsPolyfill) {
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      removeItem: (key: string) => void store.delete(key),
      setItem: (key: string, value: string) => void store.set(key, String(value)),
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: storage,
    });
  }
}
