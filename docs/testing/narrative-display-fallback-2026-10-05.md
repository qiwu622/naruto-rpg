# 变量更新完成后正文消失修复（2026-10-05）

## 确认的成因

玩家提供的分析对应一条实际存在的路径：

1. `pipeline:chunk` 使用 `cleanupPartialResponse` 生成安全文本后显示，不执行预设的 display 正则。
2. `pipeline:complete` 调用 `_finalizeMessage`，清空正文容器并按 `buildPresetPresentation` 的结果重绘。
3. 通用预设的正则命中后，Markdown 分支原先直接返回 `sanitizeNarrativeDisplayText(safeDisplayText)`，没有空值回退，也没有 `fallbackText` 字段。
4. UI 的 Markdown 分支又只读 `presentation.text`。正则删除正文、替换为空白或替换为随后被清理的内部标签时，两层都没有采用已有安全正文，最终容器为空。
5. 思维链位于正文容器的兄弟节点，日报在重绘后单独追加，因此仍然可见。

这条路径不要求变量更新修改正文数据。触发取决于本回合内容是否命中正则以及正则的展示结果，所以会表现为偶发。

## 修复

- `js/core/preset-regex-runtime.js`：正则命中的 Markdown 分支在清理结果为空时使用已计算的安全 `fallbackText`；Markdown 结果同时携带该字段。
- `js/ui/app-shell.js`：Markdown 展示文本为空或只有空白时，依次采用展示结果保存的 `fallbackText`、管线传入的 `cleanText`。回退内容再次清理，避免推理、审查和变量标签进入正文。
- 两份共享源文件已同步至本地 `public/`。修复没有新增正文提示、模型请求或变量更新重试。

## 修复前后验证

先新增失败回归，再修改实现：

- 核心回归复现 display 正则分别替换成空串、空白、内部标签；修复前最终正文为 `''`，修复后恢复安全正文。另覆盖 `cleanText` 缺失时从安全原始投影恢复正文。
- UI 单独覆盖空展示结果、只有空白的结果、缺少回退字段的旧结果，以及回退文本中的推理标签剥离。
- 浏览器通过真实 `pipeline:chunk` 与 `pipeline:complete` 事件复现流式可见、完成后消失。三种替换情况在修复前全部失败，且失败前均已确认思维链与日报仍显示；修复后三种全部通过。
- 预设展示与回合结果卡浏览器检查最终 **16/16 通过**，包含普通 Markdown、美化沙箱、行动按钮、历史恢复和多个专用预设。
- `preset-regex-runtime-regression.mjs`：**23 项通过**；`preset-output-app-shell-regression.mjs`：通过。
- 完整 `NODE_ENV=test npm test`：一次连续通过，退出码 0，耗时 86.51 秒。
- 修改模块语法、差异空白及 source/public 一致性检查通过。

浏览器检查中发现历史恢复的一条旧断言要求整个正文容器只有正文；该容器现已包含回合结果卡，因此将断言准确限定到正文段落，继续检查历史推理不进入正文、历史不重建沙箱。

证据保存在 `reports/narrative-display-fallback-20261005/`：`browser-before.log`、修复前截图 `before-*.png`、`browser-final.log/json`、`project-full-after.log/json`。测试使用合成内容，没有调用付费模型或操作玩家存档。

本轮仅修改并验证本地代码，未部署正式站、推送 GitHub 或发布 Android 安装包。
