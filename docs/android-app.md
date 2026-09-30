# 安卓 App 开发与打包

安卓端使用 Capacitor 7 包装本项目，页面和游戏逻辑继续维护在原来的 `js/`、`css/`、`assets/` 中。不是另一份游戏实现。

`npm run android:sync` 先构建项目已有的 Agent SDK，再将共用源文件同步到 `public/`，最后复制到安卓 assets。没有配置远程 `server.url`，APK 内置当前项目页面，可以离线打开界面和读取本机存档；调用 AI 仍需要网络和玩家自己的接口配置。

## 当前实现

| 部分 | 实现位置与行为 |
| --- | --- |
| 角色创建、开局、正文、变量、世界书、存档库、IF 线 | 共用原项目页面、预设、解析器、状态及时间线逻辑 |
| 本地模式 | `runtime-platform.js` 识别安卓。延续现有本地单机模式，登录、云端管理和联机服务尚未接入 App |
| 正文和灵希流式请求 | `native-ai-fetch.js` 将原生 HTTP 字节分片转换为标准 `Response` / `ReadableStream`，已有 AIClient 和 Agent SDK 继续解析 SSE、处理错误及停止生成 |
| 原生网络实现 | `NarutoHttpPlugin.java` 边读边发送；停止请求会断开连接。保留 HTTP 状态与错误正文，处理 gzip；接口发生跨域重定向时不会转发凭证 |
| 个人存档和时间线导出 | `file-export.js` 是网页、安卓的共用入口。安卓分片写入私有暂存文件，再打开系统文件保存窗口；写完所选文档才报告成功，取消和写入失败分别反馈 |
| 存档导入 | 共用原来的 JSON / gzip 解码及格式校验，通过 WebView 的系统文件选择功能读取文件 |
| 更新入口 | 共用 `app-update.js` 检查版本；下载 APK 时调用外部浏览器，避免用 WebView 替换游戏页面 |
| 手机排版 | 共用 `layout.css`，顶部功能可横向滑动，底部状态信息在栏内滑动，不撑宽整页 |
| 系统栏与键盘 | `MainActivity.java` 按实际系统栏、刘海与键盘 Insets 调整整个 WebView 的四边；网页继续共用原有布局，不重复添加原生边距 |
| App 标志 | 原创卷轴墨焰标志；桌面、启动页、顶部和开局主页统一。透明原图及提示词位于 `artwork/app-identity/` |

系统文件保存使用 Android 的 `ACTION_CREATE_DOCUMENT`，由玩家选择位置，没有新增整个存储空间的读取权限。暂存分片 256 KiB，单次存档上限 256 MiB。取消或写入失败的导出会清理暂存，已有个人档仍保留。系统自动备份已关闭；卸载 App 或清除应用数据会删除本机档，导出文件可单独备份。

Capacitor 的默认原生 POST fetch 会先收完响应，才生成一个完整的 `Response`。因此只启用 `CapacitorHttp` 不能保证 AI 正文逐段显示。App 的两个 AI 入口现在共用专门的流式传输适配，图片、音乐等其他请求仍沿用各自的现有实现。请求协议和游戏逻辑没有搬进 Java。

## Windows 一键构建

本机已验证的工具配置：

- Java 21：便携 Temurin，当前位于 `D:\Downloads\naruto-android-tools\jdk-21.0.12.1+1`。
- Gradle 8.11.1：当前位于 `D:\Downloads\naruto-android-tools\gradle-8.11.1`。
- Android SDK：安装 Android 35 平台、Build Tools 和 Platform Tools。
- 仓库依赖：先运行 `npm ci`；WSL 仓库中的 npm 同步工作由 WSL 执行，原生 Gradle 构建由 Windows 执行。

双击根目录的 **安卓测试版打包.bat**，或在 PowerShell 运行：

```powershell
.\build-android.ps1
```

工具目录或 SDK 不同时，可指定：

```powershell
.\build-android.ps1 -JavaHome 'D:\tools\jdk-21' -SdkRoot 'D:\tools\android-sdk' -ToolsRoot 'D:\tools\naruto-android'
```

也支持 `NARUTO_ANDROID_JAVA_HOME`、`ANDROID_SDK_ROOT`、`NARUTO_ANDROID_TOOLS`。工具目录需使用 ASCII 路径，脚本将 WSL / 中文仓库复制到独立构建目录，SDK 路径中的中文转换为 Java Properties 转义。不会更改全局 Java 设置。

