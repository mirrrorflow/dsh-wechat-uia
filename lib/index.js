/**
 * dsh-wechat-uia —— 把「微信 AI 机器人」装进 DeepSeek Harness。
 *
 * 宿主半边只做三件事：
 *   ① 拉起并看管 Python 桥进程（`python/dsh_bridge.py`）；
 *   ② 把桥的能力注册成模型可调用的工具（`ctx.tools`）；
 *   ③ 给 DSH 的命令面板加一个 `/wx`，不用跟模型说话也能看状态。
 *
 * 真正的微信自动化仍然跑在 Python 侧那份项目里（读 SQLCipher 库 + UIAutomation
 * 点击 + 剪贴板粘贴）。这里不复制、不重写，只当遥控器 —— 改 Python 那边立刻
 * 生效，不会出现「插件里的副本和项目里的代码对不上」这种经典事故。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WechatBridge } from './bridge.js'

/** 诊断信息里的插件名。 */
export const name = 'wechat-bot'

/** 没有工具服务就没什么可做的了。 */
export const inject = ['tools']

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BRIDGE_SCRIPT = path.join(PACKAGE_ROOT, 'python', 'dsh_bridge.py')

/** 找不到项目时按这个顺序猜。 */
const PROJECT_CANDIDATES = [
  'D:/deepseek-harness/wechat-bot',
  path.join(os.homedir(), 'deepseek-harness', 'wechat-bot'),
  path.join(os.homedir(), 'wechat-bot'),
]

