'use strict';
/** Unit tests: pump.fun link parsing (the watch-add path).
 * Regression: capture-group off-by-one made every pump.fun link report
 * "invalid address" (code read the word "profile" as the address). */
const { test } = require('node:test');
const assert = require('node:assert');

const { parsePumpfunLink } = require('../dist/config');
const { PublicKey } = require('@solana/web3.js');

const PROFILE_ADDR = 'CcJX975YTw8owyuRwyC1m9pyC3ZhRp89VM12pfUfDBcf';
const COIN_MINT = '6t2e8kNgeYJYdeqU7hVf27Tsj8zvDxGLaLqGCeKypump';

test('profile link (user-reported format) extracts the real address', () => {
  const r = parsePumpfunLink('https://pump.fun/profile/' + PROFILE_ADDR);
  assert.deepStrictEqual(r, { kind: 'profile', id: PROFILE_ADDR });
  // the extracted id must be a usable Solana public key
  assert.doesNotThrow(() => new PublicKey(r.id));
});

test('coin link extracts the mint', () => {
  const r = parsePumpfunLink('https://pump.fun/coin/' + COIN_MINT);
  assert.deepStrictEqual(r, { kind: 'coin', id: COIN_MINT });
});

test('parser tolerates scheme-less, www, trailing slash, query and preamble', () => {
  const base = 'pump.fun/profile/' + PROFILE_ADDR;
  const variants = [
    base,                                     // no scheme
    'https://' + base,
    'https://www.' + base,
    'http://www.' + base,
    base + '/',                               // trailing slash
    base + '/?ref=telegram',                  // query string
    'watch this: https://' + base,            // words before the link
  ];
  for (const u of variants) {
    const r = parsePumpfunLink(u);
    assert.ok(r && r.kind === 'profile' && r.id === PROFILE_ADDR, `variant failed: ${u}`);
  }
});

test('parser rejects garbage, short ids and look-alike domains', () => {
  assert.strictEqual(parsePumpfunLink('hello world'), null);
  assert.strictEqual(parsePumpfunLink('https://pump.fun/profile/TooShort'), null);
  assert.strictEqual(parsePumpfunLink('https://pump.fun/'), null);
  assert.strictEqual(parsePumpfunLink('https://notpump.fun/profile/' + PROFILE_ADDR), null);
  assert.strictEqual(parsePumpfunLink('https://xypump.fun/coin/' + COIN_MINT), null);
});

test('naked pump.fun/<address> form is treated as a profile', () => {
  const r = parsePumpfunLink('https://pump.fun/' + PROFILE_ADDR);
  assert.deepStrictEqual(r, { kind: 'profile', id: PROFILE_ADDR });
});

test('username profiles (no /profile/, short name) are not misparsed', () => {
  assert.strictEqual(parsePumpfunLink('https://pump.fun/elonmusk'), null);
});
