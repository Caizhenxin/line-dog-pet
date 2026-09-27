#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_pet2.py —— 把一张线条小狗 GIF 提取成小白（pet2）皮肤用的动画资源。

用法:
    python3 tools/extract_pet2.py <GIF路径> [输出名] [--scene] [--pad-bottom N]

输出:
    assets/pet2/<输出名>/frame-000.webp ... frame-XXX.webp   (逐帧透明 webp)
    并把 clips.js 需要的元数据条目打印到 stdout，可手动粘贴进 assets/pet2/clips.js。

说明:
    - 每帧按非透明区自动裁边（box），画面统一用第一帧的盒子尺寸对齐（若帧大小不同）。
    - durs 取 GIF 每帧原时长（毫秒）；GIF 没带时长时默认 100ms。
    - --scene 标记场景动画（双狗同框、做饭、睡觉等整幅画面），此时不裁边。
    - fit 默认 1.0，padBottom 默认 9；需要视觉校正时手动改 clips.js 里的 fit 值。

依赖: Pillow (python3.12 -m pip install --break-system-packages Pillow)
"""
import os, sys, json

try:
    from PIL import Image, ImageSequence
except ImportError:
    sys.exit('需要 Pillow：python3.12 -m pip install --break-system-packages Pillow')

DEFAULT_PAD_BOTTOM = 9
DEFAULT_MS = 100


def trim_box(img):
    """非透明区包围盒 [x, y, w, h]；全透明返回 None"""
    bbox = img.getbbox()
    if bbox is None:
        return None
    x0, y0, x1, y1 = bbox
    return [x0, y0, x1 - x0, y1 - y0]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    gif_path = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(os.path.basename(gif_path))[0]
    scene = '--scene' in sys.argv
    pad_bottom = DEFAULT_PAD_BOTTOM
    if '--pad-bottom' in sys.argv:
        i = sys.argv.index('--pad-bottom')
        pad_bottom = int(sys.argv[i + 1])

    src = Image.open(gif_path)
    n_frames = getattr(src, 'n_frames', 1)
    if n_frames <= 1:
        sys.exit('不是动图（只有 1 帧）：' + gif_path)

    out_dir = os.path.join('assets', 'pet2', name)
    os.makedirs(out_dir, exist_ok=True)

    durs, boxes, webps = [], [], []
    canvas_w = canvas_h = 0
    for i, frame in enumerate(ImageSequence.Iterator(src)):
        # 转成全尺寸 RGBA，避免局部帧尺寸不一致
        f = frame.convert('RGBA')
        canvas_w = max(canvas_w, f.width)
        canvas_h = max(canvas_h, f.height)
        durs.append(frame.info.get('duration', DEFAULT_MS) or DEFAULT_MS)

    # 第二遍：按统一画布输出 + 算 box
    for i, frame in enumerate(ImageSequence.Iterator(src)):
        f = frame.convert('RGBA')
        if f.size != (canvas_w, canvas_h):
            nf = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
            nf.paste(f, (0, 0))
            f = nf
        if scene:
            box = [0, 0, canvas_w, canvas_h]
        else:
            box = trim_box(f)
            if box is None:
                box = [0, 0, canvas_w, canvas_h]
        # 画布整体下移 padBottom（和原版一致：脚仍落在脚底线）
        if pad_bottom:
            nf = Image.new('RGBA', (canvas_w, canvas_h + pad_bottom), (0, 0, 0, 0))
            nf.paste(f, (0, pad_bottom))
            f = nf
            canvas_h += pad_bottom
            box[1] += pad_bottom
        fp = os.path.join(out_dir, 'frame-%03d.webp' % i)
        f.save(fp, 'WEBP', lossless=True)
        webps.append(fp)
        boxes.append(box)

    meta = {
        'count': len(webps),
        'w': canvas_w,
        'h': canvas_h,
        'durs': durs,
        'src': os.path.basename(gif_path),
        'scene': scene,
        'boxes': boxes,
        'ref': 1.5,
        'fit': 1.0,
        'padBottom': pad_bottom,
    }
    print('\n生成帧：%d 张 → %s' % (len(webps), out_dir))
    print('clips.js 条目（粘贴到 PET2_CLIPS 里）:')
    print(json.dumps({name: meta}, ensure_ascii=False))


if __name__ == '__main__':
    main()
