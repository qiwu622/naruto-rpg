# NovelAI 官方生图排查

网页端的官方 NovelAI 请求经过项目服务器 `/api/ai-proxy`。服务器需要能访问 `https://image.novelai.net`；电脑浏览器能打开官网，并不代表服务器能连通。

## 本次本机验证（2026-09-27）

- WSL 未配置 AI 正向代理时，访问官方文档连续两次在 12 秒超时。
- 使用电脑现有且经 WSL 验证可达的代理后，官方标签接口返回 200；本地忽略提交的 `.env` 已配置对应 `AI_PROXY_FORWARD_URL`。
- 通过真实 Adapter → ImageTransport → 项目代理 → 官方生成接口，V4.5 Full、512×512、1 步生成成功：HTTP 200，ZIP 解出 PNG，250351 字节，只有 1 次请求、0 次重试。
- 测试 Token 仅通过标准输入传递，未写入项目、配置或报告；测试图片未保存。以上生成结果来自本机环境。相关修复与画师串功能随后已随测试站构建 `2609271343` 部署，详见[部署记录](staging-deployment-2026-09-27.md)；部署期间未再次调用远端生图，也未将本机代理地址复制到服务器。

接口字段对照 [NovelAI 官方图像 API 文档](https://image.novelai.net/docs/index.html)。

## 添加画师串

在文生图设置中选择 NovelAI，在「画师串」填写标签并保存。支持多行与权重写法，例如 `1.2::artist:example_a::, {artist:example_b}`（示例占位名）。生成时追加到正向提示词，同时写入 V4 的基础提示词，负向提示词不受影响。留空并保存即可停用；每次请求独立组合，不会在重试时反复累加。

「测试连接」现在实际请求免费标签接口，20 秒超时，只报告网络是否连通；鉴权和余额仍以生图结果为准。

## 先检查服务器出口

项目使用 `AI_PROXY_FORWARD_URL` 配置 AI 请求的 HTTP CONNECT 正向代理。它与 Discord 使用的 `PROXY_URL` 分开，也不会自动采用电脑浏览器代理或普通 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。

在运行项目的同一台机器、同一运行环境中执行：

```bash
node scripts/verify-novelai.mjs
```

如果该运行环境确实能访问本机代理，例如已验证可用的 WSL 本地 `127.0.0.1:7897`：

```bash
AI_PROXY_FORWARD_URL=http://127.0.0.1:7897 node scripts/verify-novelai.mjs
```

**不要把电脑的 `127.0.0.1:7897` 原样部署到远端服务器。** 远端的 `127.0.0.1` 指远端自身；应使用远端实际可达、明确配置的出口代理。诊断脚本不会修改 `.env` 或运行中的服务。服务配置变更需按现有部署流程应用。

默认诊断只 GET 官方 `/ai/generate-image/suggest-tags`。输出 `mode: "network-only"`，且始终保留 `tokenVerified: false`。这个接口对无效 Token 也可能返回 HTTP 200，因此只能证明标签接口连通，不能证明 Token、余额或生图权限有效；它不会生成图片。

## 显式执行一次最小生图

只有添加 `--generate --stdin-key` 才生成一张 512×512 图片，默认 1 步，可使用 `--steps 2` 或 `--steps 3`。这一步可能消耗 NovelAI 点数。

脚本仅从管道标准输入接收 Token，不接受 Token 命令行参数或 Token 环境变量。使用 Bash 隐藏输入，避免令牌进入终端回显或 shell 历史：

```bash
read -rs -p 'NovelAI Token: ' novelai_token
printf '\n'
printf '%s' "$novelai_token" | AI_PROXY_FORWARD_URL=http://127.0.0.1:7897 node scripts/verify-novelai.mjs --generate --stdin-key
unset novelai_token
```

上面的代理地址仅适用于已确认该地址可用的本机环境；直连正常时去掉 `AI_PROXY_FORWARD_URL=...`。不要在命令中粘贴真实 Token。允许输入带 `Bearer ` 前缀的 Token；脚本会去掉前缀。

可选参数：

| 参数 | 用途 |
| --- | --- |
| `--model ID` | 默认 `nai-diffusion-4-5-full`，可指定其他已获准模型 |
| `--steps 1\|2\|3` | 最小生图步数，默认 1 |
| `--timeout-ms N` | 1000～300000 毫秒；默认 GET 20 秒、生图 120 秒 |
| `--help` | 显示帮助，不访问接口 |

成功出图后会报告 HTTP 状态、响应类型、解码后的图片 MIME、尺寸和字节数，并设置 `tokenVerified: true`。图片仅在内存中验证，不保存文件，也不输出图像 Base64 或 Token。所有诊断请求均禁用重试；失败生图不自动重发，避免重复计费。

## 读懂结果

- `forwardProxyConfigured: false`：该诊断进程没有配置 AI 正向代理；这不是错误，但服务器必须能够直连官方地址。
- `network-only` 成功：只证明当前运行环境经过项目代理能访问标签接口。需要显式最小生图才能验证完整链路。
- HTTP 401 / 403：结合具体响应判断。既可能是官方鉴权/权限问题，也可能是项目代理的目标安全限制；不能单凭状态码认定 Token 错误。
- 超时或连接失败：先检查项目服务器出口和目标 DNS，再检查模型参数；增加等待时间不能修复不可达的网络。
- HTTP 400：保留参数错误文字，核对模型、采样器和请求格式。
- HTTP 402 / 429：核对官方余额或速率限制；脚本不会自动重试。
- 已收到 ZIP 但解码失败：属于响应内容或 ZIP/图片处理阶段，应与网络、鉴权错误分开排查。

退出码 `0` 表示本次所选诊断模式成功，`1` 表示请求/解码失败，`2` 表示参数或标准输入用法错误。`network-only` 的退出码 `0` 不意味着成功生成图片。

## 隔离边界

脚本在导入配置前设置 `NODE_ENV=test`，仅启动监听 `127.0.0.1` 随机端口的最小 Express 应用，挂载真实 `ai-proxy` 路由，并使用真实 `ImageTransport` / `NovelAIImageAdapter`。它不会启动 `server/index.js`、初始化数据库、启动联机实例、写入存档或部署。

`AI_PROXY_RETRY_MAX_ATTEMPTS=0` 明确关闭上游重试；未配置时仍使用项目默认值。诊断进程强制设置为 `0`，并使用每次运行独立的内部会话标识保护临时本地代理。
