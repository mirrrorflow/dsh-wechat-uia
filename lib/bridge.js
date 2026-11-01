/**
 * 桥进程管理：把 Python 那份 WeChat 自动化当成一个受管子进程。
 *
 * 设计要点（每条都是踩过或者差点踩的坑）：
 *
 * 1. **懒启动** —— 插件加载时只拉起一个空壳桥进程（几十毫秒，不碰微信）。真正
 *    连微信（读库 / 建发送引擎）要等第一次用到，所以 DSH 启动慢永远不会是它。
 * 2. **协议是 NDJSON** —— 每行一个 JSON，请求带 id。Python 侧起手就把 stdout
 *    抢走改道 stderr，所以这里可以放心按行解析，不会读到半句人话。
 * 3. **崩了要自己回来** —— 微信一重启、Python 一被杀，桥就没了。这里做有限次
 *    退避重启（1s → 3s → 9s），连续三次起不来就停手并留日志，不无脑刷进程。
 * 4. **启动失败要换解释器** —— 配的 `python` 不在 PATH 上是常见情况（这台机器
 *    就是），按候选列表逐个试，全趴下才报错。
 */
import { spawn } from 'node:child_process'

const RESTART_DELAYS = [1000, 3000, 9000]
const STDERR_KEEP = 300
/** 空壳桥只做 import，正常一两秒就绪；超过这个时间就当它卡死。 */
const READY_TIMEOUT = 20000

export class WechatBridge {
  /**
   * @param {object} options
   * @param {string[]} options.pythonCandidates 解释器候选，按顺序试
   * @param {string} options.projectDir          wechat-bot 项目目录（必须含 bot.py）
   * @param {string} options.script              桥脚本绝对路径
   * @param {number} options.timeoutMs           单次请求默认超时
   * @param {object} options.logger              ctx.logger
   */
  constructor(options) {
    this.options = options
    this.child = null
    this.seq = 0
    this.pending = new Map()
    this.stdoutBuffer = ''
    this.lines = []
    this.restartIndex = 0
    this.restartTimer = null
    this.starting = null
    this.readyResolved = false
    this.disposed = false
  }

  /** 桥是否已经就绪（能发请求）。 */
  get alive() {
    return this.readyResolved === true && this.child !== null
  }

