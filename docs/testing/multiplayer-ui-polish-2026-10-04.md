# 联机界面与动态等级光效验收（2026-10-04）

## 本轮范围

在原有 Web Components 和联机状态接口上更新界面，没有引入 UI 框架。大厅、房间概览、开局、正文预设、AI 设置、聊天、角色档案、悬浮窗及退出保存确认共用墨色底、暖金辅助色、朱红主要操作，以及相同的边框、圆角和控件规格。

- 大厅优先呈现创建与加入，历史房间放在下方；房间概览用两个对齐的成员卡片呈现双方状态。
- 收起 AI 设置后显示紧凑摘要栏，编辑时展开设置。开局表单归入房间设置，避免遮住房间状态与导航。
- 悬浮窗保留拖动、缩放、收起与布局记忆，增加恢复默认位置/尺寸；修复连续键盘缩放读取旧尺寸的问题。进入完整视图或新建房间后回到顶部。
- 角色档案统一身份、资源、五个分页与长文本布局。只展示已提交的角色投影数据，不改角色成长或装备字段。
- 忍阶、忍术等级、任务等级和带品质的装备复用同一等级样式。二至六阶沿实际边框运行光迹，高阶另有横向扫光；零、一阶静止。原有等级映射保持不变。
- 光迹周期依次为 12、9、7、5.5、4 秒，按等级提高速度与强度；减少动态效果时保留静态边框。不支持运动路径的浏览器也保留静态等级样式。

## 视觉参考与实现

参考以下项目的层级、对齐与交互思想，使用本项目的原生组件自行实现，未复制框架组件或增加运行时依赖：

- [shadcn/ui](https://github.com/shadcn-ui/ui)：卡片、表单与操作层级。
- [Ant Design 对齐规范](https://ant.design/docs/spec/alignment/)：标题、正文、表单与操作对齐。
- [Magic UI Border Beam](https://v3.magicui.design/docs/components/border-beam)：沿边界移动的光迹。
- [Aceternity Moving Border](https://ui.aceternity.com/components/moving-border)、[React Bits](https://github.com/DavidHDev/react-bits)：低干扰动效与明确的交互反馈。

先使用内置 image_gen 生成参考图，再实现并检查真实组件截图。生成提示词保存在 `reports/multiplayer-redesign-20261004/design-reference-prompt.txt`，参考图为同目录的 `design-reference.png`。参考图未作为产品界面素材使用。

## 主要代码

- `css/components/multiplayer-theme.css.js`：共享视觉变量。
- `css/components/multiplayer-panel.css.js`、`js/multiplayer/multiplayer-panel.js`：大厅及完整联机面板。
- `css/components/multiplayer-overlay.css.js`、`js/ui/multiplayer-overlay.js`：悬浮窗与退出确认样式。
- `css/components/multiplayer-character-panel.css.js`、`js/ui/multiplayer-character-panel.js`：联机角色档案。
- `js/ui/save-library-panel.js`：仅本轮退出房间确认样式接入，保留既有存档/云端工作。
- `css/components/grade-effects.css.js`、`js/ui/grade-effects.js`：共享等级动效与原有等级映射。
- `css/components/panel.css.js`、`js/ui/panel.js`：个人角色、NPC 与装备等级动效接入。

上述共享源文件已通过 `scripts/sync-public.mjs` 同步到本地 `public/`，不等同于部署。保留工作区中其他任务的已有改动。

## 已验证

使用项目已安装的 Playwright Chromium，运行本地测试服务器。截图使用测试角色及房间，未调用付费模型或操作线上玩家数据。

1. `node scripts/multiplayer-visual-regression.mjs`：24/24 通过。覆盖桌面 1440px、手机 390/360px、桌面缩窄至 280px 的浮窗；创建/加入、开局保存、AI 编辑、Enter 聊天、生成暂停重试、拖动/缩放/收起、角色五个分页及浏览器异常检查。
2. `npm run test:grade-effects`：通过。实际采样间隔一秒，忍阶和武器的 `offset-distance` 改变，高阶扫光的位移改变；验证等级速度、普通静止、减少动态效果及 320px 无横向溢出。
3. 最后一次布局微调后复跑：`multiplayer-ai-settings-ui-regression`、`multiplayer-opening-experience-regression`、`multiplayer-ui-state-sse-regression`、`multiplayer-session-ui-regression` 全部通过，日志为 `final-interaction-regression.log`。
4. 本轮另已通过 experience、character、app-shell、generation-progress、ui-api、NPC dossier 等现有回归；新增和变更模块完成语法检查。

全量 `NODE_ENV=test npm run test:multiplayer` 两次运行均遇到 SQLite 原生析构异常，分别发生在 offline-restore 和 backup-scheduler 测试，栈包含 `better_sqlite3.node / Statement::~Statement / RemoveEnvironmentCleanupHook`。两个脚本各自独立复测通过（4/4、2/2）。因此不能将整条全量命令报告为成功；补测详情见同目录 `sqlite-tail-verification.log/json`。本轮没有修改数据库实现、Node 版本或原生依赖来规避该异常。

最终补测从第二次中断位置开始，后续 12/12 脚本退出码均为 0，与此前完成的 53 个合计覆盖 65/65 脚本（清单见 `sqlite-coverage-summary.json`）。这表示分段覆盖完成，不代表单次全量通过。当前 Node v24.19.0 / better-sqlite3 11.10.0 的原生清理异常仍待单独复现定位；日志不能精确证明仅发生在进程退出阶段，暂未发现与本轮前端变更相关的证据。详见 `sqlite-verification-notes.md`。

后续修复：同日已通过最小复现定位 Node ObjectWrap 清理缺陷，切换 Node-API 驱动后新增 GC 回归并完成 66 个脚本的单次完整验证。上文保留美化验收当时的结果，当前状态见 [SQLite 原生清理崩溃修复](sqlite-native-cleanup-2026-10-04.md)。

## 查看结果

- `reports/multiplayer-redesign-20261004/preview.html`：真实组件截图与可运行的流光演示。
- `verification.json`：24 项界面结果。
- `grade-effects-verification.json`：动态位置采样及减少动态效果结果。
- `grade-effects-flow.webm`：实际浏览器动效录屏。
- `multiplayer-suite.log`、`multiplayer-suite-rerun.log`：保留两次全量运行的原始失败证据。

本轮仅本地开发与验证，未部署正式站、未推送 GitHub、未发布 Android 安装包。移动视口检查不代替 Android 真机 WebView 验收。
