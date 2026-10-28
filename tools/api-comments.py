#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/api-comments.py —— 用签名拉某条作品/图文下的评论，列出「谁·说了什么·cid」
用途：找「号主在评论区 @ 我」的那条，拿到 cid 当 reply_id。
只读。
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str, node_bin  # noqa: E402
import urllib.parse

import httpx

HOME = home_str()
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = node_bin()
SIGNER = os.path.join(PLUGIN, "tools", "dy-signer.mjs")
with open(os.path.join(HOME, "douyin_cookie.txt"), encoding="utf-8") as cookie_file:
    COOKIE = cookie_file.read().strip()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
JAR = {}
for p in COOKIE.split(";"):
    if "=" in p:
        k, v = p.split("=", 1)
        JAR[k.strip()] = v.strip()

COMMON = {
    "device_platform": "webapp", "aid": "6383", "channel": "channel_pc_web",
    "pc_client_type": "1", "version_code": "190500", "version_name": "19.5.0",
    "cookie_enabled": "true", "screen_width": "1920", "screen_height": "1080",
    "browser_language": "zh-CN", "browser_platform": "Win32",
    "browser_name": "Chrome", "browser_version": "141.0.0.0",
    "engine_name": "Blink", "engine_version": "141.0.0.0",
    "os_name": "Windows", "os_version": "10", "platform": "PC",
}
qs = lambda d: "&".join("%s=%s" % (urllib.parse.quote(str(k)), urllib.parse.quote(str(v))) for k, v in d.items())


def sign(rel):
    env = dict(os.environ, DY_COOKIES=json.dumps(JAR, ensure_ascii=False), DOUYIN_HOME=HOME)
    try:
        p = subprocess.run([NODE, SIGNER, rel], capture_output=True, cwd=PLUGIN, env=env, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"err": "签名进程不可用: %s" % e}
    out = p.stdout.decode("utf-8", "replace")
    i = out.find("{")
    if i < 0:
        return {"err": (out + p.stderr.decode("utf-8", "replace"))[-300:] or "签名器没有输出"}
    try:
        data = json.loads(out[i:out.rfind("}") + 1])
        if p.returncode != 0 or not isinstance(data, dict):
            return {"err": "签名器执行失败"}
        return data
    except (ValueError, TypeError):
        return {"err": "签名器返回了无效 JSON"}


CDP_FETCH = os.path.join(PLUGIN, "tools", "cdp-fetch.mjs")


def page_fetch(rel):
    """拉一页评论：签名路优先，签名不可用自动退「无头页面里 fetch」兜底（Issue #2 思路）。
    返回 (json, mode)；两条路都死就抛 RuntimeError。"""
    s = sign(rel)
    # 兼容「node 没输出任何 JSON」的情况：err 可能是空串，得连 signedUrl 一起判（Issue #2）
    if not s.get("err") and s.get("signedUrl"):
        try:
            u = s["signedUrl"]
            if not u.startswith("http"):
                u = "https://www.douyin.com" + u
            parsed = urllib.parse.urlparse(u)
            if parsed.scheme != "https" or parsed.hostname != "www.douyin.com" or parsed.username or parsed.port not in (None, 443):
                raise ValueError("签名 URL 的域名不正确")
            h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*", "Referer": "https://www.douyin.com/",
                 "Origin": "https://www.douyin.com", "Cookie": COOKIE, **(s.get("headers") or {})}
            r = httpx.get(u, headers=h, timeout=30, follow_redirects=False)
            r.raise_for_status()
            data = r.json()
            if not isinstance(data, dict) or data.get("status_code") != 0:
                raise ValueError("评论接口未接受签名")
            return data, "signed"
        except (httpx.HTTPError, ValueError) as e:
            s = {"err": "签名请求失败: %s" % type(e).__name__}
    # 兜底：页面上下文里 fetch（页面自己的签名 SDK 是活的，不用 a_bogus）
    sys.stderr.write("[api-comments] 签名不可用（%s）→ 走无头浏览器兜底\n" % (s.get("err") or "无输出"))
    try:
        p = subprocess.run([NODE, CDP_FETCH, "--path", rel], capture_output=True, cwd=PLUGIN,
                           timeout=180, env=dict(os.environ, DOUYIN_HOME=HOME))
    except (OSError, subprocess.TimeoutExpired) as e:
        raise RuntimeError("浏览器兜底进程不可用，请检查 DOUYIN_NODE / Node ≥22: %s" % type(e).__name__) from None
    body = p.stdout.decode("utf-8", "replace")
    try:
        data = json.loads(body)
        if p.returncode != 0 or not isinstance(data, dict) or data.get("status_code") != 0:
            raise ValueError("浏览器接口未返回成功结果")
        return data, "cdp"
    except Exception:
        tail = (body or p.stderr.decode("utf-8", "replace"))[:150].replace("\n", " ")
        raise RuntimeError("签名和兜底都不通：" + (tail or "无输出"))


def main():
    aweme = sys.argv[1] if len(sys.argv) > 1 else "7698980229549139835"
    seen = set()
    total = 0
    modes = {}
    for page in range(4):
        rel = "/aweme/v1/web/comment/list/?" + qs({**COMMON, "aweme_id": aweme, "count": 20, "cursor": page * 20, "item_type": 0})
        j, mode = page_fetch(rel)
        modes[mode] = modes.get(mode, 0) + 1
        cs = j.get("comments") or []
        fresh = [c for c in cs if c.get("cid") not in seen]
        print("page=%d status_code=%s comments=%d 新=%d has_more=%s" % (page, j.get("status_code"), len(cs), len(fresh), j.get("has_more")))
        for c in fresh:
            seen.add(c.get("cid"))
            total += 1
            u_ = (c.get("user") or {}).get("nickname") or ""
            txt = (c.get("text") or "").replace("\n", " ")
            print("  cid=%s  %s  [%s]  赞%s  %s" % (c.get("cid"), u_, txt[:100], c.get("digg_count"), c.get("create_time")))
            for rr in (c.get("reply_comment") or [])[:6]:
                print("      └ reply cid=%s %s [%s]  %s" % (rr.get("cid"), (rr.get("user") or {}).get("nickname"),
                                                            (rr.get("text") or "").replace("\n", " ")[:90], rr.get("create_time")))
        if not fresh or not j.get("has_more"):
            break
    print("合计 %d 条（通道：%s）" % (total, " ".join("%s×%d" % kv for kv in sorted(modes.items())) or "无"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
