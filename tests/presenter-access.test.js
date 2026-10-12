'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresenterAccess } = require('../presenter-access');

function setup(hash, initialToken) {
  const values = new Map(initialToken ? [['dealarena:presenter-token', initialToken]] : []);
  const urls = [];
  const access = createPresenterAccess({
    location: { hash, pathname: '/', search: '?releasecheck=2' },
    history: { replaceState: (_state, _title, url) => urls.push(url) },
    storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
  });
  return { access, values, urls };
}
test('ordinary visitors receive no presenter capability', () => {
  const { access, urls } = setup('#deal');
  assert.deepEqual(access.headers({ 'Content-Type': 'application/json' }), { 'Content-Type': 'application/json' });
  assert.equal(urls.length, 0);
});
test('private link passes authorization and immediately removes secret from URL', () => {
  const { access, urls, values } = setup('#deal?presenter=test%2Btoken&join=live');
  assert.equal(access.headers()['x-dealarena-presenter-token'], 'test+token');
  assert.equal(values.get('dealarena:presenter-token'), 'test+token');
  assert.deepEqual(urls, ['/?releasecheck=2#deal?join=live']);
});
test('same-tab refresh preserves capability without putting it back into URL', () => {
  const { access, urls } = setup('#deal', 'private-token');
  assert.equal(access.headers()['x-dealarena-presenter-token'], 'private-token');
  assert.equal(urls.length, 0);
});
test('explicit empty capability revokes access', () => {
  const { access, values } = setup('#deal?presenter=', 'old-token');
  assert.deepEqual(access.headers(), {});
  assert.equal(values.has('dealarena:presenter-token'), false);
});
test('unavailable storage does not prevent private link from working', () => {
  const access = createPresenterAccess({
    location: { hash: '#deal?presenter=memory-token', pathname: '/', search: '' },
    history: { replaceState: () => {} },
    storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } },
  });
  assert.equal(access.headers()['x-dealarena-presenter-token'], 'memory-token');
});
