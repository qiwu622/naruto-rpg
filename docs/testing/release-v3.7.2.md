# v3.7.2 发布验证

日期：2026-10-20。用户授权将此前本地修复一并发布至正式站、测试站、GitHub 和 Android，网站与客户端同步公告。

## 发布内容

- 正式站：https://www.qiwu.asia/ ，版本 3.7.2，构建 2610201938。
- 测试站：https://www.qiwu.asia:8080/ ，版本 3.7.2，构建 2610201937。
- 网站公告：https://www.qiwu.asia/announcements.html ，含历史版本。
- GitHub：https://github.com/qiwu622/naruto-rpg/releases/tag/v3.7.2 ，APK 已上传。
- Android：3.7.2 / 30702；既有下载地址与客户端内更新清单保持不变。
- Android APK：29,814,712 字节；SHA-256 `a7ec1c6c5164a64692ce135d54328081916be901f30bc1f0a39ca4460eba3f7b`。

包含记忆原文留存、内容与长行动不再静默截断、展示/日报软提示、世界书原文保留、NovelAI 响应兼容及物品数量上限移除。详细行为和兼容边界见 [内容保留验证](content-preservation-2026-10-20.md)。未使用真实外部模型，未消耗用户 API 额度，未上传用户提供的私有模型地址或密钥。

## 网站与部署

- 正式站全量发布并验证 638 个受管理文件；测试站前端验证 268 个文件。随后正式站发布共享后端。
- Express 鉴权入口与 nginx 静态入口 HTML 的 SHA-256 一致；后端 `/health/ready` 返回 ready。
- 既有 `.env` 的发布前后摘要一致。账号、云存档、房间等运行数据不进入发布包且保留原位置。
- 安装器修复服务器无法连接自身公网地址时的发布验证：只将 TCP 目的地改为回环，仍使用公开域名 Host、SNI 和证书校验；不关闭 TLS 验证，不改变实际访客流量。
- 早期测试站尝试因公网回连验证失败而自动回滚；修复安装器并通过 14 组回归后重新发布成功。
- 生产备份：`/var/backups/naruto-rpg/full-production-v3.7.2-2610201938-81631`。
- 测试站备份：`/var/backups/naruto-rpg/frontend-staging-v3.7.2-2610201937-77806`。
- APK 首次发布备份：`/var/backups/naruto-rpg/android-20261020-194827-3646814`；下载页文案修正备份：`/var/backups/naruto-rpg/android-20261020-195836-3650306`。
- APK 版本目录：`/var/www/naruto-rpg-downloads/releases/30702-a7ec1c6c5164a646`；使用原子软链接切换，并核对完整下载哈希。

本机域名解析受现有 fake-IP 代理影响，直接公网访问超时。因此网站浏览器验证经仅绑定本机的 SSH 转发执行，保留公开 URL、Host、SNI 与正常 TLS 证书校验；不能据此声称已验证所有地区的公网连通性。实际正式站/测试站 360px、1280px 公告与登录页无横向溢出，公告版本正确。

最终服务器侧正常 TLS 复核通过：两站构建号、公告、下载页 3.7.2 文案、Android 清单完整性字段及鉴权入口一致。网站点击下载的浏览器自动化在本机转发链路出现截图字体等待与导航超时，未完成整条浏览器下载流程；不能把该脚本标为通过。安装器已从网站下载完整 APK 并核对哈希；Android 客户端内实际下载与系统覆盖安装测试通过。

## Android

使用项目原有构建与签名渠道，260 个共享文件与源码逐一一致，签名通过，服务端及私有文件未进入 APK。沿用既有 debug 签名的测试包；不改变签名，支持覆盖安装。

以下均为独立 Android 15 / API 35 模拟器实测，不代表所有品牌真机：

- 旧 3.5.3 覆盖升级至 3.7.2，localStorage、6 个时间线节点、主线/IF 分支与原始置顶记忆保留。
- 9 组实际 WebView/原生桥验证：共享界面、原生中文流式传输、Agent SDK、gzip、错误响应、重定向凭据隔离、取消生成、系统文件保存/取消/导入。
- 横竖屏与模拟刘海共 4 种状态；软键盘弹出/收起后视口恢复。
- 客户端内下载由真实 DownloadManager 完成，通过未知来源安装许可页与 Android 系统安装器覆盖安装；安装后 APK 哈希与发布包相同，localStorage 与两条分支继续保留。下载测试使用本地 instrumentation 上游，未向生产桥添加任意 URL 覆盖入口。
- 修正测试脚本在再次运行时复用旧临时下载端口的问题：仅在专用模拟器测试准备阶段取消前次任务；不改变客户端的断点恢复与安装逻辑。

原始报告：`reports/android/release-v3.7.2/{verification,device-verification,upgrade-preservation,safe-area-verification,in-app-update-device,site-verification}.json`；网站公告报告：`reports/release-v3.7.2/website-ui-verification.json`。报告含本机路径，未整体上传 GitHub。

## 自动化验证

- `NODE_ENV=test npm test` 全部通过。
- `NODE_ENV=test npm run test:multiplayer` 66 个脚本全部通过。
- `npm run test:content-preservation` 10 组与手机 Chromium 真实点击通过。
- Android App、更新、文件导出、原生 AI 传输、可选云端及联机回归通过。
- 部署/Service Worker/构建版本浏览器回归通过；安装器 14 组测试通过。
- 下载页增加本地版本一致性检查，防止 APK 更新后标签与公告仍显示旧版本。

## 升级注意

网页刷新即可；安卓通过客户端内更新或下载后覆盖安装，不要卸载、清空站点数据或重新开档。原存档继续兼容，向量记忆仍默认关闭。旧版已经删失且任何备份/时间线均不存在的文本无法自动恢复。
