# dsh-wechat-uia

把「微信 AI 机器人」装进 **DeepSeek Harness**。装好之后，DSH 里的模型可以直接：

- 查机器人现在什么状态（连没连上微信、在不在自动回复、锁定哪个号、表情库几张图）
- 开启 / 停止自动回复
- 往任意会话发文字、发表情
- 读某个会话最近的消息、列最近的会话、查表情库关键词

宿主半边只当**遥控器**：微信自动化（读 SQLCipher 库、UIAutomation 点击、剪贴板粘贴）
仍然跑在你原有的 Python 项目里。所以改 Python 那边立刻生效，插件里不会藏一份会
过期的副本。

---

## 先决条件

| 需要 | 说明 |
|---|---|
| 一份能跑的微信机器人项目 | 目录里要有 `bot.py` / `wboot.py` / `config.py` / `sticker_lib.py`，且 `python bot.py doctor` 能过 |
| Python 3.10+ | 项目依赖 `wechatauto` / `pywin32` / `Pillow`。插件默认按 `python` → `py` → `python3` 找，也可显式指定 |
| 微信 PC 4.1.9+ 已登录 | 发送要驱动真实客户端窗口，窗口被收进托盘时插件会自动把它捞出来 |
| DSH ≥ 0.2.0-rc.1 | 需要 `@deepseek-ai/dsh-tools` 提供的工具注册表 |

## 安装

**从 npm 装（发布之后）**

```bat
:: 关掉 DSH 桌面端（运行时会锁住 profile）
dsh plugin --profile desktop add dsh-wechat-uia
:: 再打开 DSH，侧栏「插件」里能看到它
```

国内网络慢就用镜像：`dsh plugin --profile desktop add dsh-wechat-uia --registry https://registry.npmmirror.com`

**从本地目录装（改代码时用这个）**

```bat
dsh plugin --profile desktop add D:\deepseek-harness\dsh-wechat-uia
```

装本地路径是 `link:` 依赖，改完 `lib/` 里的代码重启 DSH 就生效，不用重新发包。

## 发布到 npm

```bat
cd D:\deepseek-harness\dsh-wechat-uia
npm pack --dry-run     :: 先看一眼都发什么（应该只有 8 个文件）
npm login
npm publish            :: publishConfig 已声明 access=public
```

包里带的是 `lib/`（宿主半边）、`python/dsh_bridge.py`（桥）、`cordis.patch.yml`、
README、LICENSE。**不含**你本机的 `wechat-bot` 项目、`.env`、表情库 —— 那些留在原地，
通过 `projectDir` 指过去。所以别人装了这个包还得有自己的项目才能用。

## 配置

插件设置里改，或在自己的 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-wechat-uia
  config:
    projectDir: 'D:\deepseek-harness\wechat-bot'
    pythonPath: 'C:\Python312\python.exe'
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `projectDir` | 自动探测 | `bot.py` 所在目录。留空时按 `WECHAT_BOT_DIR` 环境变量 → `D:\deepseek-harness\wechat-bot` → `~/deepseek-harness/wechat-bot` 顺序找 |
| `pythonPath` | 自动探测 | 解释器路径。留空按 `python` → `py` → `python3` 试；也可以用 `WECHAT_BOT_PYTHON` 环境变量 |
| `autoStart` | `false` | 插件加载时就拉起桥进程。默认关 —— 第一次真正用到才起，DSH 启动不受影响 |
| `requestTimeoutMs` | `120000` | 单次动作超时。建发送引擎要十几秒，别低于 30 秒 |

## 工具

| 工具 | 干什么 |
|---|---|
| `wechat_status` | 状态总览 + 最近日志。排查「怎么不回消息」先看它 |
| `wechat_control` | `action: start \| stop \| restart`，起停自动回复 |
| `wechat_send` | `kind: text \| sticker`，`to` 填昵称或 wxid，发文字/发表情 |
| `wechat_recent` | 读某个会话最近 N 条（只读本地库，不标已读、不打扰对方） |
| `wechat_sessions` | 列最近会话，确认 `wechat_send` 的 `to` 该填什么 |
| `wechat_stickers` | 查表情库；`query` 可按关键词过滤 |

### `/wx` 命令

DSH 的命令面板里：

```
/wx          看状态
/wx start    开监听（自动回复）
/wx stop     停监听（发送能力保留）
```

## 和桌面那个黑窗口的关系

两边抢同一个 Windows 命名互斥体（`Local\wechat-ai-bot-<项目目录 md5>`）：

- DSH 里 `wechat_control start` 之后，桌面 `微信AI-启动.cmd` 会提示「已经有一个在跑」并退出；
- 反过来也一样，桌面那个开着时，DSH 里会明确告诉你「先把它关掉」。

这是故意的：两个实例同时监听同一个号，同一条消息会被回两遍。

## 排查

| 现象 | 处理 |
|---|---|
| 工具返回「没找到 wechat-bot 项目目录」 | 插件设置里把 `projectDir` 填成含 `bot.py` 的目录 |
| 工具返回「用 xxx 启动失败」 | 配 `pythonPath`。桥会自己把候选解释器逐个试一遍，全失败才报错 |
| 「没找到微信主窗口」 | 微信没登录或窗口在托盘。插件会尝试自动捞出来并顺手纠正窄窗口；微信彻底退出了就只能手动打开登录 |
| 「发送失败 / 发送引擎没有任何响应」 | 看 `wechat_status` 的日志尾部；`screen grab failed` 表示屏幕被锁或有全屏独占 |
| 表情发不出去 | `wechat_stickers` 确认关键词能匹配上；发图走剪贴板，跨会话粘太快会失败，重试一次通常就好 |
| 插件装了但工具没出现 | DSH 侧栏「插件」里看这一行有没有加载错误；日志里搜 `[wechat-bot]` |

## 卸载

```bat
dsh plugin --profile desktop remove dsh-wechat-uia
```

Python 桥进程随插件卸载一起退出，不会留孤儿进程（自测里专门验证了这条）。

## 自测

```bat
node test\smoke.mjs          :: 15 项：纯函数、工具注册、真跑桥、卸载收尾
python test\bridge_selftest.py  :: 11 项：NDJSON 协议、日志改道、优雅退出
```

两个都不需要 DSH 在场，也不需要微信在线。

## 风险

和 Python 项目本身一样：客户端自动化违反微信用户协议，有风控/封号风险。**用小号，
别用来加人、群发、营销。**
