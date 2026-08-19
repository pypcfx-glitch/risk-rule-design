// smoke.mjs — 引擎 + 报告端到端冒烟测试（无需 dsh，纯 Node 运行）
// 运行: node test/smoke.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DEMO = join(ROOT, 'demo', 'demo_credit_data.csv')
const OUT = join(ROOT, 'demo', 'report')

const { parseCsv, profileDataset, mineRules } = await import(pathToFileURL(join(ROOT, 'src', 'engine.js')).href)
const { buildReport } = await import(pathToFileURL(join(ROOT, 'src', 'report.js')).href)

let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

if (!existsSync(DEMO)) {
  console.error('请先运行: node demo/make_demo_data.mjs demo/demo_credit_data.csv')
  process.exit(1)
}

const text = readFileSync(DEMO, 'utf8')
const dataset = parseCsv(text)
check('CSV 解析', dataset.headers.length >= 14 && dataset.columns[0].length >= 1000, `${dataset.headers.length} 列 × ${dataset.columns[0].length} 行`)

const profile = profileDataset(dataset, 'default_flag')
const badRate = profile.y.badRate
check('数据质检', profile.n === dataset.columns[0].length, `坏率 ${(badRate * 100).toFixed(2)}%`)
check('自动剔除无用特征', profile.autoExcluded.some((e) => /id|serialno/i.test(e.name)), profile.autoExcluded.map((e) => e.name).join(','))
check('推荐特征包含有效 X', profile.requestedFeatures.includes('credit_score') && profile.requestedFeatures.includes('region'))

const mining = mineRules(dataset, 'default_flag', profile.requestedFeatures)
const f = mining.final
const sel = mining.selection
check('组合搜索完成（f1 目标 + 逐层遍历树）', sel.objective === 'f1' && sel.allComboCount >= 10, `评估 ${sel.allComboCount} 个组合（branchMin=${sel.branchMin}）`)
check('全部组合展示 ≥10 个', mining.combos.length >= 10 && sel.displayedCount >= 10, `${mining.combos.length} 个（displayedCount=${sel.displayedCount}）`)
check('最优组合 F1 最大且 P/R 平衡', (() => {
  const chosen = mining.combos.find((c) => c.isChosen)
  const maxF1 = Math.max(...mining.combos.map((c) => c.f1))
  return chosen && Math.abs(chosen.f1 - maxF1) < 1e-6 && chosen.f1 > 0.3
})(), `最优 ${mining.combos.find((c) => c.isChosen)?.rules.join(' ∪ ')} F1=${f.f1.toFixed(3)}`)
check('组合表按 F1 降序', mining.combos.every((c, i) => i === 0 || mining.combos[i - 1].f1 >= c.f1 - 1e-9))
check('连续变量切分阈值可配置', JSON.stringify(mining.options.cutQuantiles) === JSON.stringify([1, 3, 5, 95, 97, 99]), mining.options.cutQuantiles.join(',') + '%')
check('组合 F1 优于最优单规则', (() => {
  const bestSingle = Math.max(...mining.combos.filter((c) => c.rules.length === 1).map((c) => c.f1))
  return f.f1 > bestSingle + 1e-6
})(), `组合 F1=${f.f1.toFixed(3)} vs 最优单规则 F1=${Math.max(...mining.combos.filter((c) => c.rules.length === 1).map((c) => c.f1)).toFixed(3)}`)
check('组合包含多条规则且 P/R 提升', f.rules.length >= 2 && f.precision > 0.3 && f.recall > 0.3, `${f.rules.length} 条，P=${(f.precision * 100).toFixed(1)}% R=${(f.recall * 100).toFixed(1)}%`)
check('累加规则 Lift 下降/命中率上升（正常现象）', f.rules.every((r, i) => i === 0 || (r.cumulative.hitRate >= f.rules[i - 1].cumulative.hitRate - 1e-9 && r.cumulative.lift <= f.rules[i - 1].cumulative.lift + 1e-6)), `${f.rules.length} 条`)
check('PR 曲线（全部组合）', mining.prCurve.length >= mining.combos.length, `${mining.prCurve.length} 点`)
check('单变量分析覆盖所有特征', mining.singleRules.length === profile.requestedFeatures.length, `${mining.singleRules.length} 个特征`)

const html = buildReport({
  profile,
  mining,
  meta: { datasetPath: DEMO, title: '演示数据集规则挖掘报告', note: '冒烟测试生成', generatedAt: new Date().toISOString() },
})
mkdirSync(OUT, { recursive: true })
const htmlPath = join(OUT, 'smoke_report.html')
writeFileSync(htmlPath, html, 'utf8')
check('HTML 报告生成', html.length > 20000 && html.includes('组合规则效果分析'), `${html.length} 字节`)
check('报告包含单变量分析', html.includes('单变量效果分析') && html.includes('credit_score'))
check('报告包含全部组合表（F1 列）', html.includes('全部组合评估表') && html.includes('>F1<'))
check('报告包含命中率×Lift 点位图', html.includes('全部组合点位') && html.includes('<svg'))
check('报告包含 PR 曲线', html.includes('精准率-召回率曲线'))
check('报告标注 F1 最高点（非 kneedle 拐点）', html.includes('F1 最高') && !html.includes('kneedle'))
check('报告包含切分阈值配置', html.includes('切分阈值'))
check('报告包含逐层遍历说明', html.includes('逐层遍历树') || html.includes('召回率无法提高'))

console.log(f.rules.map((r, i) => `  ${i + 1}. ${r.expression}  累计: 命中 ${(r.cumulative.hitRate * 100).toFixed(1)}% / Lift ${r.cumulative.lift.toFixed(2)}`).join('\n'))
console.log(`\n报告输出: ${htmlPath}`)
console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
