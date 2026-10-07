# DeepSeek 专用适配（本地待发布）

## 开关边界

在设置 → AI 连接 → 适配模式选择“DeepSeek 专用 · 缓存优化”。默认 `adaptationMode: standard`，旧配置没有该字段时也保持关闭。只有显式选择 `deepseek` 才重排项目动态上下文并发送 DeepSeek 思考参数。

关闭时，正文、变量更新和 Agent 沿用原有上下文组成、消息角色与顺序。不能根据后端名称、地址或模型名静默打开。保存/切换 API 方案保留模式与思考档位；Claude/酒馆不使用此模式，独立辅助模型切到其他模型时不会误继承 DeepSeek 参数。

## 已确认的原因

- 原 DeepSeekAdapter 仅替换地址和默认模型，未显式配置 thinking。官方 2026-10-01 文档说明默认启用 high 思考；因此普通叙事也可能承担较多思考输出。
- 正文和 Agent 已尝试把证据放到历史之后，但通用 OpenAI 规范化把所有 system 重新合并到最前。变化的证据和记忆在历史之前打断可复用前缀。
- 代理流式、非流式和部分 JSON 流式回退未发布 usage；SDK 默认统计只认 cached_tokens，可能遗漏 DeepSeek 的 prompt_cache_hit_tokens。原缓存显示也会把缺失字段误当作零，或漏掉未命中 token。
- 代理收到只有思考、没有正文的流后会再发一次非流式恢复请求。专用模式停止这一透明重发，允许玩家手动重试；Agent 的业务修复策略保持原设置。

## 实现

`js/core/deepseek-mode.js` 为网页/Android/Agent SDK 的共享适配模块。

- 固定预设、格式契约和已有历史保留原文。仅带项目内部 turn-context 标记的运行时事实/记忆/写作素材转为当前 user 上下文，放在最新请求之前；不识别/改写任意自定义预设，不删除工具结果或事实，不把未选选项重新纳入记忆。
- 不创建自己的模型回答缓存，不复用过期变量，不把另一分支的历史追加进当前请求。历史窗口移动、读档、预设动态宏或模型切换仍可能降低命中；不为了缓存无限追加历史。
- 思考档位为 disabled/low/high/max，启用专用模式默认 disabled；思考模式省略无效 temperature/penalty，top_p 保持官方支持范围。关闭思考时保留原 temperature，不额外限制正文输出上限。
- 不发送 Anthropic 的 cache_control，也不伪造缓存键；缓存由 DeepSeek 服务端自动处理。
- SDK 原生工具调用保留 reasoning_content，后续步骤继续追加，工具顺序沿用确定排序。SDK 与 AIClient 采用相同思考选项。
- usage 支持零命中、usage-only 尾帧和缺失字段。输入总量包含命中量，不能再叠加命中量；输出总量已包含思考量，思考是子集。Agent 每个工具步骤报告一次，协议修复前的原生用量不再丢失，最终汇总不重复计算。
- 用量报告只在当前页面会话保留，不包含 Key、正文或变量，不写入存档。没有供应商字段时明确显示未知，不据此估算人民币费用。

## Harness 参考

参考用户本地 `/home/yangding/deepseek-harness`：

- `packages/core/system-prompt/src/index.ts`：区分固定系统段落与动态 user-role snapshot。
- `packages/llm/llm-deepseek/src/serialize.ts`：显式 thinking/effort，以及工具对话的思考回传。
- `packages/llm/llm-deepseek/src/translate.ts`：命中与未命中不重叠计数，最后的 usage 帧单独处理。

取其稳定前缀、动态内容后置和真实计量方式；游戏有回退与 IF 线，不能照搬无限增长的会话日志。

官方依据（核对日期 2026-10-01）：[缓存规则](https://api-docs.deepseek.com/guides/kv_cache/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[模型更新](https://api-docs.deepseek.com/updates/)。缓存是尽力复用，不能保证固定命中率或节省比例。

## 验证与后续优化

`npm run test:deepseek` 覆盖默认关闭与关闭后的请求字节等价、稳定前缀、真实提示词构造、变量链路、直连/代理/安卓、SDK 原生多步工具和思考回传、计量、方案切换、设置保存及移动布局。此回归套件使用合成内容、模拟供应商和临时本地浏览器，无付费调用。

2026-10-01 经用户授权，另外使用官方 `deepseek-flash` 完成 11 个场景、12 次真实请求。流式、非流式、低思考 JSON、正文预填充、项目默认变量预设和 SDK 两步工具调用全部通过；模式关闭时现场核对请求上下文仍与原组装结果相同。合成的 28 轮历史中，专用模式第 2、3 次请求各命中 3200 / 3517 输入 token，约 91%；普通模式三次均未命中。该组对比同时包含关闭思考的影响，不能把全部节省归因于缓存。

全部调用按官方高峰价和 usage 合计估算为 0.06473512 元；测试结束时余额接口差额为 0，尚不能据此确认账单实扣。按全部输入未命中、UTF-8 字节保守估算输入和每次最大输出预留的累计费用为 0.805632 元，低于脚本的 2 元硬上限及用户的 3 元限制。价格、样本和验证边界详见 [实测报告](../testing/deepseek-live-2026-10-01.md)。

付费测试入口为 `scripts/deepseek-live-probe.mjs`，只从 stdin 读取 Key，不加入 `npm test`。预算账本位于本地忽略目录 `reports/deepseek-mode/live-budget.json`，先预留再请求，跨启动累计、不退回失败请求额度，拒绝自动重试相同请求。`--self-test` 只验证预算保护，不访问网络。测试专用的输出上限不会写入游戏配置。

后续可根据实际各阶段用量决定是否减少重复审查、对低复杂度任务采用较低思考档位，或把大预设中的动态宏拆为单独上下文条目。本次不改变玩家的 Agent 数量、正文篇幅、预设规则或历史窗口，也不将这些策略自动应用到通用模式。
