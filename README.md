# 线条小狗桌宠（Line Dog Pet）

一个基于 Electron 的桌面宠物应用：两只线条小狗（小金毛、小白）常驻桌面，可互动、会捣蛋、有随机事件，支持双狗关系养成。

## 主要功能

- **双狗养成**：小金毛与小白，亲密度 / 饱腹度 / 兴致 / 疲劳 / 清洁度状态系统
- **互动操作**：摸摸头、喂食、玩耍、聊天、抱抱、安慰、一起跳舞 / 出去玩等
- **桌面捣蛋**：表情包弹窗、叼鼠标、追光标、汪汪叫、微型剧情演出（可调频率 / 可开关）
- **随机事件**：挖宝、打喷嚏、追蝴蝶、一起看窗外等 18 个事件
- **双狗关系**：好感 / 友谊 / 吃醋数值系统，含吵架与和好机制
- **空闲模式**：120 秒无操作进入安静（quiet）、600 秒进入免打扰（dnd），自动降频降概率
- **V2 影子系统**（`src/core/`）：状态结算、行为决策、随机事件、记忆、空闲检测、存档，作为附加层运行，不替换页面原有状态机
- **宠物控制台**：实时查看双狗状态并执行全部互动动作

## 运行方式

```bash
npm install        # 安装依赖（Electron）
npm start          # 开发模式启动
npm run pack       # 打包 macOS 应用（electron-builder）
```

macOS 打包流程见 [`docs/packaging.md`](docs/packaging.md)。

## 项目结构

```
line-dog-pet/
├── src/
│   ├── main.js              # Electron 主进程入口
│   ├── goose-main.js        # 捣蛋主进程模块（表情包/叼鼠标/追光标/剧情）
│   ├── core/                # V2 影子系统（config/state/behavior/relationship/event/memory/idle/save/scheduler）
│   ├── preload-*.js         # 各窗口 preload
│   └── renderer/            # 各窗口页面（index/console/footprint 等）
├── assets/                  # 运行资源（pet2 动画、memes 表情包、托盘图标）
├── tools/                   # 工具脚本（extract-pet2.py 动画提取、move-mouse 光标控制）
├── docs/                    # 文档（packaging.md）
├── goose-render.js          # 渲染端辅助脚本（随 index.html 加载）
├── package.json
└── README.md
```

## 自定义素材

- **表情包弹窗**：往 `assets/memes/` 添加 GIF/图片，重启后小狗会随机使用
- **小狗留言 / 剧情**：改 `src/goose-main.js` 中的 `MEME_NOTES` / `SKITS`
- **新增动画**：`python3 tools/extract-pet2.py <gif> <名字>` 生成逐帧 webp + 元数据
- **捣蛋频率 / 开关**：托盘右键菜单实时调整，持久化在 `~/Library/Application Support/line-dog-pet/goose.json`

## macOS 权限说明

- **辅助功能（必需）**：叼鼠标 / 追光标依赖系统级光标控制。首次运行无效时，请在
  **系统设置 → 隐私与安全性 → 设备控制和数据访问** 中给「线条小狗桌宠」（开发模式为 Electron）勾选权限，重启应用生效。
- **开机自启动（可选）**：托盘「开机自启动」需要相应权限，系统会弹窗询问。

## 当前开发状态

- 双狗养成、互动、捣蛋、事件、关系、控制台、存档：已实现并运行
- V2 影子系统：核心逻辑已实现，经单元测试（47 项）与端到端自检
- 未完成项（如实）：Windows 安装包未产出；空闲模式 CPU 收益未实测；双狗自动互动（friendship 联动）与记忆分类上限未实现

## 已知问题

- 事件频率上限（每小时 4 次 / 每天 20 次）与动态概率由主进程影子层控制，页面层无对应展示
- 亲密度采用页面 happiness 体系（可超 100），与规范 0–100 模型不一致（兼容层保留）
- 打包为手动流程（见 docs/packaging.md）

## 引用与版权声明

- 本项目仅学习交流使用，**禁止商用**；`package.json` 声明的 `Apache-2.0` 仅适用于本项目自行编写的代码
- 涉及第三方代码、动画与素材的出处、来源链接与使用限制，见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)（必读）
