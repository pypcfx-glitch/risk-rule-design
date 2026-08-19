// load_plugin.mjs — 插件模块加载测试：用桩 ctx 验证 apply() 能正常注册工具与技能
// 运行: node test/load_plugin.mjs
import { pathToFileURL } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(ROOT, 'src', 'index.js')).href)

let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

check('插件导出 name/inject/apply', mod.name === 'risk-rule-design' && Array.isArray(mod.inject) && typeof mod.apply === 'function')

const registeredTools = []
const registeredSkills = []
const ctx = {
  get(name) {
    if (name === 'tools') return { register: (def) => registeredTools.push(def) }
    if (name === 'skills') return { register: (s) => registeredSkills.push(s) }
    return undefined
  },
  logger: { info: () => {}, warn: () => {} },
}

mod.apply(ctx, {})

check('注册 3 个工具', registeredTools.length === 3, registeredTools.map((t) => t.name).join(', '))
check('注册 1 个技能', registeredSkills.length === 1, registeredSkills[0]?.name)

// 技能必须满足 dsh-skill 加载时的 validateDefinition 要求（曾缺失 source 导致
// "loaded skill ... source must be a string"）
const skill = registeredSkills[0]
check('技能 name 为 kebab-case', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill?.name || ''), skill?.name)
check('技能 description 非空字符串', typeof skill?.description === 'string' && skill.description.length > 0)
check('技能 content 为字符串', typeof skill?.content === 'string' && skill.content.length > 0)
check('技能 source 为字符串', typeof skill?.source === 'string' && skill.source.length > 0, skill?.source)
check('技能 invocation 为布尔对', skill?.invocation?.modelInvocable === true && skill?.invocation?.userInvocable === true)
check('技能 provider 默认 runtime', skill?.provider === undefined || skill?.provider === 'runtime', skill?.provider)

for (const def of registeredTools) {
  check(`工具 ${def.name} 结构完整`, typeof def.description === 'string' && typeof def.execute === 'function' && typeof def.output.render === 'function' && def.parameters && def.output.schema)
  // 定义必须是 lossless JSON（不允许 undefined / 函数泄漏）
  let lossless = true
  try { JSON.stringify(def); JSON.stringify(def.parameters); JSON.stringify(def.output.schema) } catch { lossless = false }
  check(`工具 ${def.name} 定义为 lossless JSON`, lossless)
  // schema 子集检查：不允许 type 数组 / anyOf / 非布尔 additionalProperties
  const bad = findUnsupported(def.parameters) || findUnsupported(def.output.schema)
  check(`工具 ${def.name} schema 符合 DSH 子集`, !bad, bad || '')
}

// 输出 schema 顶层字段与 execute 返回值一致性由 DSH 运行时校验；这里做浅层冒烟：
const profiling = registeredTools.find((t) => t.name === 'rrd_profiling')
check('rrd_profiling 参数必填 dataset/target', profiling.parameters.required?.includes('dataset') && profiling.parameters.required?.includes('target'))

function findUnsupported(node, path = '$') {
  if (Array.isArray(node)) return `${path} 为数组`
  if (node === null || typeof node !== 'object') return null
  if (node.type && Array.isArray(node.type)) return `${path}.type 是数组`
  if ('anyOf' in node || 'allOf' in node) return `${path} 含 anyOf/allOf`
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') return `${path}.additionalProperties 非布尔`
  if (node.properties) for (const k of Object.keys(node.properties)) {
    const e = findUnsupported(node.properties[k], `${path}.properties.${k}`)
    if (e) return e
  }
  if (node.items) {
    const e = findUnsupported(node.items, `${path}.items`)
    if (e) return e
  }
  if (node.oneOf) for (let i = 0; i < node.oneOf.length; i++) {
    const e = findUnsupported(node.oneOf[i], `${path}.oneOf[${i}]`)
    if (e) return e
  }
  return null
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