脚本执行安卓回归、同步网页资源、编译 debug APK、Java 单元测试及设备测试包；随后检查签名、包名、共用文件哈希，以及服务端、环境文件和私钥未被打包。输出位于 `reports/android/<构建时间>/`：

- `naruto-rpg-3.5.0-debug.apk`：可安装的开发测试包。
- `native-tests.apk`：安卓仪器测试包，不是给玩家安装的游戏。
- `verification.json`：APK SHA-256、共用文件逐个哈希及构建验证记录。
- `native-unit-tests/`、`signature.txt`、`manifest.txt`：原生测试、签名和包信息。

构建失败会保留临时目录供诊断；成功后只清理这次创建的独立构建目录，旧 APK 和历史报告保留。Gradle Wrapper 固定使用 8.11.1 bin 包及官方 SHA-256。

## 回归与设备验证

```bash
npm run test:android-app
npm run test:save-library
node scripts/timeline-file-codec-regression.mjs
NODE_ENV=test node scripts/ai-stream-regression.mjs
```

`test:android-app` 包括本地模式和更新约束、原生导出分片/取消/失败，以及流式传输、中文边界、停止请求和网页原有 fetch 的兼容检查。

设备测试需要专用安卓模拟器，先安装同一次构建的游戏 APK 和 `native-tests.apk`，再运行：

```bash
NARUTO_ANDROID_ADB=/path/to/platform-tools/adb \
ANDROID_SERIAL=emulator-5554 \
node scripts/android-device-regression.mjs reports/android/<构建时间>
```

该脚本拒绝对实体手机执行自动创建文件的测试。它检查实际原生包启动、共用界面、移动端存档库、AIClient 和打包后 Agent SDK 的流式响应、HTTP/gzip 错误、停止请求，以及系统文件保存/取消和通过文件选择器重新读取中文 JSON。AI 响应由本机测试服务提供，不使用玩家密钥，也不计费。使用 Playwright 的 CDP `noDefaults` 模式连接实际 Android WebView，不会用桌面 Chromium 冒充安卓运行结果。

构建记录中的 `deviceTestsRun: false` 只代表打包脚本没有自动调用设备；设备执行记录另存在 `device-verification.json` 与 `instrumentation.txt`。不能将成功编译当作已通过实体手机测试。

### 2026-09-30 验证记录

下列 3.5.0 是早期测试构建；网站当前提供的版本请看后面的 3.5.1 发布记录。

- 最终测试构建：`reports/android/20260930-164035/`，3.5.0 / 30500，debug 签名，约 25.27 MiB。
- APK SHA-256：`ee613af1245f5b20c7e6be10e8542ef3577551ce45fa0993dad17828a7869cfb`。
- 安装后的 APK 与该哈希一致；212 个共用源文件与 APK 内的文件逐个一致，签名及包名检查通过。
- Java 文件分片、顺序和 JSON 数字类型校验：3 项通过。安卓运行环境仪器测试：1 项通过。
- Android 15 / API 35 专用模拟器：9 组检查全部通过，实际 WebView 视口 360 × 640。
- 本机 SSE 测试中，第一段中文约 751 ms 到达，约 1872 ms 完成；正文 AIClient 与打包后的灵希 SDK 都逐段收到中文。取消时读流报 AbortError，服务端确认连接已经关闭。
- 系统保存窗口写入约 720 KiB 的中文 JSON，读回字节完全一致；取消保存和通过系统文件选择器重新读取均通过。
- Android JS 13 组检查、网页 AI 流式 35 项、Agent 工具运行 23 项、完整 AI 适配 10 组及本地接口 5 项检查通过；存档库与 IF 线的浏览器回归也通过。
- Windows 交付副本位于 `D:\Downloads\忍者手记安卓测试版\20260930-164035\`，与模拟器测试的 APK 哈希一致。

本次原生导出验证发现 Capacitor 的 `getLong()` 不接收 JSON 解析得到的普通 Integer，导致文件长度被误判为缺失。现在按有界整数读取 Number，并检查负数、小数、无穷值与超限值；上述设备保存检查已覆盖实际桥接行为。

### 3.5.1 系统栏修复与网站发布

2026-09-30 发布构建位于 `reports/android/20260930-184040/`，versionName `3.5.1`，versionCode `30501`，debug 签名。APK 共 27,183,149 字节（25.92 MiB），SHA-256：

```text
b39fee5a1b9a8feafe69007201dc00fa475e68d2cd3007f05236bd857ffd6008
```

旧 APK 的真实运行检查复现了 `Top controls overlap status bar or cutout`。Capacitor 7 默认关闭系统栏边距适配，原来的 App 没有其他 Insets 处理。现在由原生 Activity 统一处理系统栏、屏幕缺口和输入法，适配实际边距而非写死状态栏高度；状态栏与导航栏采用深色底、浅色图标。检测覆盖正常竖横屏和模拟高刘海竖横屏，四种情况下 WebView 均位于安全区域内。

同一个最终 APK 的 Android 15 模拟器回归 9 组通过，包括 AI 流式、停止连接、系统文件保存/取消及导入；另完成上述 4 种屏幕配置与真实输入框键盘弹出/收起检查。原生键盘检查中页面视口由 544 缩到 281 CSS px，并恢复到 544。新标志、按钮栏不与标题重叠、移动端存档库均在实际 WebView 中检查；213 个共用源文件与 APK 内的哈希一致。

可复验：

```bash
NARUTO_ANDROID_ADB=/path/to/adb ANDROID_SERIAL=emulator-5554 \
node scripts/android-safe-area-regression.mjs reports/android/20260930-184040

