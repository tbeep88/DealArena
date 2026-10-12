'use strict';

// A private presenter link grants only the existing bounded testnet actions.
// It contains no wallet key and never opens a browser-wallet provider.
(function (root) {
  function createPresenterAccess({ location, history, storage }) {
    const storageKey = 'dealarena:presenter-token';
    let token = '';
    try { token = storage.getItem(storageKey) || ''; } catch { /* memory fallback */ }
    const hash = String(location.hash || '');
    const separator = hash.indexOf('?');
    if (separator >= 0) {
      const params = new URLSearchParams(hash.slice(separator + 1));
      if (params.has('presenter')) {
        token = params.get('presenter') || '';
        params.delete('presenter');
        try {
          if (token) storage.setItem(storageKey, token);
          else storage.removeItem(storageKey);
        } catch { /* memory fallback */ }
        const suffix = params.toString();
        // Remove the capability before UI navigation, screenshots or sharing.
        history.replaceState(null, '', location.pathname + location.search
          + hash.slice(0, separator) + (suffix ? '?' + suffix : ''));
      }
    }
    return {
      headers(base = {}) {
        return token ? { ...base, 'x-dealarena-presenter-token': token } : { ...base };
      },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createPresenterAccess };
  else root.DealArenaPresenterAccess = { createPresenterAccess };
})(typeof window === 'object' ? window : globalThis);
