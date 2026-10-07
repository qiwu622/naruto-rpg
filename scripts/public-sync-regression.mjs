import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.svg']);
const publicOnlyFiles = new Set([
  path.normalize('img/login-bg.png'),
  path.normalize('img/login-logo.png')
]);
let checked = 0;

function normalizedText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function compareFile(source, deployed) {
  assert.ok(fs.existsSync(deployed), `Missing public copy: ${path.relative(root, deployed)}`);
  const extension = path.extname(source).toLowerCase();
  if (textExtensions.has(extension)) {
    assert.equal(normalizedText(deployed), normalizedText(source), `Public copy drifted: ${path.relative(root, source)}`);
  } else {
    assert.ok(
      fs.readFileSync(deployed).equals(fs.readFileSync(source)),
      `Public binary drifted: ${path.relative(root, source)}`
    );
  }
  checked++;
}

function compareTree(relativeDir) {
  const sourceDir = path.join(root, relativeDir);
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) compareTree(relative);
    else compareFile(path.join(root, relative), path.join(root, 'public', relative));
  }
}

function rejectExtraPublicFiles(relativeDir) {
  const deployedDir = path.join(root, 'public', relativeDir);
  assert.ok(fs.existsSync(deployedDir), `Missing public directory: ${path.relative(root, deployedDir)}`);
  for (const entry of fs.readdirSync(deployedDir, { withFileTypes: true })) {
    const relative = path.join(relativeDir, entry.name);
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) {
      assert.ok(
        entry.isFile() && publicOnlyFiles.has(path.normalize(relative)),
        `Orphaned public copy: ${path.join('public', relative)}`
      );
      continue;
    }
    if (entry.isDirectory()) rejectExtraPublicFiles(relative);
  }
}

for (const file of ['index.html', 'manifest.json', 'sw.js', 'announcements.html']) {
  compareFile(path.join(root, file), path.join(root, 'public', file));
}
for (const directory of ['js', 'css', 'img', 'assets']) {
  compareTree(directory);
  rejectExtraPublicFiles(directory);
}
for (const relative of publicOnlyFiles) {
  assert.ok(fs.existsSync(path.join(root, 'public', relative)), `Missing public-only asset: ${relative}`);
}

console.log(`PASS ${checked} shared source/public files are synchronized.`);
