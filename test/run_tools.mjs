// run_tools.mjs — 端到端执行 3 个工具并校验返回值与 output.schema 完全一致
// （与 DSH 工具注册表的要求一致：additionalProperties=false 的对象不允许多余字段）
// 运行: node test/run_tools.mjs
import { pathToFileURL } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(ROOT, 'demo', 'demo_credit_data.csv')
const TMP = join(ROOT, 'demo', 'e2e_out')

const mod = await import(pathToFileURL(join(ROOT, 'src', 'index.js')).href)

let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const defs = {}
const ctx = {
  get(name) {
    if (name === 'tools') return { register: (d) => { defs[d.name] = d } }
    if (name === 'skills') return { register: () => {} }
    return undefined
  },
  logger: { info: () => {}, warn: () => {} },
}
mod.apply(ctx, {})

/** 迷你 JSON Schema 校验（覆盖 DSH 使用的子集：type/properties/required/additionalProperties/items/enum） */
function validate(schema, value, path = '$') {
  if (schema.type === 'object' || (!schema.type && value && typeof value === 'object' && !Array.isArray(value))) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} 期望 object`
    if (schema.properties) {
      for (const k of schema.required || []) if (!(k in value)) return `${path}.${k} 缺失（required）`
      for (const k of Object.keys(value)) {
        if (schema.properties[k]) {
          const e = validate(schema.properties[k], value[k], `${path}.${k}`)
          if (e) return e
        } else if (schema.additionalProperties === false) return `${path}.${k} 未声明且 additionalProperties=false`
      }
    } else if (schema.additionalProperties === false && Object.keys(value).length > 0) {
      return `${path} 闭对象出现未声明字段: ${Object.keys(value).join(',')}`
    }
    return null
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} 期望 array`
    if (schema.items) for (let i = 0; i < value.length; i++) {
      const e = validate(schema.items, value[i], `${path}[${i}]`)
      if (e) return e
    }
    return null
  }
  if (schema.type === 'string') return typeof value === 'string' ? null : `${path} 期望 string`
  if (schema.type === 'number') return typeof value === 'number' ? null : `${path} 期望 number`
  if (schema.type === 'integer') return Number.isInteger(value) ? null : `${path} 期望 integer`
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : `${path} 期望 boolean`
  if (schema.type === 'null') return value === null ? null : `${path} 期望 null`
  return null
}

// ── 1. rrd_profiling ──
const profiling = defs.rrd_profiling
const p1 = await profiling.execute({ dataset: DEMO, target: 'default_flag' })
let e1 = validate(profiling.output.schema, p1)
check('rrd_profiling 执行成功且 schema 校验通过', !e1, e1 || `推荐特征 ${p1.recommendedFeatures.slice(0, 6).join(',')}…`)
check('rrd_profiling 剔除 id/serialno', p1.autoExcluded.some((x) => /id|serialno/i.test(x.name)))
check('rrd_profiling y 含 column 字段', p1.y.column === 'default_flag' && p1.y.badRate > 0)

// ── 2. rrd_mining ──
const mining = defs.rrd_mining
const p2 = await mining.execute({
  dataset: DEMO, target: 'default_flag',
  features: p1.recommendedFeatures,
  generateReport: true, reportDir: TMP,
  title: '端到端测试报告',
})
let e2 = validate(mining.output.schema, p2)
check('rrd_mining 执行成功且 schema 校验通过', !e2, e2 || `最优 ${p2.combos.find((c) => c.isChosen)?.rules.join(' ∪ ')}`)
check('rrd_mining 生成 HTML 与快照', p2.report.generated && existsSync(p2.report.path) && existsSync(p2.snapshot.path))
check('rrd_mining f1 目标 + 全组合表', p2.selection.objective === 'f1' && p2.combos.length >= 5 && p2.prCurve.length >= p2.combos.length && p2.combos.every((c) => typeof c.inTopPct === 'boolean' && typeof c.f1 === 'number'), `${p2.selection.allComboCount} 组合 / 展示 ${p2.selection.displayedCount}`)
check('rrd_mining 最优组合含 P/R/F1', p2.final.rules.length >= 1 && p2.final.precision > 0 && p2.final.recall > 0 && p2.final.f1 > 0, `P=${(p2.final.precision * 100).toFixed(1)}% R=${(p2.final.recall * 100).toFixed(1)}% F1=${p2.final.f1.toFixed(3)}`)

// ── 3. rrd_report（基于快照重新生成）──
const report = defs.rrd_report
const p3 = await report.execute({ snapshot: p2.snapshot.path, title: '重新生成的报告', note: '备注测试' })
let e3 = validate(report.output.schema, p3)
check('rrd_report 执行成功且 schema 校验通过', !e3, e3)
check('rrd_report 重新生成 HTML', existsSync(p3.summary.reportPath) && readFileSync(p3.summary.reportPath, 'utf8').includes('重新生成的报告'))
check('rrd_report 备注写入报告', readFileSync(p3.summary.reportPath, 'utf8').includes('备注测试'))

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
