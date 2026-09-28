#!/usr/bin/env python3
"""生成 Windows 端图标（从现有素材缩放而来，尺寸/命名与 macOS 侧对齐）。

用法: python tools/make-icons.py

产物:
  assets/tray-win.png      16x16    Windows 托盘图标（用彩色表情包图；
                                    macOS 的纯黑模板图在深色任务栏上等于隐形）
  assets/tray-win@2x.png   32x32    高 DPI 备用（Electron 按 @2x 命名自动挑）
  assets/icon.png         256x256   窗口图标（main.js 里 Windows 窗口的 icon）
  build/icon.ico          多尺寸    electron-builder 打 Windows 安装包用（exe 图标）

素材替换成正式图标后重跑本脚本即可，不用改代码。
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
BUILD = os.path.join(ROOT, 'build')


def square(path, size, margin=0.0):
    """载入图片 → 居中放进透明正方形画布（margin 为额外留白比例）→ 缩到 size。"""
    im = Image.open(path).convert('RGBA')
    side = int(round(max(im.size) * (1 + margin)))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
    return canvas.resize((size, size), Image.LANCZOS)


def save(im, path, **kw):
    im.save(path, **kw)
    print('  %-28s %s' % (os.path.relpath(path, ROOT).replace('\\', '/'),
                          str(im.size).replace(' ', '')))


def main():
    os.makedirs(BUILD, exist_ok=True)
    # 托盘：直接沿用表情包图的两种尺寸（源图本身就是方的，无需补边）
    save(square(os.path.join(ASSETS, 'tray-meme.png'), 16),
         os.path.join(ASSETS, 'tray-win.png'))
    save(square(os.path.join(ASSETS, 'tray-meme@2x.png'), 32),
         os.path.join(ASSETS, 'tray-win@2x.png'))
    # 应用 / 窗口图标：用小狗立绘，四周留 8% 透明边，避免贴边
    dog = os.path.join(ASSETS, 'front-dog.png')
    save(square(dog, 256, margin=0.08), os.path.join(ASSETS, 'icon.png'))
    ico = square(dog, 256, margin=0.08)
    ico.save(os.path.join(BUILD, 'icon.ico'), format='ICO',
             sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
    print('  %-28s 7 sizes (256…16)' % 'build/icon.ico')


if __name__ == '__main__':
    main()