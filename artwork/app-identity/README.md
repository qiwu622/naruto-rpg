# 忍者手记 App 原创标志

本次从零设计「卷轴墨焰」标志：象牙色卷轴形成流动的折返轮廓，朱红墨迹向上延伸。没有沿用项目旧书法标题、安卓机器人、木叶图案或其他已有徽记。

使用内置 imagegen 生成；没有上传旧标志或角色图作为参考。透明原图保存在 `naruto-mark-20260930.png`。用于界面的尺寸资源由 `scripts/android-icons.ps1` 派生，不修改原图内容。

- App 内透明标志：`img/app-mark.png`。
- 安卓桌面：各密度 `mipmap-*/ic_launcher.png`，含旧版圆形及 Android 自适应前景。
- 原生启动页：统一深墨背景和新标志。
- App 顶部与开局首页：使用同一标志；首页使用深色渐变，让标题和表单保持清晰。
- 网页端原有背景和标题资源仍保留在仓库中。

重新派生资源：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\android-icons.ps1
```

生成使用的完整提示词：

```text
Use case: logo-brand. Create one completely original production logo symbol from scratch for a Chinese ninja narrative game called 忍者手记. Do not reuse or imitate any existing franchise emblem, Hidden Leaf symbol, clan crest, corporate logo, Android robot, old calligraphy wordmark or existing image. No reference images. A refined compact ivory paper scroll folded into a bold flowing asymmetric loop, with a single vivid vermilion ink stroke rising out of the scroll like a sharp flame or a writer's decisive brush gesture. The scroll is a simple recognizable silhouette; the vermilion stroke becomes an unmistakable unique signature. A small warm-gold roll edge can add finish. Sophisticated, restrained, fresh premium game identity, flat graphic logo with beautiful controlled curves and crisp geometric edges, highly readable at tiny 48px launcher size. No distressed textures, no 3D render, no clutter, no shuriken or stars, no character, no lettering, no frame, no scenery, no watermark. One centered isolated emblem on genuinely transparent background. Square canvas, ample transparent breathing room around the whole emblem. Essential silhouette fits in the central 60 percent of the canvas for Android adaptive circular and squircle masks. Only this single usable logo artwork.
```
