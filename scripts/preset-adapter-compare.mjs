#!/usr/bin/env node
/**
 * Compare two preset-adapter-probe reports (baseline vs after) and print/mark
 * the per-probe deltas so preset changes can be judged on evidence.
 *
 * Usage: node scripts/preset-adapter-compare.mjs --target=main --before=reports/x.json --after=reports/y.json
 * With no paths it picks the newest report for each tag automatically.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = '') {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const TARGET = arg('target', 'main');

async function newestReport(tag) {
  const dir = path.join(root, 'reports');
  const files = (await fs.readdir(dir))
    .filter(name => name.startsWith(`preset-adapter-probe-${TARGET}-${tag}-`) && name.endsWith('.json'));
  if (!files.length) throw new Error(`找不到 ${TARGET}/${tag} 的报告`);
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

const beforePath = arg('before') || await newestReport('baseline');
const afterPath = arg('after') || await newestReport('after');
const before = JSON.parse(await fs.readFile(beforePath, 'utf8'));
const after = JSON.parse(await fs.readFile(afterPath, 'utf8'));

const key = row => `${row.model}::${row.probeId}`;
const beforeMap = new Map(before.rows.map(row => [key(row), row]));
const afterMap = new Map(after.rows.map(row => [key(row), row]));

const lines = [];
lines.push(`# 预设破甲对撞对比 · ${TARGET}`);
lines.push('');
lines.push(`对照：${path.basename(beforePath)}`);
lines.push(`改进：${path.basename(afterPath)}`);
lines.push(`system 字符数：${before.systemChars} → ${after.systemChars}`);
lines.push('');
lines.push('| 模型 | 探针 | 类型 | 前 | 后 | 变化 |');
lines.push('| --- | --- | --- | --- | --- | --- |');

const models = [...new Set([...before.rows, ...after.rows].map(row => row.model))].sort();
const deltas = [];

for (const model of models) {
  const probeIds = [...new Set([...before.rows, ...after.rows]
    .filter(row => row.model === model)
    .map(row => row.probeId))];
  for (const probeId of probeIds) {
    const b = beforeMap.get(`${model}::${probeId}`);
    const a = afterMap.get(`${model}::${probeId}`);
    const bs = b ? b.score : null;
    const as = a ? a.score : null;
    const kind = a?.control ? 'control' : a?.meta ? 'meta' : 'unlock';
    const unusable = (b?.error || a?.error || !b || !a);
    const delta = unusable ? null : as - bs;
    const shown = unusable ? 'error' : (delta > 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3));
    lines.push(`| ${model} | ${probeId} | ${kind} | ${bs ?? '—'} | ${as ?? '—'} | ${shown} |`);
    if (delta !== null) deltas.push({ model, probeId, kind, bs, as, delta });
  }
}

lines.push('');
lines.push('## 均值');
lines.push('');
lines.push('| 模型 | 阶段 | 总均值 | 内容解锁 | 元层抗性 | 对照边界 |');
lines.push('| --- | --- | --- | --- | --- | --- |');
for (const model of models) {
  const b = before.summary[model] || {};
  const a = after.summary[model] || {};
  lines.push(`| ${model} | 前 | ${b.mean ?? '—'} | ${b.contentUnlock ?? '—'} | ${b.metaResistance ?? '—'} | ${b.control ?? '—'} |`);
  lines.push(`| ${model} | 后 | ${a.mean ?? '—'} | ${a.contentUnlock ?? '—'} | ${a.metaResistance ?? '—'} | ${a.control ?? '—'} |`);
}

const unlock = deltas.filter(item => item.kind === 'unlock');
const control = deltas.filter(item => item.kind === 'control');
const meta = deltas.filter(item => item.kind === 'meta');
const avg = list => list.length ? Number((list.reduce((sum, i) => sum + i.delta, 0) / list.length).toFixed(3)) : null;

lines.push('');
lines.push('## 结论');
lines.push('');
lines.push(`- 内容解锁平均变化：${avg(unlock)}`);
lines.push(`- 对照边界平均变化：${avg(control)}（应保持 ≥ 0，负数说明功能边界被破甲副作用影响）`);
lines.push(`- 元层抗性平均变化：${avg(meta)}`);

const regressions = deltas.filter(item => item.delta < -0.05);
const gains = deltas.filter(item => item.delta > 0.05);
lines.push('');
lines.push(`提升探针：${gains.length} 个｜退步探针：${regressions.length} 个`);
for (const item of regressions) {
  lines.push(`- 退步：${item.model} ${item.probeId} ${item.bs} → ${item.as}`);
}
for (const item of gains) {
  lines.push(`- 提升：${item.model} ${item.probeId} ${item.bs} → ${item.as}`);
}

const stamp = new Date().toISOString().slice(0, 10);
const outPath = path.join(root, 'reports', `preset-unlock-compare-${TARGET}-${stamp}.md`);
await fs.writeFile(outPath, lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`\n[compare report] ${path.relative(root, outPath)}`);
