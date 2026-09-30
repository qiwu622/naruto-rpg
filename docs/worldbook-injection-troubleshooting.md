# 世界书关闭/绿灯条目全量注入

修复日期：2026-09-30。

## 症状与复现

导入酒馆世界书，关闭的条目和没有命中关键词的绿灯条目仍出现在正文提示词中。浏览器回归使用真正的文件导入、localStorage、V2 迁移、回合证据编译和 writer 提示词投影，无需调用模型。

固定样例只有关闭、绿灯、蓝灯三条。没有命中任何关键词时，修复前正文提示词为 29,840 字符；修复后为 1,484 字符。此数字是这个复现样例的字符数，不是所有玩家的上下文或 token 数。

## 原因

1. `schema-v2.js` 将 `sourceKind=custom` 等同于强制 `enabled=true`、`activation.mode=always`，覆盖玩家开关。
2. `runtime-resolver.js` 将所有自定义条目列为必选，既不判断触发，也不计入预算。可选条目的第一条也存在超限例外。
3. 编辑器导入丢弃 `constant` / `isAlwaysOn`，把 `keysecondary` 混入 `key`，导致蓝绿灯和附加条件不可恢复。
4. 旧知识库保存后没有清理查询和场景缓存；同名自定义条目的 V2 合并还可能把关闭条目的正文并入启用条目。

## 修复契约

- 统一在 `js/data/worldbook/activation.js` 解释启用、常驻、关键词、手动和次关键词条件。导入对象字典、条目数组、原生 `custom` 导出都走同一逻辑。
- 关闭优先于其他触发。绿灯只有实际主关键词命中才参与注入，标题或正文的相似度不算触发；没有关键词时不自动注入。扫描范围仍是当前输入和原有场景状态，不递归扫描世界书自身内容。
- 保留主/次关键词分组、四种次关键词逻辑、大小写、整词与正则关键词。酒馆基本触发语义参考 [官方 World Info 文档](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)；枚举对应 `AND_ANY=0 / NOT_ALL=1 / NOT_ANY=2 / AND_ALL=3`。此改动不实现酒馆完整的递归、向量、概率、分组和插入位置引擎。
- 自定义蓝灯具有注入优先级，仍与可选条目共享条目数和字符预算；超长第一条不能例外放行。原有固定内置核心规则保留独立空间。解析结果记录预算用量和被跳过的 ID，正文不注入原始审计片段。
- 同名自定义条目独立保留触发与正文；导入时同一条不能反复被同批的同名条目覆盖。
- 保存后和本地存储发生变化后，旧检索缓存失效。编辑器可直接查看、修改模式和次关键词条件，开关作用于下一次生成。

## 旧数据处理

已有关闭状态和已有关键词自动生效，不需要清空世界书、角色或存档。旧版已经删除的蓝灯标记、已经混入主关键词的次关键词无法可靠反推；需要重新导入原世界书，或者在编辑器中校正。缺少模式的旧条目默认使用绿灯。

本修复只改变后续提示词组装，不撤回已发给模型的请求或改写既有剧情/模型历史。

## 回归命令

```sh
npm run test:worldbook
node scripts/turn-evidence-regression.mjs
node scripts/prompt-preview-regression.mjs
node scripts/lingxi-worldbook-management-regression.mjs
node scripts/lingxi-project-write-adapters-regression.mjs
node scripts/canon-runtime-regression.mjs
```

浏览器回归覆盖实际导入、最终正文提示词、模式切换、关键词编辑、关闭/开启、正文编辑、导出再导入、同名条目和桌面/手机编辑器。截图在 `reports/worldbook-activation/`。
