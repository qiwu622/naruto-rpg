import assert from 'node:assert/strict';

import {
  inspectRuntimeBuild,
  readLoadedBuild,
  showStaleBuildNotice
} from '../js/utils/build-version.js';

const script = { src: 'https://www.qiwu.asia:8080/js/app.js?v=2608172301' };
const documentRef = {
  querySelector: selector => selector.includes('app.js') ? script : null
};

assert.equal(readLoadedBuild(documentRef), '2608172301');
assert.equal(showStaleBuildNotice({ stale: true }, { documentRef: null }), null);

let request = null;
const stale = await inspectRuntimeBuild({
  documentRef,
  locationRef: { href: 'https://www.qiwu.asia:8080/index.html' },
  fetchImpl: async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({ version: '3.5.0', build: '2608172302', environment: 'staging' })
    };
  }
});

assert.equal(stale.loadedBuild, '2608172301');
assert.equal(stale.latestBuild, '2608172302');
assert.equal(stale.stale, true);
assert.equal(request.options.cache, 'no-store');
assert.match(request.url, /version\.json\?_runtime_check=/);

let reloaded = false;
let appended = null;
const elements = new Map();
const fakeDocument = {
  getElementById: id => elements.get(id) || null,
  createElement: tag => {
    const listeners = {};
    const node = {
      tag,
      children: [],
      style: {},
      setAttribute() {},
      remove() { elements.delete(this.id); },
      addEventListener(type, listener) { listeners[type] = listener; },
      append(...children) { this.children.push(...children); },
      _listeners: listeners
    };
    Object.defineProperty(node, 'id', {
      get() { return this._id || ''; },
      set(value) { this._id = value; elements.set(value, this); }
    });
    return node;
  },
  body: { appendChild(node) { appended = node; } }
};
const notice = showStaleBuildNotice(stale, {
  documentRef: fakeDocument,
  locationRef: { reload: () => { reloaded = true; } }
});
assert.equal(notice, appended);
assert.equal(notice.children[0].textContent, '有新版本可用');
assert.doesNotMatch(notice.children[0].textContent, /测试站|预设|260817/);
notice.children[1]._listeners.click();
assert.equal(reloaded, true);
assert.equal(showStaleBuildNotice(stale, { documentRef: fakeDocument }), notice, 'notice must be idempotent');
assert.equal(showStaleBuildNotice({ ...stale, stale: false }, { documentRef: fakeDocument }), null);
assert.equal(elements.has('runtime-build-stale-notice'), false, 'a fresh recheck removes an existing notice');

const dismissed = new Map();
const storageRef = { getItem: key => dismissed.get(key), setItem: (key, value) => dismissed.set(key, value) };
let replaced;
const updated = showStaleBuildNotice(stale, { documentRef: fakeDocument, storageRef,
  locationRef: { href: 'https://qiwu.asia/?tab=opening#draft', replace: url => { replaced = url; } } });
updated.children[1]._listeners.click();
const destination = new URL(replaced);
assert.equal(destination.origin, 'https://qiwu.asia');
assert.equal(destination.searchParams.get('tab'), 'opening');
assert.ok(destination.searchParams.get('_app_update').startsWith(`${stale.latestBuild}-`));
assert.equal(destination.hash, '#draft');
updated.children[2]._listeners.click();
assert.equal(elements.has('runtime-build-stale-notice'), false);
assert.equal(showStaleBuildNotice(stale, { documentRef: fakeDocument, storageRef }), null, 'a dismissed build remains hidden for this session');
assert.ok(showStaleBuildNotice({ ...stale, latestBuild: 'next-build' }, { documentRef: fakeDocument, storageRef }), 'a future update can still be shown');

console.log('✓ runtime build version regression passed');
