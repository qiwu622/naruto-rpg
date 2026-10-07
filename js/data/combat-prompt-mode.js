// Apply only to repository-owned canonical prompt text before macro expansion.
// User-written or imported entries must never pass through this projection.
export function projectSystemCombatPrompt(content, { tacticalCombat = false, entryId = '' } = {}) {
  const source = String(content || '');
  if (tacticalCombat === true) {
    return source
      .replace(/归零必须有死亡结果/gu, '归零表示失去继续作战能力，生死依据剧情处理，不自动宣布死亡')
      .replace(/当前值归零即死亡/gu, '当前值归零表示失去继续作战能力，生死依据剧情处理，不自动宣布死亡');
  }
  if (entryId === 'main_builtin_combat') {
    return '战斗按当前人物能力、情报、环境与玩家实际行动自然叙述。只记录正文已经发生的伤势、治疗与资源变化，使用普通属性变量和人物关系增量记账；不创建面板回合、行动顺序或胜负标签。当前值不超过上限，不能无依据恢复或扣减。';
  }
  return source
    .replace(/【战斗(?:资源)?唯一结算】[\s\S]*?(?=\n【|$)/gu, '')
    .split('\n')
    .filter(line => !/^\s*<combat\b/u.test(line)
      && !/^\s*-?\s*(?:开战|玩家行动|NPC行动|战斗结束|结束)\s*[：→].*<combat\b/u.test(line)
      && !/同一施术.*(?:本地战斗系统|<combat>)|(?:战斗招式|战斗行动).*只通过\s*<combat>|<combat>\s*报告准确|战斗\s*→\s*使用\s*<combat>/u.test(line))
    .map(line => line
      .replace(/- 除 <combat state="\.\.\."> 外，所有开始标签都不得带属性。/u, '- 所有开始标签都不得带属性。')
      .replace(/任务、人物关系、战斗、事件分别使用 <mission>、<relationship>、<combat>、<event>/gu, '任务、人物关系、事件分别使用 <mission>、<relationship>、<event>')
      .replace(/任务、人物关系和战斗分别使用 <mission>、<relationship>、<combat>/gu, '任务和人物关系分别使用 <mission>、<relationship>')
      .replace(/<mission>、<relationship>、<combat>、<event> 分别归 missions、relationships、combat、events/gu, '<mission>、<relationship>、<event> 分别归 missions、relationships、events')
      .replace(/"combat":"updated"/gu, '"combat":"unchanged"')
      .replace(/、<combat>/gu, '')
      .replace(/【关系\/记忆\/任务\/战斗】/gu, '【关系/记忆/任务】')
      .replace(/仅限：variable\/combat\/relationship\/memory\/mission\/event/gu, '仅限：variable/relationship/memory/mission/event')
      .replace(/必须与 beat 内容匹配（有战斗才标 combat，有对话才标 relationship）/gu, '必须与 beat 内容匹配（有对话才标 relationship，实际资源变化标 variable）')
      .replace(/- 战斗场景只给出距离、地形、威胁和轮到谁响应，不预写招式交换/u, '- 战斗场景按当前事实与玩家本轮实际行动组织冲突与结果，不代写玩家下一轮行动'))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const ORDINARY_RESOURCE_UPDATE_GUIDANCE = `【普通叙事记账】
玩家没有打开战斗面板。本回合正常续写剧情，不登记面板战斗标签或强制回合数值。正文已经发生的查克拉、精神力、体力消耗与伤害、治疗仍须记账：玩家使用普通变量 attributes.chakra_current、attributes.spirit_current、attributes.stamina_current、attributes.vitality_current；人物已知资源变化使用 relationship 增量。只记录实际变化一次，不因没有面板而漏记资源、物品、任务、记忆或日报。`;
