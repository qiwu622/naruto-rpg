# 战斗面板视觉重设计

用户要求：重设计上一版战斗面板，允许原创生图作为参考。本轮仅本地开发，不发布网站、GitHub 或安卓安装包。

## 视觉方向

以原创月夜训练场为战况背景，叠加紧凑的敌我资源 HUD；下方使用象牙白纸感指令台，以朱红强调选择与提交。桌面招式与详情分栏，手机保持自然页面滚动。避免上一版低对比的深色嵌套卡片和重复提示。

背景文件：`img/combat/moonlit-training-ground.png`；发布镜像：`public/img/combat/moonlit-training-ground.png`。由内置 image_gen 工具原创生成，未复用现有游戏图片。

完整界面参考图：`reports/tactical-combat/redesign-reference.png`。参考图中的文案和数字仅用于视觉构图，应用界面始终读取真实战斗状态。

## 本地验收结果

- `tactical-combat-ui-regression.mjs`：7 组浏览器检查通过，覆盖实际背景加载、选招不扣费、快捷栏跨档隔离、生成及失败状态、320/360/390/768/1024px、340px 桌面聊天列、44px 控件、键盘焦点及减少动画。
- `tactical-combat-app-regression.mjs`：4 组通过；载入实际网站 CSS 和 AppShell 连续完成 6 个模拟模型回合，验证正文编辑、否定原选招、IndexedDB 存读，以及防御/观察/撤离三个按钮真实执行。
- 修复上述三个基础战术按钮文案被识别为自由战术的问题，保持用户修改与否定行动的语义识别。
- 原有面板回归 10 组通过，228 个 source/public 文件同步，差异检查通过。本轮未改战斗结算算法，未重复执行与视觉修改无关的全量测试。
- 已目视检查最终桌面和手机截图；实际组件截图为 `reports/tactical-combat/battle-desktop.png`、`battle-mobile.png`、`battle-narrow-column.png`、`battle-finished-mobile.png`。`battle-in-app-mobile.png` 记录真实网页样式下的嵌入位置。

## 生成提示词

### 实际使用的背景图

```text
Use case: stylized-concept
Asset type: original atmospheric illustration for the header of a Chinese ninja tactical RPG battle interface. This will be a production background and a visual direction reference.
Primary request: Create a beautifully composed, cinematic anime environment painting, a moonlit shinobi training ground in a misty cedar forest, at the blue hour after rain. Pure background landscape, NO PEOPLE, NO CHARACTERS, NO TEXT, NO LETTERS, NO UI ELEMENTS, NO LOGOS. Landscape ratio approximately 3:1 or the widest landscape supported.
Composition: sweeping low angle landscape, old dark timber practice posts at far left and far right edges, stone slabs and a shallow reflective stream crossing the bottom edge, distant mountain silhouettes in the far right, moon partly veiled in soft cloud upper right. Very subtle drifting maple leaves and glowing emberlike fireflies. Keep the center 65 percent calm, spacious and dark enough for overlay text. A tall cedar silhouette on the left provides framing, detailed foliage around edges rather than filling center.
Style: exquisite hand-painted Japanese animation background art, elegant fine brush work and atmospheric layers; understated woodblock-inspired texture and ink-wash haze, production-quality fantasy game art, natural forest rather than sci-fi. Deep indigo and muted petrol blue shadows with pale ivory moonlight, restrained warm vermilion autumn leaves. High visual clarity, refined elegant composition, strong foreground/midground/background depth, not photorealistic, not a cluttered splash screen, no neon, no generic purple gradient. Original composition, never copy an existing game image.
```

### 界面构图参考

```text
Use case: ui-mockup
Asset type: original high-fidelity reference concept for a Chinese ninja text RPG combat command panel, ONE complete desktop interface, not an illustration of a computer.
Primary request: Design a very polished, compact premium game UI with Japanese print/editorial influences, entirely original. Wide approximately 4:3 composition on an almost-black website background, large central panel filling frame. Upper 38%: cinematic, dark indigo moonlit misty forest background with subtle autumn red leaves and training posts, no characters. Oversized ivory Chinese brush-serif title "交锋" on the upper left, small label "TACTICAL ENCOUNTER", elegant right aligned "03 / 回合" indicator. In the foreground a very compact left/right opponent HUD with player name "望月" and enemy "雾中追兵", thin jade/terracotta HP bars, smaller chakra resources, small chips, centered delicate crossed-kunai insignia. Readable overlay text, dramatic art visible through unused space.
Lower 62%: a clean warm ivory paper command desk with crisp dark ink typography and vermilion accents. Desktop uses a left 60 percent and right 40 percent split. Left contains heading "选择招式", a small outlined "全部招式" button, a clear 2x2 grid of four substantial move buttons named "火遁·炎弹", "木叶旋风", "分身术", "替身术". Each button has a small original monoline technique glyph and tiny, clearly aligned power and cost; selected fire move uses a tasteful faint red fill and a strong red vertical rule. Below it a narrow row of "防御" "观察" "佯攻" "撤离". Right contains selected move details, a large muted red "火" glyph as a faint watermark, heading "火遁·炎弹", clean concise copy, 3 probability/cost metrics aligned in a row, then a bold solid vermilion action button "确认行动". A slim dark ink bottom strip shows "上回合战报" with a collapse arrow. Plenty of breathing space but compact rather than vertically long. Typography hierarchy, editorial spacing, sharp lines, 6-10px restrained corner radius, thin ruled dividers, professional art direction.
Avoid: gold-on-black generic dashboard, excessive nested rounded boxes, tiny gray text, unreadable text behind leaves, floating ornamental panels, full anime character portraits, neon sci-fi, clutter, device frame, browser chrome. Preserve exact Chinese labels where possible.
```