  /** 记录一行日志，环形保留。 */
  #push(line) {
    const text = String(line ?? '').trimEnd()
    if (!text) return
    this.lines.push(text)
    if (this.lines.length > STDERR_KEEP) this.lines.splice(0, this.lines.length - STDERR_KEEP)
  }

  /** 取最近若干行日志。 */
  logs(limit = 40) {
    return this.lines.slice(-Math.max(1, limit))
  }

  /** 确保桥在跑；并发调用共用一个启动过程。 */
  ensure() {
    if (this.disposed) return Promise.reject(new Error('插件已卸载'))
    if (this.alive) return Promise.resolve()
    if (this.starting !== null) return this.starting
    const run = this.#startWithFallback().finally(() => {
      this.starting = null
    })
    this.starting = run
    return run
  }

  /** 按候选解释器逐个尝试，全失败才抛。 */
  async #startWithFallback() {
    const candidates = this.options.pythonCandidates?.length
      ? this.options.pythonCandidates
      : ['python']
    let lastError = null
    for (const python of candidates) {
      try {
        await this.#spawnOnce(python)
        return
      } catch (error) {
        lastError = error
        this.#push(`用 ${python} 启动失败：${error?.message ?? error}`)
        this.options.logger?.warn?.(`[wechat-bot] 用 ${python} 启动失败：${error?.message ?? error}`)
      }
    }
    throw lastError ?? new Error('没有可用的 Python 解释器')
  }

  /**
   * 起一个进程并等它的 ready 帧。
   * @param {string} python 解释器
   */
  #spawnOnce(python) {
    const { script, projectDir } = this.options
    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      const settleOk = () => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        resolve()
      }
      const settleFail = (error, killProcess) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        if (killProcess) {
          try {
            child.kill()
          } catch {
            // 已经没了
          }
        }
        reject(error)
      }

      let child
      try {
        child = spawn(python, [script, '--project-dir', projectDir], {
          cwd: projectDir,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            PYTHONUNBUFFERED: '1',
          },
        })
      } catch (error) {
        settleFail(error, false)
        return
      }

      timer = setTimeout(() => {
        settleFail(new Error(`桥进程 ${READY_TIMEOUT / 1000} 秒没就绪`), true)
      }, READY_TIMEOUT)
      timer.unref?.()

      this.child = child
      this.readyResolved = false

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.#onStdout(chunk, settleOk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) this.#push(line)
      })

      child.on('error', (error) => {
        this.child = null
        this.readyResolved = false
        settleFail(error, false)
      })

      child.on('exit', (code, signal) => {
        const wasReady = this.readyResolved
        this.child = null
        this.readyResolved = false
        this.#rejectAll(`桥进程已退出（code=${code} signal=${signal ?? '-'}）`)
        if (!settled) {
          settleFail(new Error(`桥进程刚起来就退出（code=${code}）`), false)
          return
        }
        if (wasReady && !this.disposed) this.#scheduleRestart()
      })
    })
  }

  /** 退避重启（最多三次；连续失败就停手）。 */
  #scheduleRestart() {
    if (this.disposed || this.restartTimer !== null) return
    if (this.restartIndex >= RESTART_DELAYS.length) {
      this.#push('桥进程连续三次没能起来，已停止重试。修好后调用一次 wechat_status 会重新拉起。')
      this.restartIndex = 0
      return
    }
    const delay = RESTART_DELAYS[this.restartIndex]
    this.restartIndex += 1
    this.#push(`${delay / 1000} 秒后重启桥进程（第 ${this.restartIndex} 次）`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.ensure().catch(() => {})
    }, delay)
    this.restartTimer.unref?.()
  }

  /** 按行切 stdout，把完整帧交给 #onFrame。 */
  #onStdout(chunk, settleOk) {
    this.stdoutBuffer += chunk
    let index = this.stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line) this.#onFrame(line, settleOk)
      index = this.stdoutBuffer.indexOf('\n')
    }
  }

  /** 处理一帧：ready / log / fatal 事件，或某个请求的响应。 */
  #onFrame(line, settleOk) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      this.#push(`协议帧解析失败：${line.slice(0, 200)}`)
      return
    }

    if (frame.event === 'ready') {
      this.readyResolved = true
      this.restartIndex = 0
      this.#push(`桥进程就绪（pid ${frame.pid ?? '?'}）`)
      settleOk?.()
      return
    }
    if (frame.event === 'log') {
      this.#push(String(frame.line ?? ''))
      return
    }
    if (frame.event === 'fatal') {
      const message = String(frame.error ?? '桥进程启动失败')
      this.#push(message)
      this.#rejectAll(message)
      this.options.logger?.warn?.(`[wechat-bot] ${message}`)
      try {
        this.child?.kill()
      } catch {
        // 忽略
      }
      return
    }

    const slot = this.pending.get(frame.id)
    if (slot === undefined) return
    this.pending.delete(frame.id)
    clearTimeout(slot.timer)
    if (frame.ok) {
      slot.resolve(frame.result ?? {})
      return
    }
    const error = new Error(frame.error || '桥进程返回失败')
    if (frame.trace) error.trace = String(frame.trace)
    slot.reject(error)
  }

  /** 把所有在途请求按失败收尾（进程没了）。 */
  #rejectAll(reason) {
    for (const [id, slot] of this.pending) {
      clearTimeout(slot.timer)
      slot.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  /**
   * 发一个请求。
   * @param {string} method 桥支持的方法名
   * @param {object} params 参数
   * @param {number} [timeoutMs] 超时，默认取构造参数
   */
  async request(method, params = {}, timeoutMs) {
    await this.ensure()
    if (this.child === null) throw new Error('桥进程不在，请重试一次')
    const limit = timeoutMs ?? this.options.timeoutMs ?? 120000
    const id = ++this.seq

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `桥进程 ${Math.round(limit / 1000)} 秒没回话（${method}）——` +
              '多半卡在找微信窗口或建发送引擎上，稍后重试一次即可',
          ),
        )
      }, limit)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** 主动关闭：先走协议退出，再兜底杀进程。 */
  async stop() {
    this.disposed = true
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (child === null) return
    try {
      child.stdin.write(`${JSON.stringify({ id: 0, method: 'shutdown' })}\n`)
    } catch {
      // 进程可能已经死了，直接往下杀
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    if (this.child !== null) {
      try {
        this.child.kill()
      } catch {
        // 忽略
      }
      this.child = null
    }
  }
}
