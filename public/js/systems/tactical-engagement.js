import { projectNarrativeForMemory } from '../core/narrative-memory.js';

const escapePattern = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withoutQuotes = value => String(value).replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, '');
const UNCOMMITTED = /[?？]|吗|么|如何|怎么样|为何|为什么|可否|可以吗|要不要|应不应该|拒绝|不愿|不想|不打|不攻击|不再|不要|停止|避免|不会|没有(?:攻击|出手|动手)|尚未|还未|如果|假如|假设|要是|若是|一旦|等到|等他|等对方|待对方|计划|打算|准备|考虑|想要|想象|梦到|回忆|听说|据说|曾经|此前|昨日|昨天|明天|下次|以后|邀请|请求|询问|提议|能否|是否|愿意|答复|同不同意|攻击前|出手前/u;
const REMOTE_OR_PAST = /不在|未在场|未到场|未出现|缺席|还没来|没有来|离开|离场|离去|退场|走远|早已|远方|外地|来信|书信|信中|画像|雕像|档案|回忆|想起|记得|曾经|听说|据说|提起|提到|谈起|昨日|昨天|过去|明天|如果|假如|假设|计划/u;

function presentInStory(name, story, card) {
  if (card?.present === false || card?.in_scene === false || card?.is_present === false) return false;
  const sentences = withoutQuotes(story).split(/[。！!？?\n；;]/u).filter(sentence => sentence.includes(name));
  const latest = sentences.at(-1) || '';
  if (!latest || REMOTE_OR_PAST.test(latest)) return false;
  // A name in a relationship, recollection or suggested option isn't a scene actor.
  // Require visible positioning or an actual action in the latest factual mention.
  const escaped = escapePattern(name);
  return new RegExp(`${escaped}[^。！？\\n]{0,32}(?:在场|面前|对面|身旁|身边|眼前|站|坐|走|看|望|点头|摇头|抬|举|挥|转身|说|问|答|笑|迎|冲|袭|攻击|等待|正与|正在|已同意|同意了|答应|拔出|结印|摆出|踏入|来到)`, 'u').test(latest)
    || new RegExp(`(?:面前|对面|身旁|身边|眼前)[^。！？\\n]{0,12}${escaped}`, 'u').test(latest);
}

function explicitAttack(text, name, playerName) {
  const target = escapePattern(name);
  const subject = `(?:我|本人${playerName ? `|${escapePattern(playerName)}` : ''})?`;
  const beginning = `(?:^|[。！!\\n；;，,])\\s*${subject}\\s*(?:现在|立即|立刻|直接|主动|当即|随即|果断)?\\s*`;
  const directed = `(?:向|对|朝|冲着)\\s*${target}\\s*(?:发起|发动|展开|进行)?\\s*(?:攻击|袭击|进攻|出手)`;
  const directVerb = `(?:攻击|袭击|进攻)\\s*${target}`;
  return new RegExp(`${beginning}(?:${directed}|${directVerb})(?!前|的(?:想法|计划))`, 'u').test(text);
}

function agreedSparring(text, name, playerName, story) {
  const target = escapePattern(name);
  const subject = `(?:我|本人${playerName ? `|${escapePattern(playerName)}` : ''})?`;
  const starts = new RegExp(`(?:^|[。！!\\n；;，,])\\s*${subject}\\s*(?:现在|立即|立刻|正式)?\\s*(?:与|和|同)${target}(?:现在|正式|立即)?(?:开始|展开)(?:切磋|对练)`, 'u').test(text);
  if (!starts) return false;
  const evidence = withoutQuotes(story).split(/[。！!？?\n；;]/u).filter(sentence => sentence.includes(name)
    && !REMOTE_OR_PAST.test(sentence) && !/拒绝|不同意|不愿|没有同意|尚未同意|还未同意|没有答应|尚未答应|不接受/u.test(sentence));
  return evidence.some(sentence => /(?:双方|两人|你们).{0,8}(?:同意|达成一致)|(?:同意|答应|接受).{0,8}(?:切磋|对练|邀请)/u.test(sentence));
}

