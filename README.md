# 忍者手记

火影世界观下的 **AI 单人文字跑团**（PWA）。玩家创建忍者、推进剧情；系统用多智能体流水线写正文，用可调用项目工具的助手「灵希」查正史、改设置、推进回合。

模型不能直接改存档。它只能检索、提议，或在白名单内做可逆小改动。删除、开局、云存档、剧情推进必须先展示精确影响，再由真实点击批准。

**正式站：** https://www.qiwu.asia/  
**源码：** https://github.com/2024053347-a11y/naruto-rpg  
**版本：** v3.5.1<br>
**安卓 App：** 共用本项目页面和游戏逻辑；[开发进度与打包说明](docs/android-app.md)。
**规模：** 约 1700 名注册用户；正史 K001–K086（385 剧情日 / 786 场景 / 2894 原子事件）；741 条规范忍术

### v3.5.1 更新

存档库与 IF 线管理统一，支持旧档保留、导入导出和云端管理；修复世界书误注入与变量更新重试，新增 NovelAI 画师串。网站可[下载安卓测试版](https://www.qiwu.asia/app/android/naruto-rpg.apk)，App 使用原创图标并修复系统栏遮挡。联机入口暂时隐藏，已有房间存档保留。完整说明见 [更新日志](CHANGELOG.md)。

## 系统设计要点

这个仓库的核心不是聊天套皮，而是把大模型放进有边界的产品循环里。

| 问题 | 做法 | 代码 |
|------|------|------|
| 模型会编造正史和当前存档 | 写开局、世界书或剧情前，必须先完成本轮项目检索；当前分支事实优先于预训练知识 | `js/core/lingxi/research-gate.js` |
| 模型输出不等于系统写入 | 写工具只生成签名提案；真正执行走适配器，并重新验签、核对状态和 diff | `js/core/lingxi/action-proposal.js` |
| 聊天里的「同意」不能当授权 | 高风险操作只接受确认界面的可信点击；少量可逆修改可自动执行 | `js/core/lingxi/approval-broker.js`、`proposal-approval-policy.js` |
| 长对话会把密钥和私密状态送进模型 | API 密钥、NPC 私密状态和内部 Agent 记忆会从灵希上下文中剥离；会话按消息数和字符数截断 | `js/core/lingxi/lingxi-tools.js`、`lingxi-controller.js` |
| 单次生成难以同时保证文笔和状态正确 | 先规划场景节拍和详纲，终审通过后再一次写正文，最后独立做变量与连续性结算 | `js/core/agent-pipeline.js` |
| 长流程中途失败成本高 | 阶段缓存，失败后从断开的阶段续跑；工具结果有预算 | `js/core/agent-pipeline.js`、`tool-result-budget.js` |

灵希写路径：

```
用户请求
  → 独立有界对话（最近 14 条 / 2 万字）
  → 只读工具：正史、世界书、当前存档、任务、战斗、时间线
  → 若意图是创作：research-gate 检查本轮检索是否齐全
  → 写工具只产出提案（规范序列化 + 哈希 + TTL）
  → 风险分级：可逆小改自动执行 / 高风险展示 diff
  → 确认界面的真实点击后，适配器验签并写入
```

正文路径：

```
用户行动
  → 场景节拍 / 角色决定
  → 结构化详纲
  → 玩家主权、角色来源、连续性、可检索正史终审
  → Final Writer 一次定稿
  → 变量、记忆、连续性账本独立结算
```

## 特性

- **灵希 Agent** — 独立于主剧情的对话；可检索项目资料，并通过安全工具执行用户可用的操作
- **多智能体叙事** — GM 编排头脑风暴、场景节拍、角色决定、详纲与终审，通过后再一次写正文
- **RPG 系统** — 六维属性、装备、忍术、回合制战斗、任务、人际关系、世界状态
- **记忆与连续性** — 连续性账本、全局剧情记忆、NPC 独立视角、阶段摘要、原子回合提交、分支隔离
- **知识库** — 项目正史、世界书、规范忍术库，按角色与时代做证据投影
- **图片工作室** — OpenAI 兼容 / A1111 / ComfyUI，回合插图、人物肖像、版本图库、云同步
- **音乐播放** — 腾讯音乐目录，本站同源代理预检音频，不可播时换源，可拖动悬浮播放器
- **账号与存档** — Discord OAuth、JWT、云存档、PWA、手机/PC 适配

## 技术架构

```
js/
├── core/           # 核心引擎
│   ├── pipeline.js          # 证据链消息与变量提交管道
│   ├── agent-pipeline.js    # 多智能体叙事管道
│   ├── agent-runner.js      # Agent 调用执行器
│   ├── agent-tool-runtime.js
│   ├── ai-client.js         # AI API 客户端
│   ├── state-manager.js     # 状态管理 + IndexedDB
│   ├── turn-evidence.js     # 回合证据编译与受众投影
│   ├── continuity-ledger.js # 不可变连续性账本
│   ├── lingxi/              # 灵希工具、审批与项目操作适配器
│   └── image-studio/        # 多后端图片生成与资产管理
├── systems/        # 战斗 / 任务 / 关系 / 记忆 / 时间线 / 装备
├── data/           # 正史、世界书、忍术库、Agent 配置
├── ui/             # Web Components，无前端框架
└── utils/

server/             # Express：Discord OAuth、JWT、云存档、AI 代理、管理接口
```

根目录的 `js/`、`css/`、`img/` 和 `assets/` 是应用源码；`public/` 中的同名内容是服务端部署镜像，会在 `npm start`、`npm run dev` 和 `npm run build` 前由 `npm run sync-public` 自动生成。登录页、管理页和法律文档仍由 `public/` 单独维护。

## Agent 模式

可在设置中启用 Agent 高质量正文模式：

| 模式 | 流水线 | 适用场景 |
|------|--------|---------|
| 标准 | 场景节拍 → 审查 → 详细写作大纲 → 终审 → 正文定稿 → 连续性结算 | 日常探索、对话 |
| 完整 | 头脑风暴 → 场景节拍 → 多重审查 → 角色决定 → 详细写作大纲 → 可检索终审 → 正文定稿 → 连续性结算 | 重大剧情、战斗 |

不需要辅助调用时可选择严格单次调用模式。变量更新器、记忆压缩、正文复检和自动绘图均可独立开启，调用策略会在每回合开始时冻结，避免生成阶段与提交阶段职责漂移。

## 灵希助手

灵希拥有独立于主剧情的对话上下文，可新开对话并限制发送给模型的历史长度。桌面端宠物与对话框均可拖动，位置会保存；生成过程中不能重置会话，避免丢失正在执行的操作。

涉及剧情、开局或世界书时，灵希必须先检索相应正史、世界书和用户点名的存档分区。只读查询、页面导航和少量低风险可逆设置可以直接完成；剧情推进、删除、覆盖、云存档、开局初始化和外部图片生成等操作会先展示绑定当前状态的精确影响，并只接受确认界面的真实点击。API 密钥、NPC 私密状态和内部 Agent 记忆不会进入灵希上下文。

## 快速开始

1. 安装 Node.js 18+，克隆仓库并安装依赖。
2. 将 `.env.example` 复制为 `.env`。本地开发可保留 `AUTH_BYPASS=true`；生产环境应关闭旁路并配置 Discord OAuth 与随机 `JWT_SECRET`。
3. 启动 Node 服务，打开 `http://localhost:3000`。
4. 首次进入配置 AI API（支持 OpenAI 兼容接口），创建角色后开始冒险。

```bash
npm install
npm start
```

项目包含统一的回归测试与构建命令：

```bash
npm test
npm run build
```

`npm test` 会验证项目时间线、忍术数据库、AI 调用策略、证据链上下文、连续性、变量更新、开局、战斗、灵希工具与审批、音乐代理、图片资产、服务端安全、部署脚本和 `public/` 同步状态。灵希界面回归可单独运行 `npm run test:lingxi-ui`。

## 测试站与正式站部署

### Windows

发布入口为 `部署正式站.bat`，底层使用 `deploy.ps1`。服务器地址和 SSH 密钥只写入被忽略的 `deploy.local.psd1`，可从 `deploy.local.example.psd1` 创建。

```powershell
# 离线检查正式部署包，不连接服务器
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Mode production -DryRun

# 正式部署，必须显式确认
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Mode production -ConfirmProduction
```

### WSL / Linux

新的 `deploy-wsl.sh` 同时支持测试站和正式站，默认目标为测试站。先创建只保存在本机的配置：

```bash
cp deploy.local.example.env deploy.local.env
chmod 600 deploy.local.env
# 编辑 deploy.local.env，填写服务器与 WSL 内可读的 SSH 私钥路径
```

建议把私钥放在 WSL 的 `~/.ssh/` 中并执行 `chmod 600`，不要直接使用权限可能过宽的 `/mnt/c/...` 私钥。

```bash
# 测试站：https://www.qiwu.asia:8080/
bash deploy-wsl.sh staging

# 测试站离线打包检查，不连接服务器
bash deploy-wsl.sh staging --dry-run

# 正式站离线打包检查，不需要确认参数
bash deploy-wsl.sh production --dry-run

# 正式站实际发布，必须显式确认
bash deploy-wsl.sh production --confirm-production

# 已经执行过对应构建时，可以跳过重复构建
bash deploy-wsl.sh staging --skip-build
```

也可以不用配置文件，临时设置 `NARUTO_DEPLOY_SERVER` 和 `NARUTO_DEPLOY_SSH_KEY` 环境变量。测试站与正式站共用 `/opt/naruto-rpg` 后端，因此发布测试站也会更新并重启共享后端。旧的 `deploy-v3.sh` 继续保留为正式站兼容入口。

### 版本信息生成

```bash
# 输出到 stdout
node scripts/generate-version.mjs

# 写入文件
node scripts/generate-version.mjs --out public/version.json
```

### 部署流程

```
1. 按目标构建      → 测试站使用 build:deploy，正式站使用 build
2. 临时生成版本信息 → 不改写工作区中的 public/version.json
3. 组装并校验资源  → 排除 .env、数据库、云存档和其他运行数据
4. 远端操作:
   - 校验上传包 SHA-256
   - 正式站备份旧静态目录
   - 更新目标静态目录与共享后端
   - 重启服务并等待后端 ready
   - 核对构建号、TLS 页面及测试站登录重定向
```

部署器会排除 `.env`、云存档和运行数据库，校验部署包内容与 SHA-256，重试上传，更新静态站和共享后端，重启服务并验证线上缓存版本与当前发布版本。正式站发布前应先运行 `npm test`。

## 难度等级

| 等级 | 初始点数 | 经验倍率 | 敌人强度 |
|------|---------|---------|---------|
| 忍者学校 | 60 | 1.5× | 0.7× |
| 下忍 | 50 | 1.0× | 1.0× |
| 中忍 | 40 | 0.85× | 1.2× |
| 上忍 | 30 | 0.7× | 1.5× |
| 影 | 20 | 0.5× | 2.0× |

## 技术栈

- 前端：JavaScript ES Modules、Web Components、IndexedDB、Service Worker（PWA），无 React/Vue
- 后端：Node.js 18+、Express、Discord OAuth、JWT、JSON 文件仓储、云存档与图片资产
- Agent：OpenAI 兼容接口、工具调用 / 文本工具协议、结构化提案、风险分级审批、多阶段叙事管线
- 验证：Node 回归脚本 + Playwright（灵希界面）
- 部署：nginx、systemd、PowerShell / bash 发布脚本

## 支持项目

忍者手记由个人独立开发并持续维护。你可以通过 [爱发电支持忍者手记](https://www.ifdian.net/a/2608_1?utm_source=copylink&utm_medium=link)，赞助完全自愿，不影响任何游戏功能。

即使不进行赞助，也欢迎体验游戏、[提出建议或反馈问题](https://github.com/2024053347-a11y/naruto-rpg/issues)，共同帮助项目持续成长。

## License

MIT
