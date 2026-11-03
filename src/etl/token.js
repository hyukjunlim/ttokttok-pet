'use strict';

// Keeps the eTL access token, encrypted with Electron's safeStorage (DPAPI on Windows, the
// keychain on macOS). Only the encrypted bytes ever reach the disk: when encryption isn't
// available the token isn't saved at all, never as plain text.
//
// safeStorage is passed in, so tests can use a stand-in; anything with isEncryptionAvailable(),
// encryptString(string) -> Buffer and decryptString(Buffer) -> string will do.

const fs = require('node:fs');
const path = require('node:path');

const MAX_TOKEN_LENGTH = 512;
const TOKEN_RE = /^[\x21-\x7e]+$/;   // printable ASCII, no spaces: Canvas tokens look like "1234~AbC…"

// The token as typed or pasted, trimmed, or an Error with a Korean message saying what's wrong
// with it. The message never repeats the token.
function normalizeToken(token) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) throw new Error('토큰을 입력해 주세요.');
  if (value.length > MAX_TOKEN_LENGTH || !TOKEN_RE.test(value)) {
    throw new Error('토큰 형식이 올바르지 않습니다. eTL에서 발급한 토큰을 그대로 붙여 넣어 주세요.');
  }
  return value;
}

// `normalize`: checks a token before it's saved (the Slack feature brings its own).
function createTokenStore({ safeStorage, file, normalize = normalizeToken }) {
  if (!safeStorage || !file) throw new TypeError('createTokenStore needs safeStorage and file');

  // Whether a saved token exists. It may still fail to decrypt (load() then gives null).
  function has() {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }

  // The saved token, or null when there is none or it can't be decrypted (another user's or
  // another PC's file, a damaged file, or encryption not available right now).
  function load() {
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return null;
    }
    if (!bytes.length) return null;
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const token = safeStorage.decryptString(bytes);
      return typeof token === 'string' && TOKEN_RE.test(token) ? token : null;
    } catch {
      return null;
    }
  }

  function save(token) {
    const value = normalize(token);
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('이 컴퓨터에서는 토큰을 안전하게 암호화할 수 없어 저장하지 않았습니다.');
    }
    const bytes = safeStorage.encryptString(value);
    if (!Buffer.isBuffer(bytes) || !bytes.length) {
      throw new Error('토큰을 암호화하지 못해 저장하지 않았습니다.');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`토큰 파일을 저장하지 못했습니다: ${err.code || 'unknown error'}`);
    }
  }

  function clear() {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.tmp`, { force: true });
  }

  return { has, load, save, clear };
}

module.exports = { createTokenStore, normalizeToken };
