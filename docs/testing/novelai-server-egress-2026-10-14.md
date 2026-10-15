# NovelAI 服务器出口修复（2026-10-14）

本次仅调整服务器网络配置。未部署本地未发布代码、网页、GitHub 或 Android 安装包；没有执行项目构建或发布脚本。

## 配置范围

- 新增独立的 `naruto-ai-egress.service`，使用服务器已有 Mihomo 程序与已有可用出口节点，配置和进程与 `codex-egress.service` 分开。
- 只监听 `127.0.0.1:17892`，要求代理认证；不开放公网代理端口。凭据只在服务器 root 受保护目录与 systemd 凭据中保存，不进入项目或报告。
- `novelai.net` 的 HTTPS 请求走出口节点；其余 AI 地址按 `DIRECT` 继续直连。没有修改原 Codex 域名规则。
- 网站新增 systemd 配置片段 `/etc/systemd/system/naruto-rpg.service.d/novelai-egress.conf`，从 `/etc/naruto-ai-egress/client.env` 读取 `AI_PROXY_FORWARD_URL`。没有改动网站 `.env` 或其他运行参数。
- 配置已加载到网站实际进程；平滑重启约3秒。独立出口已启用开机启动和失败自动重启。

## 验证

| 检查 | 结果 |
| --- | --- |
| 服务器原直连 | 官方443连接超时 |
| 新出口 → 官方免费标签接口 | HTTP 200，返回10个标签 |
| 已发布 Adapter → ImageTransport → 项目代理 → 官方生图 | HTTP 200；`nai-diffusion-4-5-full`、512×512、1步，解码PNG 250411字节 |
| 生图请求次数 | 1次，0重试；Token只经安全管道传入，未保存Token或图片 |
| 其他接口路由 | DeepSeek未携带Key时返回401，直连路径可达 |
| 出口认证 | 无认证的CONNECT请求返回407 |
| 后端就绪 | `127.0.0.1:3000/health/ready` 返回200 / ready |
| 公网登录页 | HTTP 200；公网受保护路径仍按原配置跳转登录 |
| 网站图像代理鉴权 | 未登录访问 `/api/ai-proxy` 仍返回401 |
| 代码与其他服务 | 366个已部署应用文件哈希不变；原Codex出口配置哈希不变；网站与两个出口服务均active |

生图使用服务器已部署的 Adapter 和代理路由，在受一次性会话保护的本机诊断入口验证。没有通过玩家浏览器会话点击生图，也没有创建或修改玩家账户、存档。

## 维护

服务器配置、变更前应用哈希与验证回执保存在：

`/var/backups/naruto-rpg/novelai-egress-20261014T143257Z/`

其中 `applied.json` 记录实际进程和配置生效，`verification.json` 记录应用文件及网站检查。该目录不包含NovelAI Token或图片；服务器出口凭据也不要复制到Git。

回退时仅移除本次网站配置片段，重载systemd并平滑重启网站即可恢复此前直连设置；独立出口服务可随后停用。保留现有Codex服务、网站代码、`.env` 与玩家数据。
