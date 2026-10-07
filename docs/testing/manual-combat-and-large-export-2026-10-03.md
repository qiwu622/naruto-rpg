# 手动战斗面板与大档导出验收

## 战斗面板

- 默认关闭。顶部「战斗」、设置里的「打开战斗面板」与面板内关闭按钮共用 `_ui.settings.tacticalCombat`。
- 关闭时不挂载面板，也不响应 AI 战斗事件弹出或提示；系统内置提示词不注入面板战斗标签、强制资源结算或大纲 combat 域要求。普通正文、资源变量、记忆和日报照常处理。
- 开启且尚未交锋时显示等待状态；实际交锋由负责变量更新的模型以既有 combat start 协议登记，前端读取 `_combat`，不新增平行布尔变量，也不由攻击关键字自动创建对手或结算第一招。
- 单次调用由正文模型输出隐藏记账区；独立变量和 Agent 模式由对应更新模型负责。用户自定义和导入预设不重写。
- 模式开关与动作在生成期间锁住；新挂载面板立即继承忙碌状态。关闭保留已有战况，读档后按偏好显示。
- 生命归零的内置提示词统一为失去作战能力，不因切磋归零强制死亡。

验证：`NODE_ENV=test npm test` 全量通过；后续两处提示词校正由 `tactical-prompt-mode-regression.mjs` 10 组覆盖。`tactical-combat-pipeline-regression.mjs` 10 组、组件浏览器 7 组、实际 AppShell 模拟模型 6 回合 / 4 组、手动开关浏览器 3 组均通过。新等待面板截图 `reports/tactical-combat/manual-open-waiting-mobile.png` 已目视检查。

## 存档库大档导出

根因：`LocalSaveLibrary.export` 调用 `readPackage`，先解压已有库文件，触发外部导入共用的 200 MiB 上限，再重编码。201 MiB 的原始 JSON 即便 gzip 后只有约 200 KiB 也失败；错误发生在安卓文件桥接之前。

修复：先验证当前条目的分区和账号归属，直接备份库中原 Blob；读取两个魔数字节判别 gzip / JSON，不重建全部 JSON。完整历史、分支、快照与包内校验信息逐字保留；库内改名用于下载文件名，包内仍保留快照生成时名称。导出不执行本次重新解压校验，存入与导入时的校验保持原样。

验证：

- `save-library-large-export-regression.mjs`：用流生成校验值正确的 201 MiB 原始 JSON，先复现旧路径的 200 MiB 错误，修复后调用实际库导出和安卓 JS 分块桥接，SHA-256 与原 Blob 一致；另验 JSON/gzip、名称、取消、缺失快照、错误账号/分区。3 组通过。
- `android-file-export-regression.mjs`：5 组通过，含等待文件保存完成、取消、写入失败与临时文件清理。
- `timeline-file-codec-regression.mjs`：10 组通过，外部导入的限额、损坏校验不变。
- `save-library-regression.mjs`：13 组真实浏览器回归通过，覆盖个人/联机分区、保留旧档、改名下载、取消和重载持久化。229 个 source/public 共享文件同步检查通过。
- 真机安装与系统文件选择器未实测。未构建或发布 APK，未部署网站或推送 GitHub。

范围：本次修复导出误用导入限额。库内 `readPackage` 及外部导入仍有 200 MiB 解压限制；不能把此次导出通过视为超大档跨设备导入或库内加载已通过。安卓原生实际输出文件的 256 MiB 限制保持不变，该数值针对压缩后文件。
