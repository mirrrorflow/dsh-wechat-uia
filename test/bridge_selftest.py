# -*- coding: utf-8 -*-
"""桥进程的离线自测：只用标准库，不依赖 DSH。

跑法（在插件目录下）：
    python test\bridge_selftest.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / "python" / "dsh_bridge.py"
PROJECT = Path("D:/deepseek-harness/wechat-bot")


def main() -> int:
    if not PROJECT.is_dir():
        print(f"跳过：项目目录不存在 {PROJECT}")
        return 0

    proc = subprocess.Popen(
        [sys.executable, str(BRIDGE), "--project-dir", str(PROJECT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    failures: list[str] = []

    def call(method: str, **params) -> dict:
        proc.stdin.write((json.dumps({"id": method, "method": method, "params": params},
                                     ensure_ascii=False) + "\n").encode("utf-8"))
        proc.stdin.flush()
        while True:
            raw = proc.stdout.readline()
            if not raw:
                raise RuntimeError("桥进程结束了")
            frame = json.loads(raw.decode("utf-8", "replace"))
            if "event" in frame:          # ready / log 事件，跳过
                continue
            return frame

    def check(label: str, ok: bool, detail: str = "") -> None:
        print(("  ✔ " if ok else "  ✘ ") + label + (f"  → {detail}" if not ok else ""))
        if not ok:
            failures.append(label)

    try:
        # 第一帧必须是 ready
        first = proc.stdout.readline().decode("utf-8", "replace").strip()
        check("启动后先发 ready 帧", '"event": "ready"' in first.replace("'", '"'), first)

        pong = call("ping")
        check("ping 通", pong.get("ok") is True, json.dumps(pong, ensure_ascii=False)[:200])

        status = call("status").get("result") or {}
        check("status 有 projectDir", status.get("projectDir") == str(PROJECT).replace("/", "\\"),
              str(status.get("projectDir")))
        check("status 报告未连接", status.get("connected") is False, str(status.get("connected")))
        check("status 读到表情库", (status.get("stickers") or {}).get("count", 0) > 0,
              json.dumps(status.get("stickers"), ensure_ascii=False))

        stickers = call("stickers").get("result") or {}
        check("表情库列表非空", stickers.get("total", 0) > 0, str(stickers.get("total")))
        keys = [i["key"] for i in stickers.get("items", [])]
        check("能按关键词过滤", bool(call("stickers", query="跪").get("result", {}).get("items")) or "跪下" in keys,
              str(keys[:5]))

        logs = call("logs", limit=5).get("result") or {}
        check("logs 返回数组", isinstance(logs.get("lines"), list), str(logs)[:120])

        bad = call("nope")
        check("未知方法报错而不是崩", bad.get("ok") is False, str(bad)[:120])

        bye = call("shutdown")
        check("shutdown 正常退出", bye.get("ok") is True, str(bye)[:120])
        proc.wait(timeout=20)
        check("进程已退出", proc.poll() is not None, str(proc.poll()))
    finally:
        if proc.poll() is None:
            proc.kill()
        err = proc.stderr.read().decode("utf-8", "replace")
        proc.stderr.close()

    print()
    if failures:
        print(f"失败 {len(failures)} 项：{failures}")
        print("--- stderr 尾部 ---")
        print(err[-2000:])
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
