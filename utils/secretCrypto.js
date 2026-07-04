const crypto = require('crypto');
const env = require('../config/env');

/**
 * Symmetric encryption for credentials stored at rest (e.g. the Agora REST
 * secret). AES-256-GCM with a key derived from JWT_SECRET, so no extra env is
 * required. Ciphertext format: iv:authTag:data (all hex), prefixed with "enc:"
 * so we can tell encrypted values from legacy plaintext.
 */
const PREFIX = 'enc:';
const KEY = crypto.createHash('sha256').update(String(env.jwt?.secret || 'dev_jwt_secret_change_me')).digest(); // 32 bytes

function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(value) {
  if (!value) return '';
  if (!String(value).startsWith(PREFIX)) return String(value); // legacy plaintext — return as-is
  try {
    const [, ivHex, tagHex, dataHex] = String(value).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return ''; // tampered / wrong key
  }
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Mask a secret for display: keep the last `keep` chars, dot the rest. */
function mask(plain, keep = 4) {
  const s = String(plain || '');
  if (!s) return '';
  if (s.length <= keep) return '•'.repeat(s.length);
  // Fixed-width dots (not the secret's real length — avoids leaking length AND
  // keeps UI columns from overflowing on long values) + the last `keep` chars.
  return `••••••••${s.slice(-keep)}`;
}

module.exports = { encrypt, decrypt, isEncrypted, mask };
