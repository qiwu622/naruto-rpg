import assert from 'node:assert/strict';

export async function withCustomElementGlobals(run) {
  // app-shell imports custom-element modules even when only individual methods
  // are exercised. Supply registration globals without mocking those methods
  // or pretending to render unrelated custom elements.
  const originals = new Map(['HTMLElement', 'customElements'].map(key => [
    key, Object.getOwnPropertyDescriptor(globalThis, key)
  ]));
  const registry = new Map();
  globalThis.HTMLElement = class {};
  globalThis.customElements = {
    get: name => registry.get(name),
    define(name, constructor) {
      assert.equal(registry.has(name), false, `custom element ${name} registered twice`);
      registry.set(name, constructor);
    }
  };
  try {
    return await run();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
