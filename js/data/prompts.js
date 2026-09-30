import { SHINOBI_DAILY_EXAMPLE } from '../core/shinobi-daily.js';

const dailyContract = `<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>`;

export const MAIN_SINGLE_CALL_NO_CHANGE_EXAMPLE = `<reasoning>
1. 本轮请求原文：已核对；查看公告。
2. 任务拆解与硬约束：已核对；只描写查看公开公告的结果，不替玩家决定后续行动。
3. 权威证据与不确定项：已核对；仅使用当前场景中的公开告示，不补写未公开情报。
4. 时间线、地点与场景：已核对；时间与地点保持当前状态，在场者没有新增。
5. 玩家意图、行动边界与判定：已核对；本轮只是查看，不需要判定，也没有结算行动结果。
6. NPC动机、知识边界与关系：无证据；本轮没有NPC互动或关系变化。
7. 连续性状态：已核对；伤势、资源、物品、忍术、任务、线索、承诺与历史均未变化。
8. 因果、结果、记账与停止点：已核对；展示公开信息后停在选择下一步的交互点，无业务状态需要记账。
9. 场景铺陈：已核对；公告栏位于村内公开位置，值班人员站在栏侧，字迹与印章清晰可见。本轮只是查看，不涉及身体与动作细节。
</reasoning>

公告栏上的纸页按任务等级分区钉好，墨迹与印章都很清楚。最上方是道路检修与天气提醒，下面列着几项仍在受理的公开委托。值班人员没有催促，只把登记簿放在手边，等候下一步询问。

[行动] 查看某项委托的详情
[行动] 询问近期道路情况
[行动] 暂时离开公告栏
<state_update>{"changed":false}</state_update>
<memory>{"summary":"玩家查看了公开公告栏，尚未接受委托或采取其他会改变状态的行动。","facts":["公告栏展示道路、天气与公开委托信息"],"clues":[],"pins":[],"remove_pins":[],"npc_notes":{}}</memory>
${dailyContract}`;

// Imported presets keep their own reasoning/body wrappers.  This example is
// intentionally limited to the project-owned machine tail so it cannot teach
// a model to replace the imported presentation envelope with <reasoning>.
export const IMPORTED_PRESET_SINGLE_CALL_NO_CHANGE_EXAMPLE = `<state_update>{"changed":false}</state_update>
<memory>{"summary":"本回合没有发生需要写入变量的业务变化。","facts":[],"clues":[],"pins":[],"remove_pins":[],"npc_notes":{}}</memory>
${dailyContract}`;

export const VARIABLE_UPDATER_MIXED_EXAMPLE = `<variable_thinking>请求复述：护送途中击退拦路者，把用完的烟雾弹丢掉，继续前往东部驿站。
1. 时间地点与地图：木叶东门 -> 正文确认队伍到达东部驿道 -> 火之国·东部驿道；地点与地图均需更新。
2. 资源与属性成长：历练120 -> 正文确认击退拦路者 -> 历练增加15；有明确战斗结算依据。
3. 技能与能力：现有技能 -> 正文没有学习、遗忘或熟练度变化 -> unchanged；无技能标签。
4. 物品、金钱与装备：烟雾弹1枚 -> 正文确认最后一枚已经用完 -> 删除烟雾弹；不把数量设为0。
5. 任务、目标、声望与历练：护送药材进行中 -> 正文确认通过第二处路障 -> 任务推进到第二步；保留进行状态。
6. 人物关系与NPC状态：海野伊鲁卡信任10 -> 正文确认其认可本轮处置 -> 信任增加1；只记录公开表现。
7. 战斗、伤势与世界事件：遭遇拦路者 -> 正文确认战斗胜利且驿道恢复通行 -> 战斗结束并记录事件结果。
8. 记忆、线索、约定与待办：护送约定未完成 -> 正文确认仍需抵达东部驿站 -> 记录本轮结果与下一步待办。</variable_thinking>
<update_manifest>{"domains":{"world":"updated","attributes":"updated","skills":"unchanged","equipment":"updated","missions":"updated","relationships":"updated","combat":"updated","events":"updated"},"present_npcs":{"海野伊鲁卡":"updated"},"active_missions":{"M-护送药材":"updated"}}</update_manifest>
<variable>{"path":"world_state.current_location","op":"set","value":"火之国·东部驿道"}</variable>
<variable>{"path":"world_state.map.known_locations","op":"assign","key":"火之国·东部驿道","value":{"x":68,"y":34,"desc":"连接木叶与东部驿站的公开运输道路","tier":"wilderness"}}</variable>
<variable>{"path":"world_state.map.explored_regions","op":"push","value":"火之国东部"}</variable>
<variable>{"path":"progression.exp","op":"add","value":15}</variable>
<variable>{"path":"equipment.consumables","op":"remove","key":"烟雾弹"}</variable>
<mission>{"id":"M-护送药材","status":"progress","progress":{"current_step":2,"total_steps":3,"note":"队伍击退拦路者并通过第二处路障，继续护送药材前往东部驿站。"}}</mission>
<relationship>{"npc":"海野伊鲁卡","trust_change":1,"reason":"玩家在护送途中妥善保护了同行人员。","history":"海野伊鲁卡认可玩家处理路障时的克制与配合。","combatant":true,"combat_stats":{"rank":"中忍","chakra_nature":[],"jutsu":[{"name":"分身术"}]}}</relationship>
<combat state="victory">{"log":"玩家一行击退拦路者，护送队伍无人重伤。"}</combat>
<event>{"id":"EV-EAST-ROAD-BLOCK","status":"resolved","description":"东部驿道的临时路障已被清除，运输恢复通行。"}</event>
<memory>{"summary":"护送队伍击退东部驿道的拦路者并通过第二处路障；最后一枚烟雾弹已用完，接下来继续前往东部驿站。","facts":["东部驿道恢复通行","烟雾弹已经耗尽"],"clues":[],"pins":["继续护送药材前往东部驿站"],"remove_pins":[],"npc_notes":{"海野伊鲁卡":"认可玩家在路障冲突中的处置"}}</memory>
${dailyContract}`;

export const FEW_SHOT_EXAMPLES = Object.freeze([
  MAIN_SINGLE_CALL_NO_CHANGE_EXAMPLE,
  VARIABLE_UPDATER_MIXED_EXAMPLE
]);
