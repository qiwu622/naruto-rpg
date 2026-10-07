// Visual tiers only: never change a saved character/item's actual rank.
const GRADE_TIERS = {
  quality: { '破烂': 0, '普通': 1, '精良': 2, '优秀': 3, '稀有': 3, '史诗': 5, '传说': 6 },
  ninja: { '忍校学生': 0, '忍校生': 0, '忍者学校学生': 0, '学生': 0, '下忍': 2, '中忍': 3,
    '特别上忍': 4, '特上': 4, '上忍': 4, '精英上忍': 5, '精英': 5,
    '影级': 6, '影': 6, '火影': 6, '风影': 6, '水影': 6, '土影': 6, '雷影': 6 },
  letter: { E: 1, D: 2, C: 3, B: 4, A: 5, S: 6 }
};
export function gradeAttributes(value, kind = 'letter') {
  const label = String(value || '').normalize('NFKC').trim();
  const key = kind === 'letter' ? label.toUpperCase().replace(/级$/, '') : label;
  const tier = Object.hasOwn(GRADE_TIERS[kind], key) ? GRADE_TIERS[kind][key] : 0;
  const variant = kind === 'ninja' && ['特别上忍', '特上'].includes(key) ? ' data-grade-variant="special"' : '';
  return `data-grade-tier="${tier}"${variant}`;
}

