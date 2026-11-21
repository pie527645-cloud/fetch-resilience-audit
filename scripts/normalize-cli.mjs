import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, '..', 'dist');
const cliPath = path.join(distDir, 'cli.js');

function normalizeLf(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      normalizeLf(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const normalized = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      fs.writeFileSync(fullPath, normalized, 'utf8');
    }
  }
}

normalizeLf(distDir);

let cliContent = fs.readFileSync(cliPath, 'utf8');
const shebang = '#!/usr/bin/env node\n';
if (!cliContent.startsWith(shebang)) {
  if (cliContent.startsWith('#!')) {
    const newlineIdx = cliContent.indexOf('\n');
    cliContent = newlineIdx === -1 ? shebang : shebang + cliContent.slice(newlineIdx + 1);
  } else {
    cliContent = shebang + cliContent;
  }
  fs.writeFileSync(cliPath, cliContent, 'utf8');
}
fs.chmodSync(cliPath, 0o755);
