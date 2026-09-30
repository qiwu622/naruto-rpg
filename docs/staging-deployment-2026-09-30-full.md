# 测试站全量发布：2609301313

测试站：<https://www.qiwu.asia:8080/>。版本 **3.5.0**，构建 **2609301313**。后端于 2026-09-30 13:16:08（北京时间）启动，发布和公网校验成功。

本次使用修复后的 **部署测试站.bat → deploy.ps1 → apply-release.py** 实际全量发布。当前只有 `/home/yangding/火影` 一个 Git 工作区，包从当前源码生成，包含其他 agent 已留在该工作区的修改，没有回退或清理这些修改。

## 发布范围

- 217 个完整静态文件，包含图片、地图、浏览器模块及应用桥接。
- 324 个后端/共享文件，包含全部服务端 JS、11 个 SQLite SQL 迁移、完整共享 JS 依赖树和 npm 锁定清单。
- 6 个运维/安装文件，包含 Node 22 运行设置、服务限制、五个云存档槽位设置、内存参数、测试站 Nginx 配置和公共安装器。
- 总计 547 个清单文件，后端入口的 162 个相对导入模块检查通过。346 个源码文件有源文件指纹记录；Windows 与 WSL 的指纹一致，发布后再次核对当前源码未变化。

包括存档库美化、统一时间线管理入口、IF 分支管理、个人/联机档分离、房间历史及退出保存、云端存档管理与新接口，也包含当前工作区的变量、世界书、联机、预设、生图、设置和应用相关修改。应用原生 APK 未在本次网页发布中重新生成。

## 测试与验收

发布前本会话已观察到以下命令成功退出：

- `NODE_ENV=development npm test`：完整主测试通过。
- `npm run test:multiplayer`：64 个联机回归脚本通过。
- `npm run test:save-library`：13 组本地存档/房间检查及 10 组真实 Chromium IF 管理检查通过。
- `NODE_ENV=development npm run test:cloud-save`：兼容/流式、5 组新 API 和 8 组真实浏览器云管理检查通过。
- `npm run test:deployment`：Windows/WSL 离线包、源码变化拒绝、实际文件系统安装/故障回退、成功回执清理后重试、后续文件变化拒绝和缓存版本检查通过。Windows 原生 Node 单独运行部署回归亦通过，包含两份真实 `.bat` 的离线发布。
- 通过真实 Windows `.bat` 完整构建，时间线、正典和忍术说明校验及 Agent SDK 生成成功。发布后 `public-sync-regression` 再次确认 209 个共享源码/发布目录文件一致。

线上安装器核对了包中全部哈希、已安装文件、6 个正常 TLS 公网资源、登录保护和最终就绪状态。另在服务器使用实际已部署的代码和 Node 22 运行了 5 组云管理 API 回归：独立临时数据目录和合成 JWT 账号，测试结束自动清理，未使用真实玩家数据或启动第二个联机写进程。

最终现场检查：

- `version.json` 为 `3.5.0 / 2609301313 / staging`，公网响应 200。
- 后端 `ActiveState=active`、PID `1384019`、`NRestarts=0`，`/health/ready` 为 `ready`，健康看门狗定时器恢复 active，最近错误日志为空。
- 公网新接口 `GET /api/saves/storage`、`PATCH /api/saves/:id/metadata` 对未登录请求返回 401。
- 停止写进程后备份的 657 个运行元数据/SQLite 文件仍在原位，服务端私有 `.env` 保留；运行数据未进入发布包，也未被旧代码清理覆盖。
- 正式站首页 SHA-256 仍为 `5f7a2bd3438a2fae7c6315a9efe26cf0f829b9c8c10bc4a90bf1fc31f1ef73b0`。

测试站与正式站共用后端，本次有一次受控后端停机安装；正式站前端未替换。没有代替真实玩家登录线上生成剧情或调用付费模型；浏览器保存/IF/云交互在本地隔离环境验收。

## 更新脚本修复及实际重试证据

修复 Windows 入口漏打包 SQL 和新增世界书共享模块，旧脚本遗漏图片、不更新测试站后端，以及 Windows PowerShell 5.1 继承外部 PowerShell 7 模块路径的问题。两种部署器共用安装器，增加完整哈希、固定 Node 22 依赖预安装、单写进程停止后替换、成功回执、发布锁及失败回退。

本次第一次 SCP 上传连接断开，第二次成功。安装 SSH 会话也在安装阶段断开；服务器安装器完成了发布，随后同一次重试核对已安装文件并返回原成功回执，没有重复安装依赖或重启。临时大包清理完成，清单、日志、回执和永久备份均保留。

使用与异常处理见 [更新与发布](deployment.md)。

## 发布材料

```text
永久备份：/var/backups/naruto-rpg/full-staging-v3.5.0-2609301313-189092
服务器回执和日志：/tmp/naruto-rpg-release-staging-v3.5.0-2609301313-189092
本地包与清单：/home/yangding/.cache/naruto-deploy/full-staging-2609301313
Windows 调试包：C:\Users\杨鼎\AppData\Local\Temp\naruto-rpg-deploy-staging-v3.5.0-2609301313-189092
包 SHA-256：76bf6d7008973ba342489b5d63b8a605a5082e5289f261df2a73e7bbfea9e67c
源码指纹：0f57e7934dd35aaf7159c94ce449094ab74a491de43c46efbc032bd48c15dbf5
```

成功回执和备份清单记录恢复所需的旧文件、依赖和静态站。发生后续发布时，不能直接用本次备份覆盖；不要自动恢复运行数据库，以免丢失玩家的新进度。

## 当日此前发布

世界书增量修复构建 `2609300013` 见 [当日世界书发布记录](staging-deployment-2026-09-30.md)。

存档库/IF/云接口此前已增量发布到 `2609301201`，前端 14 个文件核对通过，云 API 与槽位设置发布后后端就绪。备份分别是 `/var/backups/naruto-rpg/staging-static-20260930T041102Z-if-library`、`/var/backups/naruto-rpg/cloud-management-20260930T040831Z`；本次全量发布在该版本之后完成。
