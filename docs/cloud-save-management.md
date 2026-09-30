# 玩家云存档管理

日期：2026-09-30。

## 使用入口和保存范围

进入存档库的「个人存档」，点击「云端管理」。个人档卡片可「上传到云端」；云端列表也可「上传当前进度」。个人角色面板的「管理云存档」复用此入口。

每个云槽保存一份完整个人时间线，包括主线与全部 IF 线、冷归档、正文、记忆、日报和状态。多个角色旧档可以分槽保留。自动同步仅更新名为「默认云存档」的槽位；它占用一个槽，不自动覆盖其他名称的档，也不批量上传本地目录。将该槽改名会把它保留为普通云档，下次自动同步会新建默认槽；槽已满则报告错误。

本机库按浏览器与站点保存，云端按登录账号保存。联机快照和房间历史继续保存在各玩家本机，不混入个人云档，也不上传去覆盖服务器房间。Android 本地 App 隐藏云管理入口。

下载把校验后的档加入本地库，不改变当前游戏。读取云档会先下载，再执行与本地读档相同的完整校验、备份和事务切换。覆盖或删除云端副本前，必须将旧版本成功下载、校验并存入本地库；备份失败时保留云端版本。云端删除后仍可从本地库恢复上传，或将本地副本导出到文件。

## 玩家接口

接口统一使用现有登录 Cookie `naruto_token` 或 Bearer JWT，验证真实用户及封禁状态。云档 ID 只定位资源，所有操作另行核对 `user_id`。列表与容量只返回当前账号的条目。

| 方法和路径 | 用途 | 输入或响应重点 |
| --- | --- | --- |
| `GET /api/saves` | 列出本账号云档 | 名称、预览、大小、更新时间和版本，不加载存档正文 |
| `GET /api/saves/storage` **新增** | 槽位及空间统计 | `used_slots`、`max_slots`、`remaining_slots`、`used_uncompressed_bytes`、`used_compressed_bytes`、`max_save_bytes`、`max_upload_bytes`；响应禁止缓存 |
| `GET /api/saves/capabilities` | 上传能力 | 既有 gzip/JSON 限制，新增 `limits.max_slots` |
| `POST /api/saves` | 新建云槽 | 继续使用 gzip multipart：`metadata` JSON 与 `save` gzip 文件；服务端再次校验槽位限制 |
| `GET /api/saves/:id/content` | 下载 gzip 完整档 | 校验归属后返回压缩正文 |
| `PUT /api/saves/:id` | 覆盖完整档 | 继续使用既有原子文件/索引更新，不改变其他槽 |
| `PATCH /api/saves/:id/metadata` **新增** | 只改名称 | `application/json`，唯一允许字段为 `slot_name`，去首尾空白后长度 1–50；不更改 blob、内容哈希、revision 或预览 |
| `DELETE /api/saves/:id` | 删除指定云档 | 玩家界面须先完成本机备份，接口仍严格鉴权 |

改名输入示例：`{"slot_name":"木叶 · 留村 IF"}`。错误沿用 `{error, code}`：未登录 401、越权/封禁 403、不存在 404、名称或额外字段无效 400、不支持的媒体类型 415。新槽已满返回 `SAVE_SLOT_LIMIT_REACHED`，不会选择其他槽自动覆盖。

只改名接口拒绝 `save_data`、`preview_data`、`user_id` 等额外字段。旧服务没有新接口时，客户端兼容既有仅元数据 PUT；容量接口 404 时仍可管理已有槽。

## 部署配置和验证

`MAX_SAVE_SLOTS` 控制单账号槽数，单份原始大小与 gzip 上传限制分别由 `MAX_SAVE_SIZE_MB`、`MAX_SAVE_COMPRESSED_SIZE_MB` 控制。项目提供 `deploy/systemd/naruto-rpg.service.d/cloud-slots.conf`，设为 5 槽；自动同步与手动云档共同占用这 5 槽。容量展示的总用量是所有云档合计，文件大小上限是每份限制，不是总容量。

新增接口不需要改数据库结构，不清空已有云档或浏览器存档。测试站与正式站使用同一个现有云端后端；前端只发布测试站，API 与槽数变更在该共用后端生效。

开发回归：`NODE_ENV=development npm run test:cloud-save`。测试使用临时数据目录与两个合成账号，没有接触玩家数据或调用付费模型；10 项客户端回归、流式传输回归、5 组 API 权限/容量流程与 8 组完整浏览器联动流程通过。