/** 统一的模型侧输出：一句人话 + 是否成功。 */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true, description: '动作是否成功' },
      text: { type: 'string', required: true, description: '给人看的说明，含关键数据' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

export const Config = z.object({
  projectDir: z
    .string()
    .default('')
    .description('wechat-bot 项目目录（含 bot.py）；留空则自动探测 D:/deepseek-harness/wechat-bot'),
  pythonPath: z
    .string()
    .default('')
    .description('Python 解释器路径；留空按 python → py → python3 顺序找'),
  autoStart: z
    .boolean()
    .default(false)
    .description('插件加载时就把桥进程拉起来。默认关：第一次真正用到时才起，DSH 启动不受影响'),
  requestTimeoutMs: z
    .number()
    .step(1000)
    .min(5000)
    .max(600000)
    .default(120000)
    .description('单次动作的超时（毫秒）。连微信要十几秒，别调太小'),
})

/** 该项目目录看起来像不像那份项目。 */
function looksLikeProject(dir) {
  try {
    return fs.statSync(path.join(dir, 'bot.py')).isFile()
  } catch {
    return false
  }
}

/** 按配置 + 环境变量 + 常见位置解析项目目录；找不到返回空串。 */
export function resolveProjectDir(configured, candidates = PROJECT_CANDIDATES) {
  const explicit = [
    configured,
    process.env.WECHAT_BOT_DIR ?? '',
    ...candidates,
  ].filter((item) => typeof item === 'string' && item.trim() !== '')
  for (const dir of explicit) {
    const full = path.resolve(dir)
    if (looksLikeProject(full)) return full
  }
  return ''
}

/** 按 pythonPath → python → py → python3 排候选。 */
export function pythonCandidates(configured) {
  const list = [configured, process.env.WECHAT_BOT_PYTHON ?? '', 'python', 'py', 'python3']
  return [...new Set(list.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

/** 把时间戳变成「几秒前」这种人话。 */
function humanUptime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < 60) return `${total} 秒`
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
  return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`
}

/** 状态对象 → 给模型看的一段话。 */
export function describeStatus(status) {
  const lines = []
  const self = status.self ?? {}
  const stickers = status.stickers ?? {}
  lines.push(
    `微信机器人：桥进程存活（pid ${status.pid ?? '?'}，已运行 ${humanUptime(status.uptimeSec)}）`,
  )
  lines.push(
    status.connected
      ? `发送引擎：已连上${self.nick ? `（${self.nick}${self.wxid ? ` / ${self.wxid}` : ''}）` : ''}`
      : '发送引擎：未连接（第一次发送或开启监听时会自动连，约十秒）',
  )
  lines.push(`自动回复：${status.listening ? '正在监听' : '已停止'}`)
  if (status.account) lines.push(`锁定账号：${status.account}`)
  lines.push(`表情库：${stickers.count ?? 0} 张　模型：${status.model || '?'}　演练模式：${status.dryRun ? '开' : '关'}`)
  const logs = Array.isArray(status.logs) ? status.logs.slice(-10) : []
  if (logs.length > 0) {
    lines.push('最近日志：')
    for (const line of logs) lines.push(`  ${line}`)
  }
  return lines.join('\n')
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{projectDir: string, pythonPath: string, autoStart: boolean, requestTimeoutMs: number}} config
 */
export function apply(ctx, config) {
  const projectDir = resolveProjectDir(config.projectDir)
  let bridge = null

  if (projectDir === '') {
    ctx.logger.warn(
      `[${name}] 没找到 wechat-bot 项目（找不到 bot.py）。请在插件设置里把 projectDir 指到项目目录，` +
        `或用环境变量 WECHAT_BOT_DIR 指定。工具仍然会注册，但每次调用都会提示这件事。`,
    )
  } else {
    ctx.logger.info(`[${name}] 项目目录：${projectDir}`)
  }

  if (!fs.existsSync(BRIDGE_SCRIPT)) {
    ctx.logger.warn(`[${name}] 桥脚本不见了：${BRIDGE_SCRIPT}`)
  }

  /** 惰性创建桥；项目目录没解析出来时返回 null。 */
  const getBridge = () => {
    if (bridge !== null) return bridge
    if (projectDir === '') return null
    bridge = new WechatBridge({
      python: pythonCandidates(config.pythonPath)[0],
      pythonCandidates: pythonCandidates(config.pythonPath),
      projectDir,
      script: BRIDGE_SCRIPT,
      timeoutMs: config.requestTimeoutMs,
      logger: ctx.logger,
    })
    return bridge
  }

  /** 统一包一层：把异常翻译成模型能看懂的一句话，而不是一坨栈。 */
  const guard = async (action) => {
    const instance = getBridge()
    if (instance === null) {
      return {
        ok: false,
        text:
          '没找到 wechat-bot 项目目录（需要能看到 bot.py）。请在 DSH 插件设置里把 projectDir 填成项目路径，' +
          '例如 D:\\deepseek-harness\\wechat-bot，然后重试。',
      }
    }
    try {
      return await action(instance)
    } catch (error) {
      const detail = String(error?.message ?? error)
      ctx.logger.warn(`[${name}] 动作失败：${detail}`)
      return { ok: false, text: `执行失败：${detail}` }
    }
  }

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------
  const tools = [
    defineTool({
      name: 'wechat_status',
      description:
        '查看微信 AI 机器人的运行状态：桥进程是否活着、发送引擎连没连上、是否正在自动回复、' +
        '锁定的是哪个微信号、表情库有多少张、以及最近几行运行日志。排查「机器人不回消息」先看这个。',
      parameters: {
        logLines: {
          type: 'integer',
          description: '附带最近多少行日志，默认 10，最多 100',
        },
      },
      output: OUTPUT,
      async execute(args) {
        return guard(async (instance) => {
          const status = await instance.request('status')
          const extra = Math.max(0, Math.min(Number(args.logLines ?? 10), 100))
          if (extra > 10) {
            const tail = await instance.request('logs', { limit: extra })
            status.logs = Array.isArray(tail.lines) ? tail.lines : status.logs
          }
          return { ok: true, text: describeStatus(status) }
        })
      },
    }),

    defineTool({
      name: 'wechat_control',
      description:
        '开启或停止微信机器人的自动回复。start = 开始监听并自动回消息（会占用单实例锁，' +
        '桌面上那个黑窗口就抢不到了）；stop = 停止自动回复但保留发送能力；restart = 先停再开。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['start', 'stop', 'restart'],
          description: 'start / stop / restart',
        },
      },
      output: OUTPUT,
      async execute(args) {
        return guard(async (instance) => {
          if (args.action === 'restart') {
            await instance.request('stop', {}, config.requestTimeoutMs)
            const started = await instance.request('start', {}, config.requestTimeoutMs)
            return { ok: true, text: `已重启监听（listening=${started.listening}）。` }
          }
          if (args.action === 'stop') {
            const result = await instance.request('stop', {}, config.requestTimeoutMs)
            return {
              ok: true,
              text: result.already ? '本来就没在监听。' : '已停止自动回复，发送能力仍然可用。',
            }
          }
          const result = await instance.request('start', {}, config.requestTimeoutMs)
          return {
            ok: true,
            text: result.already
              ? '已经在监听了，没重复启动。'
              : '已开始监听，新消息会自动回。可以用 wechat_status 复查。',
          }
        })
      },
    }),

    defineTool({
      name: 'wechat_send',
      description:
        '往指定微信会话发东西。kind=text 发文字（超长自动分条），kind=sticker 从表情库挑一张图发。' +
        'to 填昵称或 wxid 都行（跟自己微信里搜得到的一致）。',
      parameters: {
        kind: { type: 'string', required: true, enum: ['text', 'sticker'], description: 'text 或 sticker' },
        to: { type: 'string', required: true, description: '会话名（昵称/群名）或 wxid' },
        text: { type: 'string', description: 'kind=text 时的正文' },
        keyword: { type: 'string', description: 'kind=sticker 时的关键词；不填就随机一张' },
      },
      output: OUTPUT,
      async execute(args) {
        if (args.kind === 'text' && !String(args.text ?? '').trim()) {
          return { ok: false, text: 'kind=text 时 text 不能为空。' }
        }
        return guard(async (instance) => {
          if (args.kind === 'sticker') {
            const result = await instance.request('send_sticker', {
              chat: args.to,
              keyword: args.keyword ?? '',
            })
            return result.sent
              ? { ok: true, text: `已把表情「${result.key}」（${result.file}）发给「${args.to}」。` }
              : { ok: false, text: `没发出去：${result.reason ?? '未知原因'}` }
          }
          const result = await instance.request('send_text', { chat: args.to, text: args.text })
          return result.sent
            ? { ok: true, text: `已发给「${args.to}」${result.chunks > 1 ? `（分 ${result.chunks} 条）` : ''}。` }
            : { ok: false, text: `没发出去：${result.reason ?? '未知原因'}` }
        })
      },
    }),

    defineTool({
      name: 'wechat_recent',
      description: '读取某个微信会话最近的消息（只读本地数据库，不会打扰对方，也不会标已读）。',
      parameters: {
        chat: { type: 'string', required: true, description: '会话的 wxid / 群 id / 昵称' },
        limit: { type: 'integer', description: '最多几条，默认 20，上限 100' },
      },
      output: OUTPUT,
      async execute(args) {
        return guard(async (instance) => {
          const result = await instance.request('recent', { chat: args.chat, limit: args.limit ?? 20 })
          const rows = result.messages ?? []
          if (rows.length === 0) return { ok: true, text: `「${args.chat}」最近没有可读的消息。` }
          const body = rows
            .map((row) => `${row.time} ${row.from}：${String(row.content).replace(/\s+/g, ' ').slice(0, 120)}`)
            .join('\n')
          return { ok: true, text: `「${args.chat}」最近 ${rows.length} 条：\n${body}` }
        })
      },
    }),

    defineTool({
      name: 'wechat_sessions',
      description: '列出最近的微信会话（私聊和群都在里面），用来确认 wechat_send 里 to 该填什么。',
      parameters: {
        limit: { type: 'integer', description: '最多几个，默认 20，上限 100' },
      },
      output: OUTPUT,
      async execute(args) {
        return guard(async (instance) => {
          const result = await instance.request('sessions', { limit: args.limit ?? 20 })
          const rows = result.sessions ?? []
          if (rows.length === 0) return { ok: true, text: '没有读到任何会话。' }
          const body = rows
            .map((row) => `${row.group ? '群' : '私聊'}　${row.name}　${row.username}`)
            .join('\n')
          return { ok: true, text: `最近 ${rows.length} 个会话：\n${body}` }
        })
      },
    }),

    defineTool({
      name: 'wechat_stickers',
      description: '查看表情库里有哪些图、某个关键词能匹配到哪张。加图只需往 stickers/ 里丢文件，不用重启。',
      parameters: {
        query: { type: 'string', description: '可选关键词，只列相关的' },
      },
      output: OUTPUT,
      async execute(args) {
        return guard(async (instance) => {
          const result = await instance.request('stickers', { query: args.query ?? '' })
          const items = result.items ?? []
          if (items.length === 0) {
            return {
              ok: true,
              text: args.query ? `表情库里没有匹配「${args.query}」的图。` : `表情库是空的（${result.dir ?? '?'}）。`,
            }
          }
          const body = items.map((item) => `${item.key}　${item.file}`).join('\n')
          return { ok: true, text: `表情库共 ${result.total} 张，列出 ${items.length} 张：\n${body}` }
        })
      },
    }),
  ]

  for (const tool of tools) ctx.tools.register(tool)

  // ------------------------------------------------------------------
  // /wx 命令：不经过模型，直接看状态（顺手起停）
  // ------------------------------------------------------------------
  const commands = ctx.get?.('commands')
  if (commands !== undefined && commands !== null) {
    commands.register({
      name: 'wx',
      description: '微信机器人：/wx 看状态，/wx start 开监听，/wx stop 停监听',
      input: { hint: '[start|stop]' },
      async handler({ rawInput }) {
        const action = String(rawInput ?? '').trim().toLowerCase()
        const instance = getBridge()
        if (instance === null) {
          return { kind: 'error', text: '没找到 wechat-bot 项目，先在插件设置里填 projectDir。' }
        }
        try {
          if (action === 'start') {
            await instance.request('start')
            return { kind: 'success', text: '已开始监听。' }
          }
          if (action === 'stop') {
            await instance.request('stop')
            return { kind: 'success', text: '已停止监听。' }
          }
          const status = await instance.request('status')
          return { kind: 'success', text: describeStatus(status) }
        } catch (error) {
          return { kind: 'error', text: `失败：${error?.message ?? error}` }
        }
      },
    })
  }

  // ------------------------------------------------------------------
  // 生命周期：插件卸载 / DSH 退出时把 Python 一起收掉，别留孤儿进程
  // ------------------------------------------------------------------
  ctx.effect(() => {
    if (config.autoStart && projectDir !== '') {
      getBridge()
        ?.ensure()
        .then(() => ctx.logger.info(`[${name}] 桥进程就绪，可以用 wechat_status 了。`))
        .catch((error) => ctx.logger.warn(`[${name}] 桥进程没能起来：${error?.message ?? error}`))
    }
    return () => {
      const instance = bridge
      bridge = null
      void instance?.stop()
    }
  })

  ctx.logger.info(`[${name}] 已装好：6 个工具（wechat_status/control/send/recent/sessions/stickers）${commands ? ' + /wx 命令' : ''}`)
}
