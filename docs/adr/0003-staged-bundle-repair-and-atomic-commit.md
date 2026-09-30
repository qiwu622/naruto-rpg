# ADR 0003：Bundle 部分暂存、同草稿修复、最终原子提交

- 状态：已接受
- 日期：2026-08-21

## 背景

模型可能漏掉变量、记忆或日报，也可能重复调用、传错参数。整回合推倒重跑会浪费时间与玩家 API 费用；直接采用所谓安全子集又会让正文、状态与记忆失去一致性。

## 决策

Continuity Agent 首次只提交一个 `stage_turn_bundle`，修复阶段只提交 `repair_turn_bundle`。原生工具调用和严格 JSON 协议规范化为同一内部命令。

合法 item 立即写入 `TurnDraft` ledger；失败 item 不消费 ID。Bundle 结束后服务端自动审查完整义务集：若有错误或漏项，生成覆盖全部可修复问题的 `RepairPlan`，把错误结果返回同一 Agent，并保留所有成功 receipt。Agent 只补允许范围；相同成功 item 的保险性重发是幂等 no-op。

review 与 finalize 是服务端内部操作，模型无权调用。只有 candidate state、全部 effects、非状态义务、正文和提交前置均匹配时，服务端才在一个短事务中发布整个回合。

## 后果

- 错误不会让整回合重新生成，也不会重复扣除已成功 effect。
- 修复因网络、凭证、模型端错误或协议熔断中断时保存 session、草稿、ledger 和 RepairPlan，之后从缺项继续。
- `COMMITTED` 前客户端看不到候选状态、正式正文或未提前公开的行动原文。
- command-attempt 幂等与 effect/obligation 单次消费是两层不同机制，均需持久化约束。
