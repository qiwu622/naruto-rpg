# SQLite 原生清理崩溃修复（2026-10-04）

## 原因与复现

联机全量回归曾分别在备份调度和离线恢复脚本中因 `Statement::~Statement()` → `RemoveEnvironmentCleanupHook()` → `(env) != nullptr` 中止。两项脚本普通交替运行 112 次均通过，说明简单重跑不足以锁定问题。

最小复现使用实际 `better-sqlite3`，连续创建并查询 30 万个临时 Statement，同时制造少量对象分配，触发 V8 自动 GC。旧驱动在本机 Node 24.19.0 上连续 3/3 次触发同栈 SIGABRT；新增正式回归在修复前也失败。测试没有显式调用 `global.gc()`，因为它无法重现这条无当前上下文的清理路径。

上游 [Node #65446](https://github.com/nodejs/node/issues/65446) 记录了相同缺陷：24.19 的 ObjectWrap 头文件回补了析构清理钩子，但运行时缺少无需当前 Environment 即可移除钩子的配套实现。本地原生模块确实编译进了该析构路径。该异常不依赖应用忘记关闭数据库，不能通过调整 JS finally 或重试失败脚本解决。

## 变更

1. 固定 `better-sqlite3` 为 `13.0.3` 并更新锁文件。13.x 的原生绑定改用 Node-API，移除对旧 `node::ObjectWrap` 的依赖；参见 [13.0.0 发布说明](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)。采用已含后续边界修复的 13.0.3。
2. 移除旧版 `allowScripts` 例外。13.0.3 的预编译模块随包提供，不再依赖该安装脚本。
3. 将 `engines.node`、README 与 ADR 同步为 Node 22+。现有构建 SDK 也已要求 Node 22，部署安装器固定的 22.23.2 无需调整。
4. `scripts/helpers/multiplayer-test-sqlite.mjs` 改为生产连接工厂的薄包装，删除 Node 22+ 时改走 `node:sqlite` 的旧绕过。业务与端到端测试现在使用真实的只读连接、writer 队列和生命周期锁。
5. 新增 `multiplayer-sqlite-native-lifecycle-regression.mjs`，通过独立子进程覆盖 30 万次临时语句分配、查询值正确性、自动 GC 与显式 close；原生信号或非零退出直接使回归失败。
6. 联机套件执行器显式指定 `NODE_ENV=test`，无需手工覆盖本机配置；出现非零退出时报告脚本名与终止信号，保持遇错立即失败，不进行自动重试或跳过。

## 验证证据

证据目录：`reports/sqlite-cleanup-20261004/`。

- `statement-gc-before-1/2/3.log`、`regression-before.log`：旧驱动同栈崩溃和正式测试失败。
- `statement-gc-candidate-1/2/3.log`：隔离安装的新驱动相同复现连续三次成功。
- `regression-after-1/2/3.log`：项目正式依赖升级后，新回归连续三次成功。
- `legacy-fixture-create.log`、`legacy-fixture-upgrade.log`：先用旧 11.10.0 创建完整当前 schema 和 TEXT/BLOB 探针，再用新 13.0.3 打开、查询、校验及在线备份；数据保持一致。仅使用本地合成数据库。
- `multiplayer-full-after.log/json`：`npm run test:multiplayer` 一次连续执行 **66/66 脚本通过**，退出码 0；启动命令没有手工设置 NODE_ENV。
- `project-full-after.log/json`：普通项目完整 `npm test` 在 `NODE_ENV=test` 下单次连续通过，退出码 0，耗时 79.64 秒，包含服务端、存档与部署脚本回归。
- `node22-compat.log/json`：官方 Node 22.23.2 Linux x64 压缩包完成官方 SHA256 校验；独立临时目录的生产依赖 `npm ci --omit=dev` 成功且锁文件未改变，SQLite 原生查询成功。在该部署版本 Node 下，新增 30 万次 Statement 回收、启动、备份调度与离线恢复四个回归全部通过。未替换系统 Node，也未连接服务器。

原先两次失败日志保留在 `reports/multiplayer-redesign-20261004/`，本文件是其后续修复记录。未修改数据库 schema、线上数据、系统 Node 或部署运行时，未部署网站、推送 GitHub 或发布 Android 安装包。
