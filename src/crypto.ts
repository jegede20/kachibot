/**
 * KACHIBOT — wallet secret management.
 * Secrets are encrypted at rest with AES-256-GCM and only decrypted
 * transiently inside this process (signing / PIN-gated export).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { ENCRYPTION_KEY } from './config';

function deriveKey(): Buffer {
  let raw: Buffer = Buffer.alloc(0);
  if (ENCRYPTION_KEY.length === 44) {
    try { raw = Buffer.from(ENCRYPTION_KEY, 'base64'); } catch { raw = Buffer.alloc(0); }
    if (raw.length === 32) return raw;
  }
  return crypto.createHash('sha256').update(ENCRYPTION_KEY, 'utf8').digest();
}

/** Encrypt a secret string. Output format: "v1:<iv b64>:<tag b64>:<cipher b64>" */
export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** Decrypt an encryptSecret() payload. Throws on tampering / wrong key. */
export function decryptSecret(payload: string): string {
  const [v, ivB64, tagB64, dataB64] = payload.split(':');
  if (v !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('malformed encrypted payload');
  const key = deriveKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plain.toString('utf8');
}

/** Serialize a keypair for storage (base58 of the 64-byte secret). */
export function keypairToSecret(kp: Keypair): string {
  return bs58.encode(Buffer.from(kp.secretKey));
}

export function keypairFromSecret(secret: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(secret));
}

/** Import a private key given as base58, hex, or a JSON array of 64 bytes. */
export function parsePrivateKey(raw: string): Keypair {
  const t = raw.trim();
  if (/^\[[\d,\s]+\]$/.test(t)) {
    const arr = JSON.parse(t) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  if (/^[0-9a-fA-F]{128}$/.test(t)) {
    return Keypair.fromSecretKey(Buffer.from(t, 'hex'));
  }
  return Keypair.fromSecretKey(bs58.decode(t));
}

/* ------------------------------------------------------------------ *
 * BIP39 / SLIP-0010 derivation using node:crypto only
 * (path m/44'/501'/0'/0', the standard "Solana CLI" derivation).
 * ------------------------------------------------------------------ */

export function mnemonicToSeed(mnemonic: string, passphrase = ''): Buffer {
  const salt = `mnemonic${passphrase}`;
  return crypto.pbkdf2Sync(mnemonic.normalize('NFKD'), salt, 2048, 64, 'sha512');
}

/** SLIP-0010 hardened ed25519 derivation, Solana path. */
export function deriveSolanaKeypairFromSeed(seed: Buffer): Keypair {
  let I = crypto.createHmac('sha512', Buffer.from('ed25519 seed')).update(seed).digest();
  let kL = I.subarray(0, 32);
  let kR = I.subarray(32);
  for (const idx of [44 + 0x80000000, 501 + 0x80000000, 0x80000000, 0x80000000]) {
    const data = Buffer.alloc(4);
    data.writeUInt32BE(idx, 0);
    I = crypto.createHmac('sha512', kR).update(Buffer.concat([Buffer.from([0]), kL, data])).digest();
    kL = I.subarray(0, 32);
    kR = I.subarray(32);
  }
  return Keypair.fromSeed(kL);
}

export function keypairFromMnemonic(mnemonic: string): Keypair {
  const words = mnemonic.normalize('NFKD').trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error('seed phrase must be 12 or 24 words');
  }
  for (const w of words) {
    if (!/^[a-z]+$/.test(w)) throw new Error(`invalid word in seed phrase: "${w.slice(0, 10)}…"`);
  }
  return deriveSolanaKeypairFromSeed(mnemonicToSeed(words.join(' ')));
}

/* ------------------------- mnemonic generation ------------------------- */

let _words: string[] | null = null;
function wordList(): string[] {
  if (!_words) {
    const p = path.join(__dirname, '..', 'assets', 'bip39-en.json');
    _words = JSON.parse(fs.readFileSync(p, 'utf8')) as string[];
    if (_words.length !== 2048) throw new Error('bip39-en.json must contain 2048 words');
  }
  return _words;
}

/** Generate a standard BIP39 (english) mnemonic with checksum, 12 or 24 words. */
export function generateMnemonic(count: 12 | 24 = 24): string {
  const list = wordList();
  const entropyBytes = count === 12 ? 16 : 32; // 128/256 bits entropy
  const entropy = crypto.randomBytes(entropyBytes);
  const checkBits = crypto.createHash('sha256').update(entropy).digest()[0]; // first 8 bits
  const bitLen = entropyBytes * 8 + (count === 12 ? 4 : 8); // + checksum bits
  const out: string[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bitLen; i++) {
    const bit = i < entropyBytes * 8
      ? (entropy[i >> 3] >> (7 - (i & 7))) & 1
      : (checkBits >> (7 - ((i - entropyBytes * 8) & 7))) & 1;
    acc = (acc << 1) | bit;
    bits++;
    if (bits === 11) {
      out.push(list[acc]);
      acc = 0;
      bits = 0;
    }
  }
  return out.join(' ');
}
