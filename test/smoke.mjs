/**
 * 插件的离线自测：用一个假 ctx 把 apply() 跑起来，逐个调工具。
 *
 * 跑法（插件目录下）：
 *   node test/smoke.mjs
 *
 * 不需要 DSH。`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 用
 * test/stubs 里的桩代替 —— 桩被拷进一个临时目录再 import，**不放进包本身**。
 * 这一步是必须的：DSH 对 linked 插件是按 peerDependencies 把 `@deepseek-ai/*`
 * 拦截到安装目录的副本，包内一旦躺着自己的 node_modules，原生解析就会抢先
 * 命中假货，插件在真机上会「装上了但行为不对」。
 *
 * 桥进程是真的 —— 会真的起 Python、真的去读表情库。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const TMP = path.join(HERE, '.tmp')
const PROJECT = 'D:\\deepseek-harness\\wechat-bot'

// ---- 组装一个能 import 的临时副本（lib + python + 桩 node_modules）----
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
fs.cpSync(path.join(ROOT, 'lib'), path.join(TMP, 'lib'), { recursive: true })
fs.cpSync(path.join(ROOT, 'python'), path.join(TMP, 'python'), { recursive: true })
fs.cpSync(path.join(HERE, 'stubs'), path.join(TMP, 'node_modules'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"module"}', 'utf8')

const results = []
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push([true, label])
      console.log(`  ✔ ${label}`)
    })
    .catch((error) => {
      results.push([false, label])
      console.log(`  ✘ ${label}  → ${error?.message ?? error}`)
    })
}

const plugin = await import(pathToFileURL(path.join(TMP, 'lib', 'index.js')).href)

// ---- 假 ctx：只实现插件用到的那几个口子 ----
const registered = []
const disposers = []
const logs = []
const ctx = {
  logger: {
    info: (line) => logs.push(['info', line]),
    warn: (line) => logs.push(['warn', line]),
  },
  tools: {
    register: (definition) => registered.push(definition),
  },
  get: () => undefined, // 没有 commands 服务，跳过 /wx 分支
  effect: (factory) => {
    disposers.push(factory())
  },
}

console.log('=== 1. 纯函数 ===')
await check('resolveProjectDir 认得真项目', () => {
  assert.equal(plugin.resolveProjectDir(PROJECT), path.resolve(PROJECT))
})
await check('resolveProjectDir 认不出时返回空串', () => {
  assert.equal(plugin.resolveProjectDir('D:\\不存在的目录', []), '')
})
await check('pythonCandidates 去重且保序', () => {
  const list = plugin.pythonCandidates('python')
  assert.equal(list[0], 'python')
  assert.equal(new Set(list).size, list.length)
})
await check('describeStatus 能渲染未连接状态', () => {
  const text = plugin.describeStatus({
    pid: 1,
    uptimeSec: 65,
    connected: false,
    listening: false,
    self: {},
    stickers: { count: 25 },
    dryRun: false,
    model: 'deepseek-chat',
    logs: ['[19:40:01] hi'],
  })
  assert.match(text, /已运行 1 分 5 秒/)
  assert.match(text, /发送引擎：未连接/)
  assert.match(text, /表情库：25 张/)
})

console.log('\n=== 2. 注册工具 ===')
plugin.apply(ctx, { projectDir: PROJECT, pythonPath: '', autoStart: false, requestTimeoutMs: 90000 })

const byName = new Map(registered.map((tool) => [tool.name, tool]))
await check('注册了 6 个工具', () => {
  assert.deepEqual(
    [...byName.keys()].sort(),
    ['wechat_control', 'wechat_recent', 'wechat_send', 'wechat_sessions', 'wechat_status', 'wechat_stickers'],
  )
})
await check('每个工具都有 output.render', () => {
  for (const tool of registered) {
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} 缺 render`)
    assert.equal(tool.output.schema?.type, 'object', `${tool.name} 缺 schema`)
  }
})
await check('必填参数都标了 required', () => {
  assert.equal(byName.get('wechat_control').parameters.action.required, true)
  assert.equal(byName.get('wechat_send').parameters.to.required, true)
  assert.equal(byName.get('wechat_recent').parameters.chat.required, true)
})

console.log('\n=== 3. 真跑桥进程 ===')
const status = await byName.get('wechat_status').execute({}, {})
await check('wechat_status 成功', () => {
  assert.equal(status.ok, true, status.text)
})
await check('状态里带表情库张数', () => {
  assert.match(status.text, /表情库：\d+ 张/)
})
await check('状态里明确「发送引擎未连接」', () => {
  assert.match(status.text, /发送引擎：未连接/)
})

const stickers = await byName.get('wechat_stickers').execute({ query: '跪' }, {})
await check('wechat_stickers 能按关键词过滤', () => {
  assert.equal(stickers.ok, true, stickers.text)
  assert.match(stickers.text, /跪下/)
})

const control = await byName.get('wechat_control').execute({ action: 'stop' }, {})
await check('wechat_control stop 幂等', () => {
  assert.equal(control.ok, true, control.text)
  assert.match(control.text, /本来就没在监听/)
})

const badSend = await byName.get('wechat_send').execute({ kind: 'text', to: '文件传输助手', text: '   ' }, {})
await check('空文本发送被拦下', () => {
  assert.equal(badSend.ok, false)
  assert.match(badSend.text, /不能为空/)
})

const stickerMiss = await byName.get('wechat_send').execute({ kind: 'sticker', to: '文件传输助手', keyword: '不存在的词' }, {})
await check('匹配不到表情时给出原因', () => {
  assert.equal(stickerMiss.ok, false)
  assert.match(stickerMiss.text, /没发出去|没有匹配/)
})

console.log('\n=== 4. 卸载 ===')
for (const dispose of disposers) dispose()
await check('卸载后桥进程会自己退出', async () => {
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*dsh_bridge.py*' }).Count"],
    { encoding: 'utf8' }).trim()
  assert.equal(out, '0', `还有 ${out} 个桥进程没退出`)
})

const failed = results.filter(([ok]) => !ok)
fs.rmSync(TMP, { recursive: true, force: true })
console.log()
if (failed.length > 0) {
  console.log(`失败 ${failed.length} 项`)
  console.log('--- 插件日志 ---')
  for (const [level, line] of logs) console.log(`${level}: ${line}`)
  process.exitCode = 1
} else {
  console.log(`全部通过（${results.length} 项）`)
}
