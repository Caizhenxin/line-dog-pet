# 打包说明（macOS arm64）

electron-builder 在当前中文目录名（`/Users/sonos/Downloads/新/...`）下会触发
`rename Electron.app → 可执行名` 的 ENOENT bug，所以采用**手动打包**流程。

## 手动打包脚本（一条命令）

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

- `.app` 直接运行 `dist/LineDogPet.app/Contents/MacOS/LineDogPet`
- 自检截图：`npx electron . --shot-dir=<目录>`（无录屏权限要求）
- dmg 挂载检查：`hdiutil attach dist/线条小狗桌宠_v1.0_mac.dmg -nobrowse -readonly`

## 备注

- 项目在 arm64；如需 Intel 版，把 `node_modules/electron/dist` 换成 x64 的 Electron 再打包。
- `GOOSE_DEBUG=1` 打印捣蛋行为日志；`GOOSE_FAST=1` 6 倍速调度（测试用）。
