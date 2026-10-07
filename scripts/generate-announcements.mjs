import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const escape = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function inline(text) {
  return escape(text)
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function renderMarkdown(markdown) {
  const parts = [];
  let list = false;
  let section = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const bullet = /^- (.+)$/.exec(line);
    if (list && !bullet) { parts.push('</ul>'); list = false; }
    if (bullet) {
      if (!list) { parts.push('<ul>'); list = true; }
      parts.push(`<li>${inline(bullet[1])}</li>`);
    } else if (/^## /.test(line)) {
      parts.push(`<h2 id="section-${++section}">${inline(line.slice(3))}</h2>`);
    } else if (/^### /.test(line)) {
      parts.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (/^> /.test(line)) {
      parts.push(`<p class="callout">${inline(line.slice(2))}</p>`);
    } else if (/^-# /.test(line)) {
      parts.push(`<p class="muted">${inline(line.slice(3))}</p>`);
    } else if (line.trim() && !/^# /.test(line)) {
      parts.push(`<p>${inline(line)}</p>`);
    }
  }
  if (list) parts.push('</ul>');
  return parts.join('\n');
}

export async function generateAnnouncements(projectRoot = root) {
  const { version } = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const announcementPath = path.join(projectRoot, `docs/releases/v${version}-discord.md`);
  const announcement = await fs.readFile(announcementPath, 'utf8');
  if (!announcement.startsWith(`# 🍃 忍者手记 v${version} 更新公告\n`) || !/^## /m.test(announcement)) {
    throw new Error(`请先填写 v${version} 的更新公告：${announcementPath}`);
  }
  const changelog = await fs.readFile(path.join(projectRoot, 'CHANGELOG.md'), 'utf8');
  const releases = [...changelog.matchAll(/^## \[(v[^\]]+)\](?: - ([^\n]+))?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  const current = releases.find(release => release[1] === `v${version}`);
  if (!current?.[2] || !current[3].trim()) throw new Error(`CHANGELOG 缺少 v${version} 的日期或更新内容`);
  const sections = [...announcement.matchAll(/^## (.+)$/gm)];
  const history = releases.filter(release => release[1] !== `v${version}`).map(release => `
    <details><summary><span>${escape(release[1])}</span><time>${escape(release[2] || '')}</time></summary>
      <div class="history-content">${renderMarkdown(release[3])}</div>
    </details>`).join('');
  const html = `<!doctype html>
<html lang="zh-CN" data-release-version="${escape(version)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#101113">
  <meta name="description" content="忍者手记 v${escape(version)} 更新公告与历史版本说明。">
  <title>更新公告 · 忍者手记 v${escape(version)}</title>
  <style>
    :root { color-scheme:dark; --ink:#101113; --paper:#ede6d9; --muted:#aaa49c; --gold:#d7b17a; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; scroll-padding-top:32px; }
    body { margin:0; background:radial-gradient(ellipse at 80% 0, #39291e70, transparent 50%),var(--ink); color:var(--paper); font:16px/1.85 system-ui,"Microsoft YaHei",sans-serif; }
    a { color:var(--gold); text-underline-offset:4px; }
    a:focus-visible,summary:focus-visible { outline:2px solid var(--gold); outline-offset:5px; }
    .wrap { width:min(1080px,100%); margin:auto; padding:32px 28px calc(64px + env(safe-area-inset-bottom)); }
    .top { display:flex; align-items:center; justify-content:space-between; gap:20px; border-bottom:1px solid #ffffff14; padding-bottom:24px; }
    .brand { font:600 22px/1.2 Georgia,"Songti SC",serif; letter-spacing:2px; text-decoration:none; color:var(--paper); }
    .pill { display:inline-flex; justify-content:center; padding:8px 18px; border:1px solid #d7b17a48; border-radius:9px; text-decoration:none; }
    .hero { padding:58px 0 40px; }
    .eyebrow { margin:0; color:var(--gold); font-size:12px; letter-spacing:3px; }
    h1 { margin:12px 0; font:600 clamp(32px,5vw,52px)/1.3 Georgia,"Songti SC",serif; letter-spacing:1px; }
    .hero p { color:var(--muted); margin:12px 0 20px; }
    .links { display:flex; gap:10px; flex-wrap:wrap; }
    .primary { background:#b04a31; color:#fff0e3; border-color:#d87553; }
    .layout { display:grid; grid-template-columns:210px minmax(0,1fr); gap:40px; align-items:start; }
    nav { position:sticky; top:24px; padding:20px 0; }
    nav p { color:var(--muted); font-size:12px; letter-spacing:2px; }
    nav a { display:block; padding:7px 0; font-size:14px; text-decoration:none; color:#c6beb2; }
    nav a:hover { color:var(--gold); }
    article { min-width:0; padding:24px 30px 36px; background:#17191be0; border:1px solid #ffffff12; border-radius:16px; overflow-wrap:anywhere; }
    article>h2 { color:var(--paper); font-size:22px; line-height:1.5; margin:38px 0 16px; padding-top:24px; border-top:1px solid #ffffff12; }
    article>h2:first-of-type { margin-top:24px; }
    h3 { color:var(--gold); font-size:18px; }
    p { margin:12px 0; }
    ul { padding-left:23px; }
    li { margin:10px 0; color:#d0c9bf; }
    li::marker { color:#a77b47; }
    strong { font-weight:650; color:#f1e6d2; }
    code { background:#0003; border:1px solid #ffffff12; border-radius:4px; padding:2px 5px; font:13px/1.5 ui-monospace,monospace; }
    .callout { margin:12px 0; padding:12px 16px; border-left:2px solid var(--gold); background:#d7b17a0a; color:#c8bda8; }
    .muted { color:var(--muted); font-size:13px; }
    .history { margin-top:48px; }
    .history h2 { font-size:24px; }
    details { border:1px solid #ffffff14; border-radius:10px; background:#17191b; margin:12px 0; }
    summary { cursor:pointer; padding:16px 20px; }
    summary span { margin-left:8px; color:var(--paper); font-weight:600; }
    summary time { float:right; color:var(--muted); font-size:13px; }
    .history-content { padding:0 24px 20px; }
    footer { padding-top:32px; margin-top:32px; border-top:1px solid #ffffff14; color:var(--muted); font-size:13px; }
    @media(max-width:760px) { .wrap { padding:24px 18px calc(40px + env(safe-area-inset-bottom)); } .hero { padding:32px 0 28px; } .layout { display:block; } nav { position:static; padding:0 0 20px; } nav p { display:none; } nav a { display:inline-block; margin:0 8px 8px 0; border:1px solid #ffffff14; border-radius:7px; padding:4px 9px; font-size:12px; } article { padding:16px 20px 24px; } article>h2 { font-size:20px; } .links .pill { flex:1 1 auto; } }
    @media(prefers-reduced-motion:reduce) { html { scroll-behavior:auto; } }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="top"><a class="brand" href="/">忍者手记</a><a class="pill" href="/">进入游戏 ↗</a></header>
    <section class="hero" aria-labelledby="title">
      <p class="eyebrow">RELEASE NOTES · ${escape(current[2])}</p>
      <h1 id="title">v${escape(version)} · 更新公告</h1>
      <p>每一次更新，都记录在这里。查看本次变化、升级说明与历史版本。</p>
      <div class="links"><a class="pill primary" href="https://www.qiwu.asia/app/android/naruto-rpg.apk">下载安卓最新版</a><a class="pill" href="https://github.com/qiwu622/naruto-rpg/releases/tag/v${escape(version)}">GitHub 版本</a><a class="pill" href="#history">历史公告 ↓</a></div>
    </section>
    <div class="layout">
      <nav aria-label="本次更新目录"><p>本次更新</p>${sections.map((section,index) => `<a href="#section-${index+1}">${escape(section[1])}</a>`).join('\n')}</nav>
      <article aria-label="v${escape(version)} 更新内容">${renderMarkdown(announcement)}</article>
    </div>
    <section class="history" id="history"><h2>历史版本</h2><p class="muted">本次完整公告与之前版本的更新记录。</p>${history}</section>
    <footer>忍者手记 · 本地存档保存在当前设备。跨设备续玩，请使用云端或导入 / 导出备份。</footer>
  </div>
</body>
</html>
`;
  await fs.writeFile(path.join(projectRoot, 'announcements.html'), html);
  console.log(`Generated website announcement v${version} with ${releases.length} release records.`);
  return html;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateAnnouncements();
