import test from 'node:test';
import assert from 'node:assert/strict';
import { detectModelAuth, detectAllWithAuth } from '../src/models.mjs';

test('web and api models do not require CLI login', () => {
  const webAuth = detectModelAuth('web-chatgpt');
  assert.equal(webAuth.supported, false);
  assert.equal(webAuth.loggedIn, true);
  const apiAuth = detectModelAuth('api-deepseek');
  assert.equal(apiAuth.supported, false);
  assert.equal(apiAuth.loggedIn, true);
});

test('missing CLI reports not_installed with installCmd', () => {
  const auth = detectModelAuth('claude', { id: 'claude', available: false, path: '' });
  assert.equal(auth.supported, true);
  assert.equal(auth.installed, false);
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.status, 'not_installed');
  assert.match(auth.installCmd, /claude-code/);
});

test('detectAllWithAuth returns auth metadata for every model', () => {
  const all = detectAllWithAuth();
  assert.ok(all.length > 0);
  for (const m of all) {
    assert.ok(m.auth && typeof m.auth.loggedIn === 'boolean');
  }
});
