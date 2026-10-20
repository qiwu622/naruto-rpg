# 内容删改与硬约束排查

> 发布跟进：用户随后授权更新，以下本地验证成果已随 v3.7.2 发布；见 [发布验证](release-v3.7.2.md)。下文的“未发布”描述保留为当时的验证记录。

日期：2026-10-20。下表记录修复前的隔离复现；用户确认后已完成本地修复，见 `content-preservation-2026-10-20.md`。未部署；此前 NovelAI、物品数量及世界书原文保留修复均保留。

复现脚本：`.probe-tmp/content-constraints-audit.mjs`；结果：`reports/content-constraints-audit/2026-10-20.json`。均为合成数据，不调用外部模型、修改玩家存档或读取密钥。

## 已复现

| 项目 | 位置 | 现象 |
| --- | --- | --- |
| 标签名称误删正文 | `js/core/narrative-artifact.js:85`、`:279` | `<secretary_dialogue>秘书递来一份卷轴。</secretary_dialogue>` 因标签名包含 secret 被当成私密内容，普通展示和 buildPresetPresentation 最终正文均为空。 |
| 普通正文引用标记丢前文 | `js/core/narrative-artifact.js:334` | `他看着卷轴上写着的“[回映结束]”四个字，转身离开。` 展示结果只剩 `”四个字，转身离开。`，没有核对该标记是否属于实际思考协议。 |
| 导入预设思考容器强制存在 | `js/core/main-preset-compatibility.js:1560`、`:1662`；调用处 `js/core/pipeline.js:679` | 导入预设声明先输出 think 再输出正文时，只返回正常正文会在现有自动修复之后仍抛出 IMPORTED_PRESET_OUTPUT_INCOMPLETE，缺思考容器阻止提交。 |
| 日报格式继续触发更新器失败 | `js/core/shinobi-daily.js:65`、`:174`；`js/core/variable-updater.js:1574` | 标题改为“木叶交通”后，合法的经验 +3 与 memory 同时返回仍产生 VARIABLE_UPDATER_OUTPUT_INCONSISTENT，failureKind=daily。合法变量已经暂存供日报单独续修，不应误报成变量已丢失或整轮必然重做。 |
| 记忆写入裁剪 | `js/systems/memory-system.js:1155` | 341 字事实只存下前 180 字，末尾约定消失。相同入口用于 facts、long_term、pins、important_events；另有 NPC 备注 240 字、线索详情 180 字限制。这里发生在动态记忆写入层，不只是本轮提示词预算。完整正文仍可能存在时间线，不能表述成整份存档原文也已删除。 |
| 灵希用户补充截断 | `js/data/lingxi-persona.js:132` | 8019 字补充的末尾标记没有进入最终系统提示词，限制写死为 8000。 |
| 可点击选项截断 | `js/core/preset-regex-runtime.js:522` | 解析出的选项最长只保留 1000 字，后面的行动细节消失。 |
| 正则提示词处理输入静默截断 | `js/core/preset-regex-runtime.js:248`、`:267` | 无任何正则脚本时，150 万字后面的原文标记仍被裁掉，warnings 为空。输出超过 250 万字的另一处限制有警告，不能笼统说所有限制都无提示。 |

## 修复前建议（已按此方向实施）

先收窄正文隐藏内容识别，避免把普通自定义展示标签和正文引用当成协议；思考/展示包装缺失应有正文兼容路径。日报字数及条目数量宜作为排版提示，真实结构/类型错误与变量写入分开处理。记忆完整存储，按预算选取送入模型的部分；提示词及选项长度上限应由玩家可见地配置，至少不能静默截断。

账户/跨域与 SSRF 防护、危险变量路径、执行 HTML/脚本隔离、联机受众权限、避免未选选项进入事实记忆、关闭条目和关键词激活条件属于不同问题，不应因为名称含 sanitize/安全而直接删除。
