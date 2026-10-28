#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Legacy CLI compatibility: read via api-comments; replies use the browser writer.

python tools/api-reply.py check [aweme_id]
python tools/api-reply.py reply <aweme_id> <comment_id> <text.txt> [--root CID] [--confirm]
Without --confirm, reply returns a draft and never starts a browser.
"""
import argparse
import json
import subprocess
from pathlib import Path
from _home import node_bin, python_bin, plugin_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "reply"), nargs="?", default="check")
    parser.add_argument("aweme_id", nargs="?")
    parser.add_argument("comment_id", nargs="?")
    parser.add_argument("text_file", nargs="?")
    parser.add_argument("--root", default="")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    if not args.aweme_id:
        parser.error("需要 aweme_id")
    if args.mode == "check":
        command = [python_bin(), str(plugin_dir() / "tools/api-comments.py"), args.aweme_id]
    else:
        if not args.comment_id or not args.text_file:
            parser.error("reply 需要 comment_id 和 text_file")
        text = Path(args.text_file).read_text(encoding="utf-8").strip()
        if not text or len(text) > 500:
            parser.error("正文应为 1–500 字")
        if not args.confirm:
            print(json.dumps({"ok": True, "sent": False, "needsConfirm": True, "draft": text,
                              "aweme_id": args.aweme_id, "comment_id": args.comment_id,
                              "root_comment_id": args.root}, ensure_ascii=False))
            return 0
        command = [node_bin(), str(plugin_dir() / "tools/comment-api.mjs"), "--aweme", args.aweme_id,
                   "--reply", args.comment_id, "--text", text]
        if args.root:
            command.extend(["--root", args.root])
    try:
        return subprocess.run(command, timeout=300).returncode
    except (OSError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"ok": False, "error": "子进程不可用：%s" % type(error).__name__}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
