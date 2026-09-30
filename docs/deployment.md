# 更新与发布

默认更新测试站 `https://www.qiwu.asia:8080/`。测试站与正式站共享 `/opt/naruto-rpg` 后端和 `naruto-rpg.service`；测试站发布会短暂重启后端，但不会替换正式站前端。

## 常用入口

Windows 双击项目根目录的 **部署测试站.bat**。它使用系统自带 Windows PowerShell 5.1，隔离外部 PowerShell 7 的模块路径，并能从 WSL UNC 路径启动构建。需要 Node、npm、WSL Ubuntu、OpenSSH 和系统 tar。

```powershell
# 构建、打包检查，不连接服务器
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1 -Mode staging -DryRun

# 全量发布测试站并保留本地包与清单
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1 -Mode staging -KeepPackage
```

WSL 在项目目录执行：

```bash
bash deploy-wsl.sh staging --dry-run
bash deploy-wsl.sh staging --keep-package
```

`deploy.sh` 兼容旧入口并转交给 `deploy-wsl.sh`，默认测试站；`deploy-v3.sh` 转交正式站模式。正式发布仍需要显式 `-ConfirmProduction` 或 `--confirm-production`。正式站双击脚本已有确认提示。

配置参考 `deploy.local.example.psd1` / `deploy.local.example.env`；本地配置只保存 SSH 服务器与密钥路径，不能提交密钥文件或服务端 `.env`。同名 `NARUTO_DEPLOY_SERVER`、`NARUTO_DEPLOY_SSH_KEY` 环境变量优先。

## 完整发布范围

每次构建运行时间线、正典及忍术说明校验，生成浏览器 Agent SDK，并同步源码到 `public/`。部署包包括完整静态资源（图片、地图、模块和移动应用桥接）、所有服务端 JS、所有 SQLite SQL 迁移、完整共享 `js/` 依赖树、锁定的 npm 清单、运行配置和公共安装器。

`scripts/deploy-manifest.mjs` 校验实际后端相对导入链，逐文件记录 SHA-256 与大小。旧 `public/`、漏依赖、漏 SQL、混入运行数据或打包期间源码变化都会使发布停止。上传前再次检查当前源码，避免发布其他 agent 修改前的旧包；修改仍在继续时应等待修改完成再启动发布。`-SkipBuild` / `--skip-build` 同样必须通过这些校验。

以下内容不进入发布包，也不作为旧代码清理目标：服务端 `.env`、账号和云存档索引、云存档文件、`server/data/`、运行中的 SQLite 数据库及 WAL/SHM。清理只针对被管理的旧 JS/SQL 代码和共享模块。

## 服务器安装与验证

Windows 与 WSL 共用 `deploy/apply-release.py`：

1. 校验上传压缩包、解包后的全部哈希和环境；使用全局发布锁阻止并发安装。
2. 在临时目录用固定 Node 22.23.2 执行 `npm ci --omit=dev`。依赖安装及真实 SQLite 备份读写检查通过后才进入停机阶段。
3. 保存旧代码、运行配置、静态站和依赖。临时停止健康看门狗，再停止唯一的数据库写进程；此时另存运行元数据和 SQLite 紧急备份。
4. 安装完整代码和依赖，验证 Nginx 配置，启动后端并等待 `/health/ready`；后端就绪后替换静态目录。
5. 通过正常 TLS 验证公网资源哈希、测试站登录跳转和 `X-Staging`，核对所有已安装文件，确认正式站首页未改。写入成功回执后恢复看门狗。

验证失败自动回退被管理的代码、配置、依赖和前端。玩家运行数据不自动回退，以免擦掉重启后新产生的进度。备份中的数据库只用于人工确认后的故障恢复；有新增迁移时必须评估新旧代码兼容性。

## 发布材料与异常处理

成功输出包括 `DEPLOY_OK`、`BUILD_VERSION`、包 SHA-256 和永久备份路径。

```text
/var/backups/naruto-rpg/full-staging-<release-id>/
  release-manifest.json   发布清单
  originals.json         原代码/配置路径与备份映射
  original/              原文件
  static.before/         原静态站
  node_modules.before/   原依赖
  runtime-metadata/      停止写进程后的应急元数据/SQLite 备份
  verified.json          成功验证结果

/tmp/naruto-rpg-release-staging-<release-id>/
  release-manifest.json
  ops/apply-release.py
  apply.log
  applied.json           成功回执
```

清理临时大文件后仍保留清单、安装日志和回执。SSH 中断后的同一次重试先核对回执和实际安装哈希；已成功时不会重复安装依赖或重启。后续发布改变了文件时，旧回执不能冒充当前成功。未确认的中断若已创建备份会停止重试，避免将半安装代码当成回退基线。

出现错误先查看该发布目录 `apply.log`、`failed.txt`、备份中的 `rolled-back` 和 `systemctl status naruto-rpg.service`。确认上一轮已退出、后端状态及最新构建后再启动新发布。不能在已有后续构建时直接覆盖旧备份，也不能复制开发机数据库到线上。

回归入口：`npm run test:deployment`。覆盖真实离线打包、模块/SQL完整性、源码变更拒绝、文件系统安装和故障回退，以及成功后的清理重试。Windows 运行该命令还会启动两份真实 `.bat` 入口的离线发布。
