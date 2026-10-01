# v3.5.3：安卓设置滚动、角色按需调用与更新公告

## 修复原因

手机布局把分类区固定在内容区上方，外层裁切溢出。在 360×281 CSS px 的键盘视口中，旧版内容区被压缩至 44 px，并落到操作栏后方；拖动分类区也不能滚动设置。现在手机端分类与内容共用 `.layout` 滚动区，标题和操作栏保留，页面切换、锚点定位和编辑器返回使用实际滚动容器。桌面布局保留左右结构，同时补齐旧 WebView 的 `vh` 回退。

角色调用逻辑原先无条件遍历 `_relationships`，忽略大纲 Agent 的实际选择。现在由大纲输出可选 `characterRequests`，按场景决定是否咨询人物、咨询谁和人数，名单可为空。关系表、历史提及、战斗字段和场景参与者都不再自动触发调用；新人物或职务称呼也可以选择。同一角色与别名合并，玩家不委派为 NPC。缺少可选名单时继续写正文，未增加拒绝条件或固定人数配额。

## 更新功能与公告

- Android 启动、返回前台和恢复联网时自动检测版本；快速前后台切换有五分钟检测间隔，同时发起的检测合并。
- “稍后提醒”对当前版本延后一天，不再因一次取消永久关闭提醒；新版本仍可提醒，个人中心手动检查随时可用。
- 检测失败、超时不阻断游戏，网络恢复时可重试；生成正文和切换存档期间不弹出自动更新对话框。
- 更新清单包含 `releaseNotes`、`announcement`、`publishedAt`，旧清单缺少这些字段仍兼容。弹窗按纯文本显示更新内容与公告，个人中心保留可见提醒。
- 网站下载区与 CHANGELOG 同步公告。旧安卓包的提示样式要升级到本版后才会更新；已安装的旧包继续使用其原有更新入口。

## 验证

- 角色选择回归覆盖 33 个关系档案、0/1/2/4 个自主选择、缺失或无效名单、新人物、别名去重和大纲回退。
- 移动触摸与响应式测试 12 项通过；设置交互、路由和自动更新公告共 22 项通过；更新服务回归 5 项通过；项目完整 `NODE_ENV=test npm test` 通过。
- 最终 APK：`reports/android/20261001-161103/naruto-rpg-3.5.3-debug.apk`，versionCode 30503。
- SHA-256：`7d0b974cb76f054721a0d6320495e864379df98b0485429179b8c44758052485`。
- Android 15 模拟器：9 组原生启动、AI 流式及系统文件回归通过；系统栏/刘海竖横屏 4 组与真实键盘 544→281→544 校验通过。
- 实际 WebView 设置触摸：玩家/创作者竖横屏四组，以及连接页键盘弹出后滑动通过。
- 同一 APK 实际读取公开更新接口，自动弹出更新内容与公告，“稍后提醒”后仍可手动检查。此机器的 WSL/代理路径对部分 TLS 握手异常，专用模拟器通过本地测试转发完成联网校验；应用未加入证书绕过或测试代理配置。

运行命令：

```bash
node scripts/agent-character-selection-regression.mjs
node scripts/android-update-regression.mjs
npx playwright test tests/ui/settings-touch-scroll.spec.mjs tests/ui/android-update.spec.mjs
NARUTO_ANDROID_ADB=/path/to/adb ANDROID_SERIAL=emulator-5554 \
  node scripts/android-settings-scroll-regression.mjs reports/android/20261001-161103
```

上述原生验证使用专用模拟器；没有把桌面模拟手机视口当作实体手机验证。
