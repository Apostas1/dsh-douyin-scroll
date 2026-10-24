# -*- coding: utf-8 -*-
"""桌宠素材构建：assets/pet/psd/ 的 15 层（1024 画布，psd-export.py 导出的）
→ assets/pet/sprite/（320 画布的渲染包 + 道具层 + manifest.json）。

层 = 照 PSD 渲染顺序原样缩放；道具（phone/zzz）用 PIL 现画。
构建是幂等的：改了道具画法重跑即可。
"""
import sys, io, os, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = r"D:\aiagent\deepseek\dsh-douyin-scroll\assets\pet"
SRC, OUT = os.path.join(ROOT, "psd"), os.path.join(ROOT, "sprite")
BIG, SMALL = 1024, 320

# PSD 里的渲染顺序（下→上），跟 psd-dump 的输出一致
LAYER_ORDER = [
    "back hair", "tail", "legwear", "footwear", "neck", "topwear",
    "handwear", "headwear", "face", "eyebrow", "eyewhite", "irides",
    "eyelash", "mouth", "front hair",
]

os.makedirs(os.path.join(OUT, "layers"), exist_ok=True)

# ── 1) 身体层：原样缩到 320 ──────────────────────────────
for name in LAYER_ORDER:
    p = os.path.join(SRC, name + ".png")
    if not os.path.exists(p):
        raise SystemExit(f"缺层：{p}（先跑 psd-export.py）")
    Image.open(p).convert("RGBA").resize((SMALL, SMALL), Image.LANCZOS) \
        .save(os.path.join(OUT, "layers", name + ".png"))
print(f"身体层 {len(LAYER_ORDER)} 张 → {SMALL}px")

# ── 2) 道具：手机（捧着看，屏幕亮蓝+小爱心+外发光） ──────
def new_canvas():
    return Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))

def heart(d, cx, cy, s, fill):
    d.ellipse([cx - s, cy - s * 0.9, cx, cy + s * 0.1], fill=fill)
    d.ellipse([cx, cy - s * 0.9, cx + s, cy + s * 0.1], fill=fill)
    d.polygon([(cx - s, cy - s * 0.1), (cx + s, cy - s * 0.1), (cx, cy + s)], fill=fill)

phone = new_canvas()
px, py, pw, ph = 440, 530, 145, 245  # 画布中央偏下（她手张开的正前方）
# 屏幕外发光（先画，垫在机身下面）
glow = new_canvas()
gd = ImageDraw.Draw(glow)
gd.rounded_rectangle([px + 8, py + 10, px + pw - 8, py + ph - 10], radius=18, fill=(53, 195, 242, 130))
glow = glow.filter(ImageFilter.GaussianBlur(20))
phone = Image.alpha_composite(glow, phone)
# 机身 + 屏幕 + 摄像头 + 屏上爱心
d = ImageDraw.Draw(phone)
d.rounded_rectangle([px, py, px + pw, py + ph], radius=24, fill=(28, 30, 38, 255), outline=(72, 76, 92, 255), width=4)
d.rounded_rectangle([px + 10, py + 14, px + pw - 10, py + ph - 14], radius=16, fill=(53, 195, 242, 235))
d.ellipse([px + pw / 2 - 4, py + 4, px + pw / 2 + 4, py + 11], fill=(72, 76, 92, 255))
heart(d, px + pw / 2, py + ph / 2 - 6, 26, (255, 120, 160, 235))
heart(d, px + pw / 2 + 30, py + ph / 2 - 34, 12, (255, 170, 200, 180))
# 微微倾斜，像捧在手里看
phone = phone.rotate(8, center=(px + pw / 2, py + ph / 2), resample=Image.BICUBIC)
phone.resize((SMALL, SMALL), Image.LANCZOS).save(os.path.join(OUT, "phone.png"))
print("道具 phone OK")

# ── 3) 道具：Zzz（睡觉标记，头右上角三颗渐大） ────────────
zzz = new_canvas()
d = ImageDraw.Draw(zzz)
try:
    f = lambda s: ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", s)
except Exception:
    f = lambda s: ImageFont.load_default()
for (x, y, s, a) in [(640, 400, 44, 160), (710, 300, 66, 200), (795, 175, 92, 235)]:
    d.text((x, y), "Z", font=f(s), fill=(255, 255, 255, a), stroke_width=7, stroke_fill=(38, 42, 56, 220))
zzz.resize((SMALL, SMALL), Image.LANCZOS).save(os.path.join(OUT, "zzz.png"))
print("道具 zzz OK")

# ── 4) manifest ──────────────────────────────────────────
manifest = {
    "canvas": SMALL,
    "layers": LAYER_ORDER,
    "props": ["phone", "zzz"],
    "built_from": "鲸鱼娘拆解.psd（主人 2026-10-24 用豆包生成并拆层）",
}
with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fp:
    json.dump(manifest, fp, ensure_ascii=False, indent=1)
print("manifest OK →", os.path.join(OUT, "manifest.json"))