// Legacy compatibility only. The runtime pipeline now opens encounters from the
// owning model's structured combat instruction, never by matching player prose.
// Kept for older callers/tests; do not use it to auto-settle a new encounter.
export function detectTacticalEngagement(state, input, history = []) {
  if (state?._combat?.is_active) return null;
  const text = withoutQuotes(projectNarrativeForMemory(String(input || ''))).trim();
  if (!text || UNCOMMITTED.test(text)) return null;
  const lastStory = [...history].reverse().find(entry => entry?.role === 'assistant')?.content || '';
  const visibleStory = projectNarrativeForMemory(lastStory);
  const candidates = Object.entries(state?._relationships || {})
    .filter(([name, card]) => name && text.includes(name) && card?.combatant !== false && presentInStory(name, visibleStory, card))
    .map(([name]) => name);
  if (candidates.length !== 1) return null;
  const name = candidates[0];
  const playerName = state?.['玩家·姓名'] || state?.player?.name;
  const sparring = agreedSparring(text, name, playerName, visibleStory);
  if (!sparring && !explicitAttack(text, name, playerName)) return null;
  return {
    enemy_name: name,
    objective: sparring ? '切磋' : '击退对手',
    trigger: '玩家明确发起交战'
  };
}

const TACTICAL_ENCOUNTER_STORY_GUIDANCE = `【战术回合 · 仅玩家手动打开战斗面板后适用】
玩家已手动开启本回合战斗面板，因此启用以下战斗状态登记与战术规则。面板关闭时不应用本段，继续普通正文叙事与常规变量记账。
只有本回合最终正文中已经发生实际敌对交锋，或双方已经同意并真正开始切磋，才建立战斗状态。玩家仅说出“攻击”“切磋”等字样不会自动开战；邀请、拒绝、询问、引述、过去事件、假设、行动建议、未选项和未在场人物都不是已经交战的事实。
首次交锋写清真实在场对手、目的与现场，只推进到玩家需要作出第一步战术选择的位置。不要在玩家未声明的连续行动中直接写完整场胜负。没有发生交锋则正常叙事。
已有活动战斗时沿用当前对手与状态，不重复初始化。已有本地战斗结算时，按结算事实描写这一轮，保持玩家预设文风；数值、掷骰与技术解释由战报展示，不写入故事正文。生命归零表示失去继续作战能力，生死依情境处理，不自动宣布死亡。
面板随结构化战斗状态显示，模型更新的是角色与战场状态，不是界面开关。不要用变量写入 _combat 或 _ui，也不要创建“显示战斗面板”等平行布尔变量。`;

export const TACTICAL_ENCOUNTER_REGISTRATION_GUIDANCE = `【战斗状态登记 · 仅玩家手动打开面板后，由负责变量更新的模型执行】
依据本回合最终正文，首次实际交锋用一个 combat start 标签登记。标签放在正文结束后的结构化记账区，由界面隐藏；不要把标签、字段名或“已启动面板”的说明写进可见正文。
格式示例（只示范结构，不复制示例人物与场景）：
<combat state="start">{"enemy_name":"训练对手","enemy_rank":"下忍","objective":"切磋","distance":"中","environment":{"terrain":"训练场","weather":"晴"}}</combat>
enemy_name 必须指向本轮真实在场对手；忍阶、目标、距离和环境按已有事实填写，不明信息可省略。复用已有关系档案与战斗资料，不凭空创建招式或能力。已有活动战斗不重复输出 start；仅因提议或选项不能登记开战。
如果本回合已有本地战斗结算，不再输出重复的战斗资源、伤害、物品消耗或胜负标签。只记录其他已发生变化。`;

export function buildTacticalEncounterGuidance({ updaterOwned = false } = {}) {
  if (updaterOwned) {
    return `${TACTICAL_ENCOUNTER_STORY_GUIDANCE}\n\n【本回合职责】\n本回合战斗状态登记由后续独立变量模型或 Agent 连续性更新模型负责。正文主模型只需在最终故事中明确是否已经交锋、真实对手、目的与现场，保留第一步战术选择；不要输出任何 combat 或变量结构标签，也不要自行操作界面。后续变量模型根据最终正文输出结构化开战登记，不能根据未执行的玩家意图启动战斗。`;
  }
  return `${TACTICAL_ENCOUNTER_STORY_GUIDANCE}\n\n本回合没有独立变量模型，正文主模型在完成故事后同时承担战斗状态登记。\n${TACTICAL_ENCOUNTER_REGISTRATION_GUIDANCE}`;
}

// Existing imports retain the single-model contract. New runtime callers select
// the owner explicitly via buildTacticalEncounterGuidance.
export const TACTICAL_ENCOUNTER_GUIDANCE = buildTacticalEncounterGuidance();
