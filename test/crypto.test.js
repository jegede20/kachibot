'use strict';
/** Unit tests: crypto roundtrips + mnemonic determinism (KACHIBOT). */
const { test } = require('node:test');
const assert = require('node:assert');
const { Keypair } = require('@solana/web3.js');
const {
  encryptSecret, decryptSecret, parsePrivateKey, keypairFromMnemonic, mnemonicToSeed,
  generateMnemonic, keypairToSecret, keypairFromSecret,
} = require('../dist/crypto');

test('AES-256-GCM encrypt/decrypt roundtrip', () => {
  const secret = 'hello-kachi-1234567890';
  const enc = encryptSecret(secret);
  assert.ok(enc.startsWith('v1:'));
  assert.notStrictEqual(enc, secret);
  assert.strictEqual(decryptSecret(enc), secret);
});

test('decrypt fails on tampered payload', () => {
  const enc = encryptSecret('do-not-eat');
  const parts = enc.split(':');
  parts[3] = Buffer.from('AAAA').toString('base64');
  assert.throws(() => decryptSecret(parts.join(':')));
});

test('parsePrivateKey accepts base58, hex and JSON-array forms', () => {
  const kp = Keypair.generate();
  const b58 = keypairToSecret(kp);
  const hex = Buffer.from(kp.secretKey).toString('hex');
  const arr = JSON.stringify([...kp.secretKey]);
  assert.strictEqual(parsePrivateKey(b58).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.strictEqual(parsePrivateKey(hex).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.strictEqual(parsePrivateKey(arr).publicKey.toBase58(), kp.publicKey.toBase58());
});

test('keypair secret roundtrip via store format', () => {
  const kp = Keypair.generate();
  const stored = encryptSecret(keypairToSecret(kp));
  const back = keypairFromSecret(decryptSecret(stored));
  assert.strictEqual(back.publicKey.toBase58(), kp.publicKey.toBase58());
});

test('mnemonic import is deterministic (standard SLIP-10 solana derivation)', () => {
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const kp1 = keypairFromMnemonic(phrase);
  const kp2 = keypairFromMnemonic(phrase);
  assert.strictEqual(kp1.publicKey.toBase58(), kp2.publicKey.toBase58());
  // BIP39 published test vector (no passphrase)
  assert.strictEqual(
    mnemonicToSeed(phrase).toString('hex'),
    '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
  );
  // SLIP-10 m/44'/501'/0'/0' — cross-verified against an independent implementation
  assert.strictEqual(kp1.publicKey.toBase58(), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
});

test('generated phrases import cleanly (checksummed BIP39)', () => {
  for (let i = 0; i < 3; i++) {
    const p12 = generateMnemonic(12);
    assert.strictEqual(p12.split(' ').length, 12);
    assert.ok(keypairFromMnemonic(p12).publicKey.toBase58().length > 30);
  }
  assert.strictEqual(generateMnemonic(24).split(' ').length, 24);
});

test('rejects bad phrases / bad keys', () => {
  assert.throws(() => keypairFromMnemonic('not a phrase at all'));
  assert.throws(() => parsePrivateKey('not-a-key!!'));
});
