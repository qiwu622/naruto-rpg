# 第一批体验更新验收（2026-10-03）

本批为本地待发布修改，包含回合结果卡、云同步状态与冲突处理、记忆来源与纠错。没有部署网站、推送 GitHub、构建或发布安卓安装包，也没有调用付费模型。

## 使用入口与行为

- 正文下方的“回合结果”可展开变量、记忆、日报、本地保存状态和已测得的阶段耗时。回执和时间线节点在同一次事务保存；失败不显示保存成功。旧档没有回执时显示未记录。持久回执不编造尚未完成的数据库写入耗时，实时回执可显示实测耗时。
- 存档库显示当前个人档同步状态，手动上传另有对应档案的状态。失败可以重试，版本冲突可以保留双方副本。自动同步只在本地持久化完成后运行，切档与切账号使旧任务失效。同根本地文件导入会解除旧云来源绑定。旧上传完成时若本地已有新进度，继续提示本地尚未同步。
- 设置中的记忆面板增加搜索、分组、分页、来源预览、修改、否定、置顶和修订记录。来源预览不切换游戏节点；旧档缺乏证据时明确显示来源未知。
- 记忆修订创建同回合的新检查点，不改原节点，不重复聊天记录。在已有后续的历史节点修订时新建 IF 线。写盘失败或并发状态变化时不提交过期修订。
- 纠错规则作用于正文记忆、Agent 状态和检索、连续性证据、灵希记忆读取、后续摘要和深度整理。完整规则保存在各节点；提示词只发送有界的最终修订摘要。未使用此功能的档案沿用原有提示词组成。
- 撤销同时撤销同一事实之后依赖它的修订。它不回退此后发生的剧情或新记忆；需要完整恢复旧进度时读取修订前的时间线节点。旧摘要在后续整理前失效，避免把同一错误换个摘要带回来。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `NODE_ENV=test npm test` | 退出码 0；全量回归通过 |
| 回执模块 / 实际流水线 | 7 / 9 项通过 |
| 回执组件与真实 AppShell 浏览器测试 | 11 项通过 |
| 云同步队列、代际与本地版本 | 15 项通过 |
| 云客户端 / 服务端原子冲突 | 10 / 5 项通过 |
| 存档库云端浏览器操作 | 13 项通过 |
| 记忆规则纯函数 / 编辑器交互 | 22 / 11 项通过 |
| 记忆实际 IndexedDB、IF 线、摘要与浏览器操作 | 7 项通过 |
| 原记忆 / 灵希状态读取 / 连续性证据 | 12 / 5 / 11 项通过 |
| 源码与 public 镜像 | 224 份一致 |
| `git diff --check` | 通过 |

全量测试后发现的边界修正，分别重跑了对应的回归和浏览器测试：修订内容重复扩写、修订上下文预算、旧上传成功时本地仍有新进度、云管理按钮绑定和同根导入解绑。

主要命令：

```sh
NODE_ENV=test npm test
npm run test:turn-receipt
npm run test:memory-corrections
NODE_ENV=test npm run test:cloud-save
playwright test tests/ui/turn-receipt.spec.mjs tests/ui/turn-receipt-app-shell.spec.mjs
node scripts/public-sync-regression.mjs
git diff --check
```

本机浏览器专项使用 Windows Node 从项目 UNC 路径运行；测试服务器绑定本机端口，不访问正式站。失败注入包括存储写入失败、并发状态变化、上传失败、双端同版本并发写入和过期回调。

## 视觉检查

- 三块新功能统一深墨色、暖金色视觉。回合结果卡区分概览与展开详情；云同步使用状态图标、次要说明与明确的操作按钮；记忆卷宗移至记忆设置顶部，分开事实、来源、操作与折叠修订记录。
- 美化后重跑回执模块 7 项、流水线 9 项与浏览器 11 项，云端操作浏览器 13 项，记忆编辑器 11 项与实际数据库/浏览器 7 项，全部通过。实际设置页额外检查桌面及 360px 的展示、编辑操作与至少 44px 的按钮尺寸。
- `reports/memory-corrections/memory-settings-desktop.png`、`memory-settings-mobile.png`、`memory-settings-mobile-editing.png`：真实设置面板中的记忆卷宗和窄屏编辑状态。
- `reports/memory-corrections/memory-mobile.png`：360px，搜索、分页、编辑和撤销，无横向溢出。
- `reports/memory-corrections/memory-desktop.png`：桌面记忆列表。
- `.codex-tmp/turn-receipt-app-shell.png`：真实正文页结果卡展开。
- `.codex-tmp/receipt-visual-shell-360-folded.png`、`receipt-visual-shell-1280-failed.png`：真实正文页窄屏折叠与桌面失败状态。键盘可展开，减少动态效果时关闭过渡。
- `reports/save-library-cloud/sync-retry-mobile.png`、`sync-conflict-mobile.png`：390px，重试与保留双方副本可见。
- `reports/save-library-cloud/sync-five-states-mobile.png`、`sync-five-states-desktop.png`：同步各状态；360/390/768px 检查无内部横向溢出，操作按钮至少 44px，减少动态效果时停止上传图标旋转。

截图和测试日志为本地验收产物。安卓原生壳未重新打包或真机测试，本批仅验证共用网页逻辑和浏览器手机尺寸布局。
