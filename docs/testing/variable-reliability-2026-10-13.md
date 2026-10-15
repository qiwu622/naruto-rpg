# 变量更新可靠性验证（2026-10-13）

本轮只在本地开发和测试，未发布网站、GitHub 或 Android 安装包。测试凭据与私有接口地址不写入代码、报告或构建产物。

## 已复现的问题与修复

| 问题 | 修复后的行为 |
| --- | --- |
| Gemini 兼容接口拒绝默认 `frequency_penalty`，相同 400 请求仍被流式客户端重试 | 按 Gemini 模型名省略不兼容参数；永久性 4xx 不自动重复，429 等暂时性错误仍保留恢复机会；其他模型的默认采样参数不变 |
| 大写业务标签通过校验，但执行解析器漏掉写入 | 解析器复用已有的业务标签提取逻辑，大小写和内部推理边界一致 |
| 混合 `<var>`、`<variable>` 按标签类型重排，先设值再加值的结果错误 | 按模型输出的原始顺序执行变量指令 |
| 思维链中的指令示例被提取为真实状态修改 | 将内部推理块作为整体跳过，不执行其中示例；更新器清洗与执行解析同时处理 |
| 多个 JSON 对象中的字符串含花括号或转义引号时，部分对象丢失 | JSON 对象边界扫描区分字符串、转义与结构字符 |
| 战斗 JSON 的同名 `state` 覆盖经过校验的标签属性 | 执行经过校验的 `<combat state="…">` 状态 |
| 仅缺少自检段就拒绝其余合法更新 | 自检缺失改成提醒；JSON、字段类型、执行路径和必要事实记忆仍检查 |
| 流式响应达到输出上限，已有标签恰好闭合时被误认为完整更新 | 直连、代理与 Claude 流式链路传递结束原因；明确标记截断，不把可能缺失后半段的状态锁定为完整结果 |
| 模型把任务报酬写进记忆，却漏掉任务自身的奖励字段 | 增加任务约定提示，区分奖励登记与实际到账，不新增业务硬性拒绝条件 |

两个旧测试脚本的私有地址默认值也已删除，改为显式本地环境配置，并移除报告中的地址回显。未改写 Git 历史。

## 自动化回归

- `npm run test:variable-updater`：76 项通过，含新增的 10 项执行一致性和 6 组请求兼容性检查。
- `preset-review-regression.mjs`：49 项；`combat-state-corruption-regression.mjs`：6 项。
- `variable-memory-integrity-regression.mjs`：19 项；`narrative-artifact-regression.mjs`：13 项。
- `ai-stream-regression.mjs`：35 项；`deepseek-mode-regression.mjs`：12 组；`full-ai-adaptation-integration-regression.mjs`：10 项。
- `inventory-skill-regression.mjs`：30 项；`npc-progression-regression.mjs`：8 项；`agent-runtime-regression.mjs`：35 项。
- `turn-receipt-pipeline-regression.mjs`：9 项；`pipeline-state-epoch-regression.mjs`：14 项；`pipeline-state-epoch-browser-regression.mjs`：8 组真实 Chromium / IndexedDB 检查，覆盖正常回合提交与切档保护。
- `android-ai-fetch-regression.mjs`：7 项模拟原生桥接检查；不等同 Android 实机验收。

## 本地 Flash 实测

接口模型列表标识为 `gemini-3-flash-preview`。仅发送虚构的训练、NPC 与任务场景，没有使用玩家存档或真实剧情。请求由本机发出；模型结果随后通过项目实际更新器、指令解析器和状态/任务模块核对。

| 场景 | 实际结果 |
| --- | --- |
| 训练与物品消耗 | 经验 10 → 13，金钱 1000 → 1100，最后一枚烟雾弹删除，训练进度 1/2，地点更新 |
| NPC 成长与未选选项 | 在场 NPC 晋升中忍、忍术熟练度 20 → 25、信任 10 → 12；未选购买选项未修改背包、金钱或地点 |
| 恢复资源、接取护送任务 | 查克拉 40 → 50，任务为进行中；修正提示前约定报酬遗漏，修正后 `reward_ryo = 3000`，金钱仍为 1000、经验仍为 10，没有提前发奖 |

共 10 次 HTTP 请求，其中 2 次页面/模型发现、8 次生成请求尝试；生成尝试包含 2 次旧参数导致的 400、2 次连接异常、4 次完整响应。最短请求起始间隔为 47 秒，未超过每分钟 5 次限制。完成响应中包含流式和非流式结果。

任务期限在最后一次模型结果中仍以任务目标与记忆文字表达，未全部结构化。本轮修复减少已复现的漏写、错写和无效重试，不承诺消除所有模型语义遗漏或接口断连。

## 交付边界

源文件与 `public` 镜像同步，检查语法、差异空白和当前源码敏感信息残留。此前的存档和记忆功能改动保留。本轮未运行整个项目的所有测试，也未做线上玩家存档或 Android 实机验证。
