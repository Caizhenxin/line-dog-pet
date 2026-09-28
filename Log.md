# 版本更新日志（Log.md）

> 维护规则：每次更新递增 0.1 版本号（v0.1 → v0.2 → …）；**新记录加在最上面**，历史记录完整保留；
> 每条记录含日期、责任人，并按「新增功能 / 功能完善 / 问题修复」分类描述。

---

## v0.1 · 2026-09-28

**责任人**：sonos / Trae AI（Windows 适配由 Trae AI 执行）
**主题**：Windows 平台适配（此前仅支持 macOS，`package.json` 只配了 `--mac` 打包）

### 新增功能

- **Windows 光标控制工具**：`tools/move-mouse.c` + 编译产物 `tools/move-mouse.exe`
  （Win32 `SetCursorPos`），命令行接口与 macOS 版 `tools/move-mouse.swift` 完全一致
  （`<x> <y>` / `--delta <dx> <dy>`），**无需任何系统授权**（macOS 侧需要「辅助功能」权限）。
- **Windows 图标生成脚本**：`tools/make-icons.py` —— 从现有素材产出
  `assets/tray-win.png`（16）+ `assets/tray-win@2x.png`（32）、`assets/icon.png`（256）、
  `build/icon.ico`（多尺寸 256…16），替换正式素材后重跑即可。
- **Windows 打包脚本**：`npm run pack:win`（electron-builder --win → nsis 安装包）。

### 功能完善

- `src/goose-main.js`：光标工具按平台选择二进制（`move-mouse` / `move-mouse.exe`），
  开发模式与打包后（`resources/tools/`）两条路径都覆盖；叼鼠标 / 追光标在 Windows 可用。
- **DIP → 物理像素换算**：Windows 上 Electron 给的是逻辑像素（DIP），而 `SetCursorPos`
  要物理像素，新增 `screen.dipToScreenPoint()` 换算；显示器缩放 ≠100% 时光标不再落偏
  （本机 150% 缩放实测修正）。
- `src/main.js`：控制台窗口图标路径修正（原为不存在的 `src/assets/icon.png` → `assets/icon.png`）。
- `package.json`：`build.win.icon` 由不存在的 `build/icon.icns` 改为真实的 `build/icon.ico`；
  `extraResources` 补入 `tools/move-mouse.exe`。
- 托盘图标：Windows 侧提供彩色图标 + 高 DPI（`@2x`）版本，兼容此前对 `tray-win.png` 的引用。
- 文档：README 补充 Windows 运行 / 权限 / 打包说明与双平台状态；
  `docs/packaging.md` 新增「Windows 打包」与自检踩坑记录。

### 问题修复

- **Windows 上叼鼠标 / 追光标无效果**：原逻辑固定调用 macOS 二进制，Windows 下
  `execFile` 必然失败且仅调试模式可见（静默失效）。现按平台选择并补充坐标换算。
- **Windows 托盘图标空白 / 窗口无图标**：补上代码引用但仓库缺失的图标资源。

### 验证

- 端到端自检（`electron . --shot-dir=<目录>`）在 Windows 上 30 秒跑通：产出 6 张截图 +
  9 组 `SELFTEST_*` 数据，漫游速度比 1.12、坠落 / 拖拽 / 饥饿 / 双狗互动 / 缩放适配全部通过。
- 光标工具单独实测：绝对移动、相对移动、参数校验（缺参返回 2）逐项精确。
- 应用连续运行 8 分钟无异常日志，6 次「叼鼠标」全部正常触发与释放。