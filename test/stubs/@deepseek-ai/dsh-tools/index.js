/**
 * 测试用桩：真货由 DSH 宿主提供。
 *
 * 真实实现会在这里做参数校验、组装 schema、把 execute 接进执行流水线；
 * 对本插件的自测来说，能拿到定义对象、能直接调 execute 就够了。
 */
export function defineTool(definition) {
  if (typeof definition?.name !== 'string' || definition.name === '') {
    throw new Error('defineTool: name 必填')
  }
  if (typeof definition?.execute !== 'function') {
    throw new Error(`defineTool(${definition.name}): execute 必填`)
  }
  return definition
}
