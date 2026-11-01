/**
 * 测试用桩：只实现本插件用到的那几个 schemastery 方法。
 *
 * 真货由 DSH 宿主在运行时提供（peerDependency）。这里造假只是为了能在没有
 * DSH 的情况下跑 `node test/smoke.mjs`，验证插件自身的逻辑。
 */
function chain(defaultValue) {
  const api = {
    __default: defaultValue,
    default(value) {
      return chain(value)
    },
    description() {
      return api
    },
    step() {
      return api
    },
    min() {
      return api
    },
    max() {
      return api
    },
    required() {
      return api
    },
    toString() {
      return `[schema ${JSON.stringify(defaultValue)}]`
    },
  }
  return api
}

export const z = {
  string: () => chain(''),
  number: () => chain(0),
  boolean: () => chain(false),
  object: (shape) => ({ __shape: shape, default: (v) => chain(v) }),
}

export default z
