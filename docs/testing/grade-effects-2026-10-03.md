# 等级光效本地验收

先用内置 ImageGen 生成风格参考，再在真实组件中实现。主要改动为 `js/ui/panel.js`、`css/components/panel.css.js` 及对应 `public` 镜像；仅显示层，不改动品质、忍阶、战力、装备加成或存档数据。

- 装备：破烂/普通保持静态描边，精良柔绿微光，优秀冷蓝亮边，史诗金色呼吸与慢速流光，传说朱红光晕与更明显的边缘流光；装备槽位与背包卡片一致。
- 忍阶：忍校学生灰、下忍绿、中忍蓝、特别上忍淡紫、上忍紫色呼吸、精英上忍金、影级朱红；原始等级名称保留，未识别的自定义等级使用素净样式。
- 忍术与任务：E–S 级使用同一套等级徽记，NPC 档案与玩家面板同步。等级信息仍以文字显示。
- 动效只运行于装饰层的透明度和位置，不闪烁正文与数值；`prefers-reduced-motion` 停止动画，保留静态彩色边缘。装饰层不接收鼠标或触摸事件。

验证：

- `node scripts/panel-regression.mjs`：10 项通过。
- `npm run test:npc-progression`：8 项数据回归、4 组浏览器交互通过。
- `node reports/visual-review/grade-effects/capture.mjs`：真实 InfoPanel 和装备系统、合成存档；桌面 1440×1320、手机 390×900。验证装备/卸下仍有效、减少动态效果有效、手机无横向溢出；无浏览器异常与外部请求。

本地验收产物位于 `reports/visual-review/grade-effects/`：

- `reference.png`、`reference-prompt.txt`：内置工具生成的参考与实际提示词；不作为游戏素材加载。
- `desktop.png`、`mobile.png`、`mobile-grades.png`：实际代码渲染效果。桌面截图冻结在流光经过的一帧，移动端截图使用减少动态效果模式。
- `report.json`：检查结果；`panel-before.js`、`panel-before.css.js`：本轮修改前的局部快照。

仅本地更新，未发布网站、GitHub 或安卓安装包；移动端通过 Chromium 窄屏检查，未在安卓真机验证。
