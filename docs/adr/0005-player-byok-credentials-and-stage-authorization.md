# ADR 0005：联机模型调用采用玩家 BYOK 与逐阶段授权

- 状态：已接受
- 日期：2026-08-22

## 背景

联机 Referee、Writer、Reviewer 与 Continuity Steward 在服务端后台运行，双方即使断线也要能够恢复。浏览器临时携带 Key 的现有代理不能支撑后台续跑，也不能证明哪位玩家授权了哪一阶段、哪些私密数据可以发送到哪个自定义端点。

## 决策

平台不提供或垫付模型额度。每个席位只绑定自己拥有的 active endpoint profile；profile 可以从主面板已保存的 API 方案导入，并明确选择模型。房间凭证使用方式是三个互斥选项：始终使用 A、始终使用 B，或按回合交替使用；交替策略从第 1 回合的 A 开始，奇数回合使用 A、偶数回合使用 B。

双方明确确认同一个策略 revision 后，该确认构成对该策略、当前 profile 绑定、调用记账元数据和准确数据处理告知的预先授权。任一绑定或策略变化都会产生新的策略 revision，并使旧确认失效。服务端随后仍须为每个回合按策略解析唯一付款席位，物化并冻结明确的 shared/Writer selection、精确 profile 与数据类别同意、单回合 execution grant 和 billing authorization；`dual_pov` 的 A/B Writer 与 shared 阶段使用同一个策略解析结果。第一份行动锁定后，本回合映射不得改变。

玩家主动保存的 API Key 进入独立加密凭据库，使用与业务数据库备份分离的主密钥做信封加密，并绑定所有者、规范化 endpoint origin 和 revision。读取接口永不返回明文。每次调用在出站前冻结 plan、grant、consent 与 transport，并在调用前后记录请求/token/重试 usage；策略指定的席位或 profile 不可用时必须等待修复，平台不得静默换用另一玩家、另一配置或平台额度。

自定义地址只支持服务端明确实现的协议适配器，并必须通过公网 HTTPS、DNS/重定向与 SSRF 校验。

2026-09-03 修订：确认 profile 与房间策略时不再执行或要求固定 JSON 能力探测。该探测只覆盖简单固定对象，不能证明模型可以完成正式 Referee、Writer 与 Continuity 契约。新建正式执行计划统一冻结 `json_protocol`，兼容性由真实阶段的完整 JSON/schema 校验与同阶段续修判定；失败不得写入权威状态。旧 probe 记录与接口仅为存量兼容保留，不再参与准入、选择就绪或计费计划生成。

2026-09-03 修订：取消应用内部按阶段累计请求数、输入 token、输出 token 和 retry 数量中止正式联机调用的行为。既有 plan/grant/schema 中的 `max_*` 字段继续作为不可变授权快照和审计兼容元数据，但不再是运行时硬上限；真实 provider usage 仍逐次写入 append-only ledger。旧版本已经因 `BILLING_BUDGET_EXHAUSTED` 暂停的回合可直接重试，不要求扩预算 amendment。

## 后果

- 保存凭据或绑定 profile 本身不等于接受房间凭证策略；双方必须分别确认同一策略 revision。
- profile、credential origin、模型、策略、数据类别或条款指纹变化会使旧授权与同意失效。
- 策略确认减少普通界面的重复选择，但不会取消逐回合明确 selection、单回合 grant、授权快照和 usage 记账。
- 已发出的真实费用写入 append-only usage ledger；产物被替换或回合作废也不改记。
- `IN_FLIGHT/UNKNOWN` 调用不自动跨 transport 或 payer 重发；恢复仍需先处理重复计费风险，但不再要求扩充调用预算。
- 保存、绑定或确认 API 方案不产生模型费用；只有正式阶段调用进入 usage ledger。
