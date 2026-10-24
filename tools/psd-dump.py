# -*- coding: utf-8 -*-
"""Dump 鲸鱼娘拆解.psd 的图层树：名字 / 可见性 / 尺寸 / 类型。只读不改。"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from psd_tools import PSDImage

PSD = r"D:\Downloads\宠物\鲸鱼娘拆解.psd"
psd = PSDImage.open(PSD)

def walk(layer, depth=0):
    ind = "  " * depth
    for l in layer:
        kind = "G" if l.is_group() else ("像素" if hasattr(l, "numpy") else "?")
        vis = "" if l.visible else " [隐藏]"
        bbox = f" ({l.bbox[2]-l.bbox[0]}x{l.bbox[3]-l.bbox[1]})" if l.bbox else ""
        print(f"{ind}- {l.name} [{kind}]{vis}{bbox}")
        if l.is_group():
            walk(l, depth + 1)

print(f"画布: {psd.width}x{psd.height}, 图层数: {len(list(psd.descendants()))}")
walk(psd)
