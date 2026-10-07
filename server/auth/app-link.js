import { Router } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getUser } from '../db/index.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/async-route.js';

const TTL = 10 * 60 * 1000;
export const APP_LINK_CODE_PATTERN = /^[A-F0-9]{4}-[A-F0-9]{4}$/;
const profile = user => Object.fromEntries(['id', 'username', 'discriminator', 'avatar', 'global_name'].map(key => [key, user[key] ?? null]));
const digest = value => createHash('sha256').update(value).digest('base64url');

// Short-lived login handshakes only. Saves and accounts stay in the existing repositories.
export function createAppLinkRouter({ now = Date.now, loadUser = getUser, secret = config.jwt.secret } = {}) {
  const pending = new Map();
  const codes = new Map();
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  const prune = () => {
    for (const [id, entry] of pending) if (entry.expires <= now()) { pending.delete(id); codes.delete(entry.code); }
  };
  router.post('/start', (req, res) => {
    prune();
    const challenge = req.body?.challenge;
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return res.status(400).json({ error: '登录请求无效' });
    if (pending.size >= 1000) return res.status(503).json({ error: '登录服务繁忙，请稍后重试' });
    const id = randomBytes(32).toString('hex');
    let code;
    do { const raw = randomBytes(4).toString('hex').toUpperCase(); code = `${raw.slice(0, 4)}-${raw.slice(4)}`; } while (codes.has(code));
    pending.set(id, { code, challenge, expires: now() + TTL, status: 'pending' });
    codes.set(code, id);
    res.json({ device_code: id, user_code: code, expires_in: TTL / 1000, interval: 5, verification_path: `/auth/app/authorize?code=${code}` });
  });
  router.get('/authorize', asyncRoute(optionalAuth), (req, res) => {
    prune();
    const code = String(req.query.code || '').toUpperCase();
    const entry = pending.get(codes.get(code));
    if (!entry || entry.status !== 'pending') return res.status(410).type('html').send('<meta charset="utf-8"><p>此 App 登录请求已结束，请回到 App 重新连接。</p>');
    if (!req.user) return res.redirect(`/auth/discord?app_code=${encodeURIComponent(code)}`);
    const csrf = randomBytes(32).toString('hex');
    entry.csrf = csrf; entry.browserUserId = req.user.id;
    // The user must compare this code with their App before granting access.
    res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接忍者手记 App</title><style>body{background:#101319;color:#eae2d6;font:16px/1.8 system-ui;margin:0;padding:32px 20px}main{max-width:430px;margin:10vh auto;padding:28px;border:1px solid #ffffff24;border-radius:18px}h1{font-size:24px}strong{display:block;font-size:32px;letter-spacing:4px;color:#e8b373}button{padding:12px 18px;margin:8px 8px 0 0;border-radius:8px;border:0;font:inherit;cursor:pointer}button:first-of-type{background:#c95b37;color:white}small{color:#aaa}</style><main><h1>连接忍者手记 App</h1><p>请确认你的 App 显示相同的连接码：</p><strong>${code}</strong><p>连接后，App 可以管理此账号的云存档、图片和音乐收藏。</p><form method="post" action="/auth/app/approve"><input type="hidden" name="code" value="${code}"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="approve">连接此 App</button><button name="decision" value="decline">取消</button></form><p><small>只确认你自己发起的请求。完成后返回 App；本地游戏进度不会改变。</small></p></main></html>`);
  });
  router.post('/approve', asyncRoute(requireAuth), (req, res) => {
    prune();
    const entry = pending.get(codes.get(String(req.body?.code || '').toUpperCase()));
    const token = req.body?.csrf;
    if (!entry || entry.status !== 'pending') return res.status(410).send('请求已过期，请返回 App 重试。');
    if (req.authSource !== 'cookie' || entry.browserUserId !== req.user.id || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
      || token.length !== entry.csrf?.length || !timingSafeEqual(Buffer.from(token), Buffer.from(entry.csrf))) {
      return res.status(403).send('授权校验失败，请刷新页面重试。');
    }
    entry.status = req.body.decision === 'approve' ? 'approved' : 'declined';
    entry.userId = req.user.id; delete entry.csrf; delete entry.browserUserId;
    res.type('html').send(`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p>${entry.status === 'approved' ? '已连接。' : '已取消连接。'}请返回忍者手记 App，网页可以关闭。</p>`);
  });
  router.post('/poll', asyncRoute(async (req, res) => {
    prune();
    const id = req.body?.device_code;
    const verifier = req.body?.verifier;
    const entry = pending.get(id);
    if (!entry) return res.status(410).json({ error: '登录请求已过期，请重新连接', code: 'APP_LINK_EXPIRED' });
    if (typeof verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier) || digest(verifier) !== entry.challenge) {
      return res.status(403).json({ error: '登录校验失败', code: 'APP_LINK_INVALID' });
    }
    if (entry.status === 'pending') return res.status(202).json({ status: 'pending' });
    // Consume once, including a denied request; credentials never appear in URLs.
    pending.delete(id); codes.delete(entry.code);
    if (entry.status === 'declined') return res.status(403).json({ error: '已取消连接', code: 'APP_LINK_DECLINED' });
    const user = await loadUser(entry.userId);
    if (!user || user.banned) return res.status(403).json({ error: '此账号暂时无法连接', code: 'APP_ACCOUNT_UNAVAILABLE' });
    const token = jwt.sign({ id: user.id, username: user.username, client: 'android' }, secret, { expiresIn: config.jwt.expiresIn });
    res.json({ token, user: profile(user) });
  }));
  return router;
}

export default createAppLinkRouter();
