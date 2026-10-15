# v3.7.1 网页热修复验收

日期：2026-10-15。网页 v3.7.1；安卓安装包保留 v3.7.0 / 30700。

## 成因与修复

正式站 `/` 与 `/index.html` 经 Express 登录校验后读取 `/opt/naruto-rpg/public/index.html`；资源与版本清单由 nginx 的 `/var/www/naruto-rpg` 提供。原发布器只替换后者。现场确认登录入口仍引用 `261015-node-read-fix`，静态版本已经为 `2610151746`，所以普通刷新不能解决。

发布器现在将登录入口作为正式发布的管理文件，同步复制、备份、失败回退，并在发布确认和已完成发布重试时校验它与静态入口的 SHA-256 一致。测试站更新不覆盖正式站登录入口。

更新提示改为简短可关闭横条，关闭选择仅在当前会话记住该构建。刷新使用保留原路径、参数与锚点的独立请求地址，避免同一锚点网址被浏览器当成页内跳转。新版本核对一致时移除旧提示；不自动刷新，不清除网站存储。

## 本地验证

- 修复前新增的正式发布回归失败：`authenticated page still serves an old build after production release`；修复后通过。
- `npm run test:deployment` 通过：离线打包、依赖闭包、12 组安装器成功/失败回退/重复执行校验、Service Worker 缓存回归、版本单元测试与 Chromium 回归。
- Chromium 先复现仅更新静态目录时的刷新循环，再同步登录入口并确认刷新后不显示提示；覆盖 320、390、1280px 宽度、关闭后刷新不重复显示、后续新版本仍可提示。
- 刷新前写入的 localStorage 与 IndexedDB 393 回合示例原值保留；无浏览器脚本异常。截图：`reports/release-v3.7.1/banner-mobile.png`。
- `scripts/public-sync-regression.mjs`：260 份共用文件同步；`scripts/android-app-regression.mjs`：现有客户端版本、下载、更新及可选云端契约通过。
- `git diff --check` 与变更 JavaScript 语法检查通过；本地专用测试接口和密钥未进入源码、网页发布包。

## 兼容性

没有数据库迁移或存档格式变更；原浏览器刷新生效。无需清理网站数据、重新开档或卸载客户端。安卓 APK 与下载清单不变。

## 线上验收

- 正式站：v3.7.1 / `2610152331`；测试站：v3.7.1 / `2610152329`。发布器分别确认 638 份完整发布文件与 268 份测试站静态文件。
- 正式站登录入口 `/opt/naruto-rpg/public/index.html` 与 `/var/www/naruto-rpg/index.html` SHA-256 均为 `535c2bc35bde44c81dc2fd70d52083ecb74e9d181662177f4e3bd4c81f7d0613`；全部 5 处构建引用与版本清单一致。
- 两站通过正常 TLS 请求验证 `version.json`、更新公告和实际返回的 app.js、版本检查模块、Service Worker 哈希；公告为 v3.7.1 并保留 v3.7.0 历史。
- 未登录访问两站 `/` 与 `/index.html` 仍跳转登录页。没有使用玩家账号登录；登录后入口检查依据为运行中的 Express `sendFile` 路径与对应文件的哈希。
- 发布后后端、健康监控和 NovelAI 出口服务均正常，后端就绪；出口配置与有效进程设置保留。APK 与更新清单哈希和发布前一致。
- 正式站备份：`/var/backups/naruto-rpg/full-production-v3.7.1-2610152331-169807`；测试站备份：`/var/backups/naruto-rpg/frontend-staging-v3.7.1-2610152329-168738`。
- 线上核验记录：`reports/release-v3.7.1/live-verification.json`（仅保留非敏感状态与哈希）。
