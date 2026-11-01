# -*- coding: utf-8 -*-
"""DSH 插件的 Python 控制桥。

宿主半边（Node / DSH）把本文件当子进程拉起来，双方用 **NDJSON** 通信：
每行一个 JSON，请求带 ``id``，响应原样带回同一个 ``id``。

之所以不把这套逻辑用 JS 重写一遍：读微信的 SQLCipher 库、UIAutomation 点
击、剪贴板粘贴全在 Python 侧（``wboot`` / ``bot`` / ``wechatauto``），重写
等于再造一套自动化，还会跟现有那份代码分叉。这里只做「转接」：把已有的
Bot / WeChatDB 能力包成一组可被模型调用的动作。

三条硬约束：

1. **stdout 只能有协议帧。** 起手就把 ``sys.stdout`` 换到 stderr，``bot``
   里所有 ``print`` 自动改道，不会再污染协议流。
2. **连微信是懒加载。** 只读消息只需要数据库；建发送引擎（GUI 校准）要十
   几秒，只有真要发东西或要开始监听时才 connect。
3. **退出要干净。** 收到 ``shutdown`` 先停监听、再关句柄，最后才退进程。

协议帧示例::

    → {"id": 1, "method": "status"}
    ← {"id": 1, "ok": true, "result": {"listening": false, ...}}
    ← {"event": "log", "line": "[19:40:01] 表情库已加载 25 张"}
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import threading
import time
import traceback

# ---------------------------------------------------------------------------
# 协议输出通道：必须在 import bot 之前抢下来，否则任何 import 期的 print 都会
# 混进 stdout，宿主那边按行解析就会拿到半句人话 + 半帧 JSON。
# ---------------------------------------------------------------------------
PROTO_OUT = sys.stdout.buffer
sys.stdout = sys.stderr         # 之后所有人话都走 stderr（宿主会收集成日志）
try:
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:               # 老版本 Python 没有 reconfigure，忽略
    pass


class Runtime:
    """桥的全部状态。一个进程一份，所有方法都从协议主循环串行调用。"""

    def __init__(self, project_dir: str) -> None:
        self.dir = project_dir
        self.started_at = time.time()
        self.lock = threading.RLock()

        self._bot = None            # bot.Bot，只有在要发消息/开监听时才建
        self._db = None             # wechatauto 的 WeChatDB，只读
        self._lib = None            # sticker_lib.StickerLibrary
        self._db_error = ""

        self.listening = False
        self.logs: collections.deque = collections.deque(maxlen=400)

    # ---------------- 基础 ----------------
    def log(self, line: str) -> None:
        """本桥自己的日志：进环形缓冲 + 走 stderr。"""
        text = f"[{time.strftime('%H:%M:%S')}] {line}"
        self.logs.append(text)
        print(text, file=sys.stderr, flush=True)

    def recent_logs(self, limit: int = 40) -> list[str]:
        limit = max(0, min(int(limit or 40), len(self.logs) or 1))
        return list(self.logs)[-limit:]

    # ---------------- 懒加载 ----------------
    def db(self):
        """只读数据库。不需要发送引擎，几十毫秒。"""
        if self._db is not None:
            return self._db
        import wboot
        WeChatDB, _Listener, _GUI, db_dir, account = wboot.load()
        self._db = WeChatDB(db_dir=db_dir, account=account)
        return self._db

    def library(self):
        """表情库。纯文件扫描，不碰微信。"""
        if self._lib is None:
            import bot as botmod
            self._lib = botmod.sticker_lib.StickerLibrary(botmod.Bot._sticker_dir())
        return self._lib

    def bot(self):
        """发送引擎。最贵的一步：要找到微信窗口并做一次布局校准。"""
        if self._bot is not None:
            return self._bot
        import bot as botmod
        instance = botmod.Bot()
        try:
            instance.connect()
        except SystemExit as exc:          # connect 失败时用的是 SystemExit
            raise RuntimeError(str(exc)) from None
        instance.started_at = time.time()
        self._bot = instance
        return self._bot

    # ---------------- 动作 ----------------
    def status(self) -> dict:
        me = {}
        if self._bot is not None:
            me = {"wxid": self._bot.self_wxid or "", "nick": self._bot.self_nick or ""}
        sticker_count = 0
        sticker_dir = ""
        try:
            lib = self.library()
            sticker_count = lib.count
            sticker_dir = str(getattr(lib, "directory", ""))
        except Exception as exc:
            self._db_error = f"表情库读取失败：{exc!r}"

        import config
        return {
            "projectDir": self.dir,
            "pid": os.getpid(),
            "uptimeSec": round(time.time() - self.started_at, 1),
            "connected": self._bot is not None,
            "listening": self.listening,
            "self": me,
            "account": (os.environ.get("WECHAT_ACCOUNT") or "").strip(),
            "stickers": {"count": sticker_count, "dir": sticker_dir},
            "dryRun": bool(getattr(config, "DRY_RUN", False)),
            "model": getattr(config, "MODEL", ""),
            "logs": self.recent_logs(15),
        }

    def start(self) -> dict:
        with self.lock:
            if self.listening:
                return {"listening": True, "already": True}
            import bot as botmod
            instance = self.bot()
            if not botmod.acquire_single_instance():
                raise RuntimeError(
                    "已经有一个机器人在跑了（可能是桌面上那个黑窗口），"
                    "先把它关掉，否则同一条消息会被回两遍。"
                )
            instance.listener.add_all(instance._on_message)
            instance.listener.start()
            self.listening = True
            instance.started_at = time.time()
            self.log("已开始监听（自动回复已开启）")
            return {"listening": True, "already": False}

    def stop(self) -> dict:
        with self.lock:
            if not self.listening:
                return {"listening": False, "already": True}
            self._release_instance_lock()
            try:
                if self._bot is not None and self._bot.listener is not None:
                    self._bot.listener.stop()
            except Exception as exc:
                self.log(f"停监听时出错（已忽略）：{exc!r}")
            self.listening = False
            self.log("已停止监听（自动回复已关闭，发送能力仍在）")
            return {"listening": False, "already": False}

    def _release_instance_lock(self) -> None:
        """放掉单实例互斥体，让桌面的 bot.py 能接回去。"""
        try:
            import bot as botmod
            import ctypes
            handles = getattr(botmod, "_SINGLETON_HANDLES", None)
            if handles:
                for handle in list(handles):
                    ctypes.windll.kernel32.CloseHandle(handle)
                handles.clear()
        except Exception:
            pass

    def send_text(self, chat: str, text: str) -> dict:
        import bot as botmod
        import config
        if not text.strip():
            raise RuntimeError("要发的内容是空的")
        if getattr(config, "DRY_RUN", False):
            return {"sent": False, "reason": "当前是演练模式（DRY_RUN=true），没有真正发送"}
        instance = self.bot()
        chunks = botmod.split_text(text, config.MAX_REPLY_CHARS)
        if not chunks:
            raise RuntimeError("切分后没有可发的内容")
        for index, chunk in enumerate(chunks):
            with instance._send_lock:
                resp = instance._send_with_revive(
                    lambda body=chunk: instance.gui.send_msg(
                        body, chat, verify=config.SEND_VERIFY
                    ),
                    "发送",
                )
            if not resp:
                reason = ""
                if hasattr(resp, "get"):
                    reason = resp.get("message") or ""
                return {"sent": False, "reason": reason or "发送引擎没有任何响应", "chunks": len(chunks)}
            if index:
                time.sleep(0.8)
        return {"sent": True, "chunks": len(chunks)}

    def send_sticker(self, chat: str, keyword: str) -> dict:
        # 先在表情库里找图：这一步纯文件扫描，不用连微信。
        # 找不到就直接回话，别为了报个「没这张图」去建发送引擎（要十几秒）。
        lib = self.library()
        lib.maybe_reload()
        if keyword:
            sticker = lib.get(keyword) or lib.match_text(keyword)
        else:
            sticker = lib.random()
        if sticker is None:
            return {
                "sent": False,
                "reason": f"表情库里没有匹配「{keyword}」的图" if keyword else "表情库是空的",
            }
        instance = self.bot()
        ok = instance._deliver_sticker(chat, sticker.key, sticker, "DSH")
        return {"sent": bool(ok), "key": sticker.key, "file": sticker.filename}

    def stickers(self, query: str = "") -> dict:
        lib = self.library()
        lib.maybe_reload()
        items = []
        for sticker in lib.stickers:
            if query and query not in sticker.key and not any(
                query in alias for alias in sticker.aliases
            ):
                continue
            items.append({
                "key": sticker.key,
                "file": sticker.filename,
                "aliases": list(sticker.aliases),
            })
        return {"total": lib.count, "items": items[:200], "dir": str(getattr(lib, "directory", ""))}

    def recent(self, chat: str, limit: int = 20) -> dict:
        db = self.db()
        rows = db.get_messages(chat, limit=max(1, min(int(limit or 20), 100)))
        out = []
        for row in rows:
            created = int(row.get("create_time") or 0)
            sender = str(row.get("sender_username") or "")
            mine = bool(sender) and sender == getattr(db, "wxid", "")
            out.append({
                "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(created)) if created else "",
                "type": str(row.get("type") or ""),
                "from": "我" if mine else (db.get_nickname(sender) if sender else "?"),
                "content": str(row.get("content") or "")[:500],
            })
        return {"chat": chat, "count": len(out), "messages": out}

    def sessions(self, limit: int = 20) -> dict:
        db = self.db()
        rows = db.get_sessions(limit=max(1, min(int(limit or 20), 100)))
        out = []
        for row in rows:
            username = str(row.get("username") or "")
            out.append({
                "username": username,
                "name": db.get_nickname(username) if username else "?",
                "group": username.endswith("@chatroom"),
            })
        return {"count": len(out), "sessions": out}

    def dispose(self) -> None:
        try:
            if self.listening:
                self.stop()
        except Exception:
            pass
        try:
            if self._bot is not None:
                self._bot.shutdown()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 协议主循环
# ---------------------------------------------------------------------------
HANDLERS = {
    "ping": lambda rt, p: {"pong": True, "pid": os.getpid()},
    "status": lambda rt, p: rt.status(),
    "start": lambda rt, p: rt.start(),
    "stop": lambda rt, p: rt.stop(),
    "send_text": lambda rt, p: rt.send_text(p.get("chat") or p.get("to") or "", p.get("text") or ""),
    "send_sticker": lambda rt, p: rt.send_sticker(p.get("chat") or p.get("to") or "", p.get("keyword") or ""),
    "stickers": lambda rt, p: rt.stickers(p.get("query") or ""),
    "recent": lambda rt, p: rt.recent(p.get("chat") or "", p.get("limit") or 20),
    "sessions": lambda rt, p: rt.sessions(p.get("limit") or 20),
    "logs": lambda rt, p: {"lines": rt.recent_logs(p.get("limit") or 40)},
}


def emit(payload: dict) -> None:
    PROTO_OUT.write(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
    PROTO_OUT.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description="DSH WeChat bot bridge")
    parser.add_argument("--project-dir", required=True, help="wechat-bot 项目目录")
    args = parser.parse_args()

    project_dir = os.path.abspath(args.project_dir)
    if not os.path.isdir(project_dir):
        emit({"event": "fatal", "error": f"项目目录不存在：{project_dir}"})
        return

    # 让 import bot / wboot / config 都指向用户那份项目，
    # 也保证 .env、stickers/、plugins/ 这些相对路径落在正确位置。
    os.chdir(project_dir)
    if project_dir not in sys.path:
        sys.path.insert(0, project_dir)

    runtime = Runtime(project_dir)

    # bot.Bot.log 原本直接 print；换成同时进缓冲的版本，宿主才能把运行日志
    # 读回去给用户看。
    try:
        import bot as botmod

        def _log(*parts) -> None:
            runtime.log(" ".join(str(p) for p in parts))

        botmod.Bot.log = staticmethod(_log)
    except Exception as exc:
        emit({"event": "fatal", "error": f"加载项目失败：{exc!r}"})
        return

    emit({"event": "ready", "pid": os.getpid(), "projectDir": project_dir})

    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except Exception:
            emit({"event": "log", "line": f"协议帧不是合法 JSON：{line[:120]}"})
            continue

        method = frame.get("method") or ""
        params = frame.get("params") or {}
        req_id = frame.get("id")

        if method == "shutdown":
            emit({"id": req_id, "ok": True, "result": {"bye": True}})
            break

        handler = HANDLERS.get(method)
        if handler is None:
            emit({"id": req_id, "ok": False, "error": f"未知方法：{method}"})
            continue

        try:
            result = handler(runtime, params)
            emit({"id": req_id, "ok": True, "result": result})
        except Exception as exc:
            emit({
                "id": req_id,
                "ok": False,
                "error": str(exc) or repr(exc),
                "trace": traceback.format_exc()[-1500:],
            })

    runtime.dispose()


if __name__ == "__main__":
    main()
