# -*- coding: utf-8 -*-
"""拼一张「桌宠预览」：所有状态并排（idle/watch/run/sleep/error），
同时验证 pet-build.py 产物能正确叠加。也当 selfcheck 的基准图。"""
import sys, io, os, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from PIL import Image, ImageDraw

ROOT = r"D:\aiagent\deepseek\dsh-douyin-scroll\assets\pet"
SP = os.path.join(ROOT, "sprite")
BIG = 320
layers = json.load(open(os.path.join(SP, "manifest.json"), encoding="utf-8"))["layers"]

def load(p):
    return Image.open(p).convert("RGBA")

def body():
    canvas = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    for name in layers:
        canvas = Image.alpha_composite(canvas, load(os.path.join(SP, "layers", name + ".png")))
    return canvas

# 状态 = 身体 + 道具（v1：道具只叠图，不动身体层）
STATES = [
    ("idle", None),
    ("watch", "phone.png"),
    ("run", None),
    ("sleep", "zzz.png"),
    ("error", None),
]
cell = 200
cols = len(STATES)
grid = Image.new("RGB", (cols * cell, cell + 30), (40, 43, 51))
d = ImageDraw.Draw(grid)
for i, (name, prop) in enumerate(STATES):
    img = body()
    if prop:
        img = Image.alpha_composite(img, load(os.path.join(SP, prop)))
    img = img.crop((60, 40, 300, 280)).resize((cell, cell), Image.LANCZOS)  # 只取角色区
    grid.paste(img.convert("RGB"), (i * cell, 30), img)
    d.text((i * cell + 6, 6), name, fill=(255, 255, 255))
out = os.path.join(SP, "_preview-states.png")
grid.save(out)
print("预览 OK →", out)
