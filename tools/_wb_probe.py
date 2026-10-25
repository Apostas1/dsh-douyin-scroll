"""探针：edge-tts 到底能不能给到「逐词/逐音节」的时间轴。

背景：嘴型要跟语音对上，光有响度（RMS）不够 —— 响度只知道"多大声"，
不知道"说的是哪个音、什么时候换音"。真正的口型需要**音节级时间轴**。

pet-tts.mjs 现在用的是 CLI 的 --write-subtitles，那是 SentenceBoundary，
一句只有一条 cue（实测 289 字长句也只有 1 条）⇒ 拿它做口型等于整句嘴一直张着。

这个探针验证 Python API 的 boundary='WordBoundary' 给出的粒度。
"""
import asyncio
import json
import sys

import edge_tts

TEXTS = [
    ("短句", "主人，小鱼在呢。"),
    ("带标点长句", "主人主人，小鱼在呢。今天也一起吃大白饭好不好呀？"),
    ("含英文数字", "今天涨了 12 个粉丝，main 分支也合了。"),
]


async def probe(text):
    c = edge_tts.Communicate(text, "zh-CN-XiaoyiNeural", boundary="WordBoundary")
    words = []
    audio = 0
    async for ch in c.stream():
        t = ch["type"]
        if t == "WordBoundary":
            words.append({
                "text": ch["text"],
                # offset/duration 单位是 100 纳秒（1e7 = 1 秒）
                "startMs": round(ch["offset"] / 10000),
                "durMs": round(ch["duration"] / 10000),
            })
        elif t == "audio":
            audio += len(ch["data"])
    return words, audio


async def main():
    out = {"ok": True, "cases": []}
    for label, text in TEXTS:
        try:
            words, audio = await probe(text)
        except Exception as e:  # noqa: BLE001 - 探针要把失败原因原样报出来
            out["cases"].append({"label": label, "text": text, "error": str(e)})
            continue
        n_chars = len([c for c in text if c.strip() and c not in "，。？！、,."])
        out["cases"].append({
            "label": label,
            "text": text,
            "words": words,
            "wordN": len(words),
            "charN": n_chars,
            "audioBytes": audio,
            "lastEndMs": (words[-1]["startMs"] + words[-1]["durMs"]) if words else 0,
        })
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
