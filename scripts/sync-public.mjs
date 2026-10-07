#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAnnouncements } from './generate-announcements.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const sharedFiles = ['index.html', 'manifest.json', 'sw.js', 'announcements.html'];
const sharedDirectories = [
  { name: 'js', publicOnly: [] },
  { name: 'css', publicOnly: [] },
  { name: 'img', publicOnly: ['login-bg.png', 'login-logo.png'] },
  { name: 'assets', publicOnly: [] },
  { name: 'app', publicOnly: [] }
];

await generateAnnouncements(root);
await fs.mkdir(publicDir, { recursive: true });
for (const file of sharedFiles) {
  await fs.copyFile(path.join(root, file), path.join(publicDir, file));
}
for (const { name, publicOnly } of sharedDirectories) {
  const source = path.join(root, name);
  const destination = path.join(publicDir, name);
  const preserved = new Map();
  for (const relativeFile of publicOnly) {
    preserved.set(relativeFile, await fs.readFile(path.join(destination, relativeFile)));
  }
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, {
    recursive: true,
    force: true
  });
  for (const [relativeFile, bytes] of preserved) {
    const deployedFile = path.join(destination, relativeFile);
    await fs.mkdir(path.dirname(deployedFile), { recursive: true });
    await fs.writeFile(deployedFile, bytes);
  }
}

console.log(`Synchronized shared app sources into ${path.relative(root, publicDir)}/`);
