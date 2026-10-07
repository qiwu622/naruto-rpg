import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Mount the real API/auth/repository with disposable accounts and data. This
// helper intentionally does not start multiplayer or touch any project saves.
export async function startCloudSaveTestServer({ staticFiles = false } = {}) {
  const root = process.env.CLOUD_TEST_PROJECT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'naruto-cloud-management-'));
  await mkdir(path.join(dataDir, 'saves'));
  for (const name of ['users.json', 'saves_index.json', 'favorites.json', 'login_log.json']) await writeFile(path.join(dataDir, name), '{}');
  Object.assign(process.env, { DATA_DIR: dataDir, NODE_ENV: 'development', AUTH_BYPASS: 'false', JWT_SECRET: 'cloud-management-regression-only', MAX_SAVE_SLOTS: '3', MAX_SAVE_SIZE_MB: '200', MAX_SAVE_COMPRESSED_SIZE_MB: '64', MAX_LEGACY_SAVE_SIZE_MB: '16' });
  const fromProject = relative => import(pathToFileURL(path.join(root, relative)));
  const db = await fromProject('server/db/index.js');
  await db.initDb();
  const { requireAuth } = await fromProject('server/middleware/auth.js');
  const { default: router } = await fromProject('server/api/saves.js');
  const users = [{ id: 'cloud-test-a', username: '云端测试 A' }, { id: 'cloud-test-b', username: '云端测试 B' }];
  for (const user of users) await db.upsertUser(user);
  const tokens = Object.fromEntries(users.map(user => [user.id, jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' })]));
  const app = express();
  app.use(cookieParser());
  app.get('/auth/me', requireAuth, (req, res) => res.json(req.user));
  app.use('/api/saves', router);
  if (staticFiles) {
    app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/components.css"><style>body{background:#15171b;color:#eee;margin:0}#app{min-height:100vh}</style><main id="app"></main>'));
    app.use('/js', express.static(path.join(root, 'js')));
    app.use('/css', express.static(path.join(root, 'css')));
    app.use('/assets', express.static(path.join(root, 'assets')));
  }
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { app, url, dataDir, db, tokens, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); } };
}
