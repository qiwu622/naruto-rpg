# ADR 0006：SQLite 驱动与单实例生命周期锁

- 状态：已接受
- 日期：2026-08-22
- 修订：2026-10-04，改用 Node-API 驱动并将最低 Node 版本调整为 22。

## 背景

首版曾承诺 Node 18。后续构建依赖已要求 Node 22，部署安装器固定使用 Node 22.23.2。联机持久层需要同步的短事务、`BEGIN IMMEDIATE`、backup API、精确受影响行数和启动时的跨进程排他门禁。

## 决策

使用锁定版本 `better-sqlite3@13.0.3`，最低运行环境为 Node 22，并由应用层串行 writer 队列统一调度写事务。该版本提供所需的同步事务、pragma、backup 与受影响行数接口；模型调用、网络和大型候选计算仍必须在事务外完成。

修订原因：Node 24.19 的 `node::ObjectWrap` 清理钩子回补不完整，会使按该版本头文件编译的旧 SQLite 驱动在分配触发的 GC 中原生崩溃（[Node #65446](https://github.com/nodejs/node/issues/65446)）。13.x 改用 Node-API，避免旧 ObjectWrap 析构路径。正式驱动与测试驱动保持一致，不再在 Node 22+ 的回归中替换成 `node:sqlite`，也不通过强制 GC、重试崩溃或旧头文件重编译隐藏问题。

数据库初始化前，使用 `proper-lockfile` 对与规范数据库路径绑定的生命周期锁目标取得跨进程排他锁，并保持心跳直到服务关闭。锁获取失败、锁遭破坏或初始化自检失败时拒绝启动联机 writer。该锁不是残留 PID 文件；数据库唯一约束、CAS 与 SQLite 写锁仍是业务正确性的最终防线。

## 后果

- 13.0.3 随包提供 Node-API 原生模块，无需首版 11.10.0 的安装脚本例外；安装继续通过锁文件复现。
- 一个进程内只有一个联机 writer；读查询使用短读连接或短读操作。
- 迁移到第二实例前仍必须先完成 ADR 0002 规定的 PostgreSQL 与跨实例协调迁移。
- SQLite 驱动或最低 Node 版本若改变，必须更新本 ADR 并重跑启动、备份和恢复回归。
- 回归必须覆盖大量临时 Statement 的自动 GC、生产只读连接/生命周期锁，以及完整联机套件。见 `scripts/multiplayer-sqlite-native-lifecycle-regression.mjs`。
