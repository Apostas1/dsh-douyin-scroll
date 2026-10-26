# -*- coding: utf-8 -*-
"""把 鲸鱼娘拆解.psd 每层导出成透明 PNG + 生成两张预览图（全合成 / 分层网格）。只读 PSD。"""
import sys, io, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from psd_tools import PSDImage
from PIL import Image, ImageDraw

PSD = r"D:\Downloads\宠物\鲸鱼娘拆解.psd"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "pet", "psd")
os.makedirs(OUT, exist_ok=True)

psd = PSDImage.open(PSD)
layers = list(psd)

# 1) 全合成预览
comp = psd.composite()
comp.save(os.path.join(OUT, "_preview-full.png"))
print("全合成 OK", comp.size)

# 2) 每层导出（画布坐标，透明底）
for l in layers:
    if l.bbox:
        img = l.topil()
        canvas = Image.new("RGBA", (psd.width, psd.height), (0, 0, 0, 0))
        canvas.paste(img, (l.bbox[0], l.bbox[1]))
        canvas.save(os.path.join(OUT, l.name + ".png"))
        print(f"层 {l.name}: {l.bbox[2]-l.bbox[0]}x{l.bbox[3]-l.bbox[1]} @{l.bbox[0]},{l.bbox[1]}")

# 3) 分层网格预览（每层缩到 200x200，带名字，4 列）
TH = 200
cols = 4
rows = (len(layers) + cols - 1) // cols
grid = Image.new("RGB", (cols * TH, rows * (TH + 18)), (36, 39, 46))
draw = ImageDraw.Draw(grid)
for i, l in enumerate(layers):
    if not l.bbox:
        continue
    img = l.topil().convert("RGBA")
    img.thumbnail((TH - 10, TH - 10))
    cell = Image.new("RGBA", (TH, TH), (58, 62, 72, 255))
    cx, cy = (TH - img.width) // 2, (TH - img.height) // 2
    cell.paste(img, (cx, cy), img)
    gx, gy = (i % cols) * TH, (i // cols) * (TH + 18)
    grid.paste(cell.convert("RGB"), (gx, gy + 18))
    draw.text((gx + 6, gy + 2), f"{i}. {l.name}", fill=(255, 255, 255))
grid.save(os.path.join(OUT, "_preview-layers.png"))
print("网格预览 OK", grid.size)