node scripts/android-site-download-regression.mjs reports/android/20260930-184040
```

网站继续使用原下载接口：

- [APK 下载](https://www.qiwu.asia/app/android/naruto-rpg.apk)
- [版本清单](https://www.qiwu.asia/app/android/update.json)
- 正式站和 `:8080` 测试站的登录页均增加「下载安卓测试版」，无需登录。

浏览器实际点击按钮下载了完整 APK，下载文件与上述测试包 SHA-256 一致。匿名请求返回 HTTP 200、正确 APK MIME 和附件下载头；断点请求返回 206。版本清单的版本号、大小和哈希与安装包一致。手机 360×640、桌面 1280×800 及测试站登录页的按钮可见，无横向溢出。详见同目录 `site-verification.json`、`device-verification.json` 和 `safe-area-verification.json`。

APK 独立存放在 `/var/www/naruto-rpg-downloads/releases/<versionCode>-<sha前缀>/`，`android` 符号链接原子切换到当前版本。Nginx 的精确下载路由通过共享 `naruto-rpg-android-download.conf` 提供，缺失时不会回落到登录 HTML。网页全量部署不管理此目录，今后不会把已发布的 APK 覆盖掉。Windows、WSL 部署包均已包含该路由配置，部署回归通过。

发布工具为 `deploy/publish-android.py`。上传目录必须包含 `naruto-rpg.apk`、`update.json`、`verification.json`、`device-verification.json`、`safe-area-verification.json`、`login.html`、`naruto-rpg-android-download.conf`。工具检查测试包哈希和版本一致，再备份登录页及路由配置、检查 Nginx 并发布；若网站读回不一致则回滚。Nginx 重载后会短暂检查工作进程切换，避免误将切换前的登录响应当成 APK。

本次成功发布的回滚备份：`/var/backups/naruto-rpg/android-20260930-185436-1503163/`。仅修改下载配置和两站登录页，没有重启共享游戏后端，正式站主页面哈希保持原值。Windows 交付副本及原创标志位于 `D:\Downloads\忍者手记安卓测试版\20260930-184040\`。

## 发布前剩余工作

1. 实体手机上的键盘、后台切换、不同 WebView 版本和厂商文件选择器验证；本次使用 Android 15 模拟器。
2. 正式签名和持续发布的版本号策略。当前为 debug 签名测试包，不应直接替换正式渠道包。
3. 实际模型、图片和音乐服务的长时间设备测试。
4. 当前网站已提供 3.5.1 测试 APK，并与更新接口联动；正式签名渠道的安装、升级和长期版本管理仍需验证。
5. 如果需要在 App 接入账号、云存档或联机，继续共用项目服务和页面，增加明确的账号及同步适配，不能另建一套存档或房间状态逻辑。
6. 世界书、主预设、变量预设及图片等仍使用网页下载链接的导出按钮，需要继续接入共用系统保存入口；本次已完成的是个人存档和时间线导出。

参考：[Capacitor Android 插件](https://capacitorjs.com/docs/v7/plugins/android)、[Capacitor HTTP](https://capacitorjs.com/docs/v7/apis/http)、[Android 系统文件保存](https://developer.android.com/training/data-storage/shared/documents-files)、[Playwright Android](https://playwright.dev/docs/api/class-androiddevice)。
