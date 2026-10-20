# NovelAI 响应与物品数量修复

日期：2026-10-20。仅修改本地项目及 public 共用副本；未部署网站、上传 GitHub 或打包 APK。

## NovelAI

通过真实 ImageTransport → 项目 ai-proxy → 本地上游替身复现截图原文：当 ZIP 经 HTTP gzip/Brotli 压缩时，Node http/https 保留压缩数据，但代理原先不转发 Content-Encoding，客户端解包的是压缩层而非 ZIP。现在保留该响应头，接收端先正常解码 HTTP 内容。

官方接口还支持 `{ images: [{ image: '<base64>', index, seed }] }` JSON 响应。旧适配器把所有成功响应都交给 ZIP 解包器，JSON 或直接图片同样触发该报错。现在优先依据文件头与实际内容区分 ZIP、PNG/JPEG/WebP、JSON；保留 ZIP 路径、CRC、大小、目录和解压校验。JSON 错误、HTML 页面和不完整响应显示对应原因；不因格式错误再次生图。错误说明不回显 API 密钥。

接口依据：[NovelAI 官方图像接口定义](https://image.novelai.net/docs/doc.json)（`/ai/generate-image`、`image.ImageGenerationJsonResponse`）。本地复现能够确认上述缺陷；没有此次玩家失败请求的原始响应，不能据截图断言该次响应具体属于哪一种情况。

- 修复前：JSON 图片、直接 PNG，以及经过真实代理的 gzip/Brotli ZIP 均出现截图相同错误。
- 修复后：`npm run test:novelai` 通过 48 组生图模块回归及普通/gzip/Brotli 三种真实代理往返；逐次断言仅发出一次请求。
- 测试上游全部由监听回环地址的替身提供，未联系真实生成接口、读取用户密钥或消耗生图额度。

## 物品数量

`StateManager._enforceBounds` 与灵希 ShadowStateManager 原先将物品数量强制压为 99。两处均取消上限，继续保留非负数量及原有耗尽清理语义；开局草稿和数量输入取消 9999 限制。角色物品栏原先用 999999 表示“全部”，现改为明确消耗全部库存，避免大库存残留。

- 普通变量写入及增减、物品分类别名、旧档恢复、百万数量的增加/消耗/全部丢弃均通过；32 组 inventory/skill 回归通过。
- 灵希提案使用 10000 件库存，预演与批准后的结果均为 9999，预演不修改真实库存；10 组 gameplay action 回归通过。
- 真实 Chromium 手机宽度验证 1000002 件的显示，使用一件后 1000001 件，确认丢弃后完整移除；开局输入 1000000 通过并保留到草稿。
- 不推算或补回此前已被截为 99 而丢失的历史数量；未修改玩家实际存档。

## 相邻回归

- 状态与地图、变量更新全套、开局草稿、角色面板、变量/记忆完整性、67 组时间线回归通过。
- `NODE_ENV=test` 下 15 组服务可靠性、24 组服务器与 35 组 AI 流式回归通过；7 组 Android 原生 fetch 回归通过。
- `sync-public` 完成，260 份共用源码与 public 副本一致；JavaScript 语法与 Git 空白检查通过。
