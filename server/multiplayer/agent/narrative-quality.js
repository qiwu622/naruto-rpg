import { resolvePresetMacros } from '../../../js/data/default-preset.js';

// Only unambiguous numeric lower bounds are enforced. Free-form style remains
// an author's instruction, not an invitation for an auditor to invent blockers.
export function narrativeLengthRequirements(requirements = {}, turnPurpose = 'player_actions') {
  const preset = requirements.writer_preset?.preset;
  if (!preset) return requirements;
  let minimum = null;
  for (const entry of resolvePresetMacros(preset.entries, { variableUpdaterEnabled: true })) {
    for (const sentence of entry.content.split(/[。！？\n]/u)) {
      if (/开场|开局/u.test(sentence) && turnPurpose !== 'opening_scene') continue;
      if (!/正文|篇幅|字数/u.test(sentence) || /建议|目标|示例|例如|不超过|至多|最多|上限/u.test(sentence)) continue;
      const range = sentence.match(/(?:正文|篇幅|字数)[^\d\n]{0,12}(\d{2,5})\s*(?:至|到|[-—–~～])\s*(\d{2,5})\s*(?:个)?(?:汉字|字)/u);
      const lower = sentence.match(/(?:至少|不少于|不低于|下限(?:为)?)\s*(\d{2,5})\s*(?:个)?(?:汉字|字)/u);
      if (range && Number(range[1]) <= Number(range[2])) minimum = Number(range[1]);
      else if (lower) minimum = Number(lower[1]);
    }
  }
  return minimum === null ? requirements : { ...requirements, minimum_characters: minimum };
}

/** Validate visible prose only; operational data stays outside the story. */
export function narrativeQualityFindings(deliveries, requirements = {}) {
  return deliveries.flatMap(delivery => {
    const text = delivery.segments.map(segment => segment.text).join('\n\n');
    const findings = [];
    const count = [...text.replace(/\s/gu, '')].length;
    if (requirements.minimum_characters > 0 && count < requirements.minimum_characters) {
      findings.push(`正文只有 ${count} 字，至少需要 ${requirements.minimum_characters} 字。依据已有事件展开场景、对话和感官细节，不要新增玩家决定或重复凑字。`);
    }
    if (/镜头(?:没有|并未)确认|没有替任何人(?:开口|行动|决定)|没有哪一处动静被写成|共同成立的世界时刻|(?:双方|玩家|两人).{0,12}(?:提交|输入).{0,8}行动(?:声明)?|服务器开场锚点|不代表角色(?:说话|行动)/u.test(text)) {
      findings.push('正文混入了系统规则或行动提交说明。删除防御性旁白，用故事中的声音、物件或 NPC 的话自然收束；不要向读者解释你没有替玩家做什么。');
    }
    if (/(?:玩家|你的)输入(?:不合理|不符合)|无法按照你的(?:输入|要求)|(?:系统|模型|AI)(?:审核拒绝|拒绝生成)|请(?:重新|修改后)(?:输入|提交)(?:你的)?行动/u.test(text)) {
      findings.push('不要把改稿意见写成面向玩家的拒绝或重输通知。依据裁决写出尝试受到的实际阻碍、NPC 的回应或合理结果，保留可继续的剧情，只输出故事。');
    }
    if (/^\s*\[行动\]/mu.test(text)) {
      findings.push('删除正文外的 [行动] 建议列表，只保留已经成立的故事正文，以 NPC 回应或待决情境自然结束；正文仍须满足适用的篇幅要求。');
    }
    return findings.map(message => ({ audience: delivery.audience, code: 'NARRATIVE_PROSE_QUALITY', message }));
  });
}
