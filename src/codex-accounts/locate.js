'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { localCodex } = require('../chat-delete');

function findCodex() {
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  try {
    const files = fs.readdirSync(root).map((name) => path.join(root, name, 'codex.exe'))
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length) return files[0];
  } catch { /* VS Code also bundles Codex. */ }
  return localCodex();
}
module.exports = { findCodex };
