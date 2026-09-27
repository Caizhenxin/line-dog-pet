# 打包说明（macOS arm64）

当前 `npm run pack`（electron-builder）可直接打包成功，产物：
`dist/LineDogPet-<version>-arm64.dmg`（含 `latest-mac.yml` + `blockmap`，支持自动更新）。

## 标准打包（electron-builder，一条命令）

```bash
npm run pack        # = electron-builder --mac（dmg, arm64；配置见 package.json build.mac）
```

产物位于 `dist/`：
- `LineDogPet-<version>-arm64.dmg` — 安装包
- `LineDogPet-<version>-arm64.dmg.blockmap` / `latest-mac.yml` — 自动更新元数据
- `mac-arm64/LineDogPet.app` — 未压缩的 .app（可直接运行）

未签名（package.json `build.mac.identity = null`），首次打开需在
「系统设置 → 隐私与安全性」中允许。

## 故障排查

- **electron-builder 下载 electron 超时**：GitHub releases 直连可能超时，先手动下载
  到缓存再打包：
  ```bash
  curl -L -o ~/Library/Caches/electron/electron-v33.4.11-darwin-arm64.zip \
    https://npmmirror.com/mirrors/electron/v33.4.11/electron-v33.4.11-darwin-arm64.zip
  unzip -t ~/Library/Caches/electron/electron-v33.4.11-darwin-arm64.zip   # 校验完整性
  npm run pack
  ```
- 若 electron-builder 仍异常（如 `rename Electron.app → 可执行名` ENOENT），
  可退回手动打包流程（下方备用）。

## 备用：手动打包流程

```bash
cd 线条小狗桌宠
rm -rf dist
# 1) 复制 Electron 壳 → 重命名可执行 → 打 app.asar → 拷 move-mouse/icon → 改 Info.plist → ad-hoc 签名
APP=dist/LineDogPet.app
cp -R node_modules/electron/dist/Electron.app "$APP"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/LineDogPet"
npx asar pack . "$APP/Contents/Resources/app.asar" src assets goose-render.js package.json
mkdir -p "$APP/Contents/Resources/tools" && cp tools/move-mouse "$APP/Contents/Resources/tools/"
cp build/icon.icns "$APP/Contents/Resources/icon.icns"
# 2) 改 Info.plist（CFBundleDisplayName=线条小狗桌宠 / CFBundleIdentifier=com.linedog.line-dog-pet /
#    CFBundleExecutable=LineDogPet / CFBundleIconFile=icon.icns）
# 3) codesign --force --deep --sign - 签名
# 4) dmg：
rm -rf /tmp/dmg_tmp && mkdir /tmp/dmg_tmp
cp -R "$APP" /tmp/dmg_tmp/ && ln -s /Applications /tmp/dmg_tmp/Applications
hdiutil create -volname "线条小狗桌宠" -srcfolder /tmp/dmg_tmp -ov -format UDZO dist/线条小狗桌宠_v1.0_mac.dmg
```

## 验证

- `.app` 直接运行 `dist/mac-arm64/LineDogPet.app/Contents/MacOS/LineDogPet`
- dmg 校验：`hdiutil verify dist/LineDogPet-<version>-arm64.dmg`
- 自检截图：`npm start -- --shot-dir=<目录>`（无录屏权限要求）

## 备注

- 项目在 arm64；如需 Intel 版，把 electron-builder `mac.target.arch` 改为 `x64`
  （或手动流程中替换 x64 Electron）。
- `GOOSE_DEBUG=1` 打印捣蛋行为日志；`GOOSE_FAST=1` 6 倍速调度（测试用）。
