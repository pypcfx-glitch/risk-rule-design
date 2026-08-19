// report.js — 生成自包含的 HTML 分析报告（零外部依赖，纯内联 CSS/SVG）
'use strict'

import { pct, esc } from './engine.js'

const STYLE = `
:root { --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --bg:#f8fafc; --card:#ffffff;
  --navy:#1e3a5f; --gold:#c9a227; --bad:#b91c1c; --good:#15803d; --accent:#2563eb; }
* { box-sizing:border-box; }
body { margin:0; font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif; color:var(--ink); background:var(--bg); line-height:1.6; }
.wrap { max-width:1080px; margin:0 auto; padding:32px 20px 64px; }
header.hero { background:linear-gradient(135deg, var(--navy) 0%, #2c5282 100%); color:#fff; border-radius:14px; padding:28px 32px; margin-bottom:28px; }
header.hero h1 { margin:0 0 6px; font-size:24px; }
header.hero .sub { opacity:.85; font-size:13px; }
.meta { display:flex; flex-wrap:wrap; gap:8px 24px; margin-top:14px; font-size:13px; }
.meta b { color:var(--gold); }
section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px 28px; margin-bottom:24px; }
h2 { font-size:19px; margin:0 0 4px; color:var(--navy); border-left:4px solid var(--gold); padding-left:10px; }
h2 .en { font-weight:400; color:var(--muted); font-size:13px; margin-left:8px; }
.sec-desc { color:var(--muted); font-size:13px; margin:4px 0 18px; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
.card { border:1px solid var(--line); border-radius:10px; padding:14px 16px; background:var(--bg); }
.card .k { font-size:12px; color:var(--muted); }
.card .v { font-size:22px; font-weight:700; margin-top:2px; }
.card .v.small { font-size:16px; }
.card .hint { font-size:11px; color:var(--muted); margin-top:2px; }
table { width:100%; border-collapse:collapse; font-size:13px; margin-top:10px; }
th,td { padding:8px 10px; text-align:right; border-bottom:1px solid var(--line); white-space:nowrap; }
th:first-child,td:first-child { text-align:left; }
thead th { background:var(--bg); color:var(--muted); font-weight:600; position:sticky; top:0; }
tr:hover td { background:#f9fafb; }
.num { font-variant-numeric:tabular-nums; }
.bad-tag { color:var(--bad); font-weight:600; }
.good-tag { color:var(--good); font-weight:600; }
.tag { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; border:1px solid var(--line); background:#fff; }
.tag.drop { color:var(--bad); border-color:#fecaca; background:#fef2f2; }
.tag.keep { color:var(--good); border-color:#bbf7d0; background:#f0fdf4; }
.bar-row { display:grid; grid-template-columns:150px 1fr 90px; align-items:center; gap:8px; margin:6px 0; font-size:12px; }
.bar-track { background:var(--line); border-radius:4px; height:14px; overflow:hidden; }
.bar-fill { height:100%; border-radius:4px; }
.bar-fill.hit { background:#93c5fd; }
.bar-fill.bad { background:#f87171; }
.bar-label { color:var(--muted); text-align:right; font-variant-numeric:tabular-nums; }
.issue { display:flex; gap:10px; padding:6px 0; border-bottom:1px dashed var(--line); font-size:13px; }
.issue .lvl { flex:0 0 46px; text-align:center; border-radius:6px; font-size:11px; padding:1px 0; height:fit-content; }
.lvl.warn { background:#fef3c7; color:#92400e; }
.lvl.info { background:#e0e7ff; color:#3730a3; }
.feat-block { border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:14px 0; }
.feat-head { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:4px 12px; }
.feat-head .fname { font-weight:700; font-size:15px; color:var(--navy); }
.feat-head .fstats { font-size:12px; color:var(--muted); }
.final-box { border:2px solid var(--gold); border-radius:12px; padding:20px 22px; margin:16px 0; background:linear-gradient(180deg,#fffdf5,#fff); }
.final-box .rule-item { border-bottom:1px dashed var(--line); padding:12px 0; }
.final-box .rule-item:last-child { border-bottom:none; }
.rule-expr { font-family:Consolas,Menlo,monospace; font-size:14px; color:var(--navy); font-weight:600; }
.rule-step { font-size:12px; color:var(--muted); margin-top:4px; }
.gain { color:var(--bad); font-weight:600; }
.legend { font-size:12px; color:var(--muted); margin:8px 0; }
.note { background:#fefce8; border:1px solid #fde68a; border-radius:8px; padding:12px 16px; font-size:13px; color:#713f12; margin-top:14px; }
footer { color:var(--muted); font-size:12px; text-align:center; margin-top:24px; }
svg text { font-family:inherit; }
`

const BAR = (key, v, max, cls, fmtFn) => `
  <div class="bar-row"><span></span>
    <div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.max(1, Math.min(100, (v / max) * 100))}%"></div></div>
    <div class="bar-label">${fmtFn(v)}</div>
  </div>`

/** 命中率-Lift 散点图：展示 top5% 组合点位，最优高亮 */
function liftScatter(combos) {
  const W = 640, H = 380, padL = 56, padB = 44, padT = 16, padR = 20
  const maxX = Math.max(0.1, ...combos.map((p) => p.hitRate)) * 1.15
  const maxY = Math.max(1.2, ...combos.map((p) => p.lift)) * 1.15
  const X = (h) => padL + (h / maxX) * (W - padL - padR)
  const Y = (lift) => padT + (1 - lift / maxY) * (H - padT - padB)
  let grid = ''
  for (let g = 0; g <= 4; g++) {
    const h = (maxX / 4) * g, x = X(h)
    grid += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="#e5e7eb" stroke-dasharray="3 3"/><text x="${x}" y="${H - padB + 16}" text-anchor="middle" font-size="10" fill="#6b7280">${(h * 100).toFixed(1)}%</text>`
    const l = (maxY / 4) * g, y = Y(l)
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e5e7eb" stroke-dasharray="3 3"/><text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="#6b7280">${l.toFixed(1)}</text>`
  }
  const dots = combos.map((p) => {
    const chosen = p.isChosen
    return `<circle cx="${X(p.hitRate)}" cy="${Y(p.lift)}" r="${chosen ? 7 : 4.5}" fill="${chosen ? '#c9a227' : '#93c5fd'}" stroke="${chosen ? '#8a6d1a' : '#2563eb'}" stroke-width="${chosen ? 2.5 : 1}">
      <title>${esc(p.rules.join(' ∪ '))}：命中率 ${pct(p.hitRate)}，Lift ${p.lift.toFixed(2)}${chosen ? '（最优）' : ''}</title></circle>`
  }).join('')
  return `
  <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:680px;display:block;margin:0 auto;">
    ${grid}${dots}
    <text x="${padL + (W - padL - padR) / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#374151">命中率（通过率减少）→</text>
    <text x="14" y="${padT + (H - padT - padB) / 2}" text-anchor="middle" font-size="11" fill="#374151" transform="rotate(-90 14 ${padT + (H - padT - padB) / 2})">Lift →</text>
  </svg>`
}

/**
 * 精准率-召回率曲线（全部组合），标注 F1 最高点（即最优组合对应的点）。
 * @param prCurve - 按召回率升序的点 { recall, precision }
 * @param best - 最优组合的坐标 { recall, precision, f1 }
 */
function prCurveSvg(prCurve, best) {
  const W = 640, H = 380, padL = 56, padB = 44, padT = 16, padR = 20
  const X = (r) => padL + r * (W - padL - padR)
  const Y = (p) => padT + (1 - p) * (H - padT - padB)
  let grid = ''
  for (let g = 0; g <= 4; g++) {
    const r = g / 4, x = X(r)
    grid += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="#e5e7eb" stroke-dasharray="3 3"/><text x="${x}" y="${H - padB + 16}" text-anchor="middle" font-size="10" fill="#6b7280">${(r * 100).toFixed(0)}%</text>`
    const p = g / 4, y = Y(p)
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e5e7eb" stroke-dasharray="3 3"/><text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="#6b7280">${(p * 100).toFixed(0)}%</text>`
  }
  const line = prCurve.map((pt, i) => `${i === 0 ? 'M' : 'L'}${X(pt.recall).toFixed(1)},${Y(pt.precision).toFixed(1)}`).join(' ')
  const dots = prCurve.map((pt) => `<circle cx="${X(pt.recall)}" cy="${Y(pt.precision)}" r="4.5" fill="#93c5fd" stroke="#2563eb" stroke-width="1">
    <title>召回率 ${pct(pt.recall)}，精准率 ${pct(pt.precision)}</title></circle>`).join('')
  // F1 最高点 = 最优组合对应的点（与命中率×Lift 点位图中的最优高亮一致）
  const bx = Math.max(0, Math.min(1, best.recall)), by = Math.max(0, Math.min(1, best.precision))
  const bestMark = `<circle cx="${X(bx)}" cy="${Y(by)}" r="9" fill="none" stroke="#c9a227" stroke-width="2.5"/>
    <circle cx="${X(bx)}" cy="${Y(by)}" r="5" fill="#c9a227"/>
    <text x="${X(bx) + 12}" y="${Y(by) - 8}" font-size="11" fill="#8a6d1a">F1 最高 · 最优</text>`
  return `
  <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:680px;display:block;margin:0 auto;">
    ${grid}<path d="${line}" fill="none" stroke="#2563eb" stroke-width="2"/>${dots}${bestMark}
    <text x="${padL + (W - padL - padR) / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#374151">召回率（Recall）→</text>
    <text x="14" y="${padT + (H - padT - padB) / 2}" text-anchor="middle" font-size="11" fill="#374151" transform="rotate(-90 14 ${padT + (H - padT - padB) / 2})">精准率（Precision）→</text>
  </svg>`
}

/** 组装完整 HTML 报告 */
export function buildReport({ profile, mining, meta }) {
  const { n, columns, target, y, autoExcluded, requestedFeatures, duplicateRows, issues } = profile
  const { singleRules, final, options, combos, selection, prCurve, consideredCandidates } = mining
  const { datasetPath, title, note, generatedAt } = meta
  const passRate = 1 - final.hitRate

  const colRows = columns.map((s) => {
    const status = s.dropReason
      ? `<span class="tag drop">剔除 · ${esc(s.dropReason)}</span>`
      : `<span class="tag keep">保留</span>`
    return `<tr><td>${esc(s.name)}</td><td class="num">${s.type === 'numeric' ? '数值' : '分类'}</td>
      <td class="num">${s.missingRate > 0 ? pct(s.missingRate) : '—'}</td>
      <td class="num">${s.cardinality}</td><td>${status}</td></tr>`
  }).join('')

  const issueRows = issues.map((i) =>
    `<div class="issue"><span class="lvl ${i.level}">${i.level === 'warn' ? '警告' : '提示'}</span><span>${esc(i.message)}</span></div>`
  ).join('')

  const featBlocks = singleRules.map((pf) => {
    const stats = columns.find((c) => c.name === pf.feature)
    const rows = pf.rules.map((r) => {
      const liftBar = BAR('lift', r.lift, Math.max(2, ...pf.rules.map((x) => x.lift)) * 1.05, 'hit', (v) => `${v.toFixed(2)}x`)
      return `<tr><td><span class="rule-expr">${esc(r.expression)}</span></td>
        <td class="num">${r.hitRate !== null ? pct(r.hitRate) : '—'}</td>
        <td class="num ${r.badRateHit > y.badRate ? 'bad-tag' : ''}">${pct(r.badRateHit)}</td>
        <td class="num ${r.lift > 1 ? 'bad-tag' : ''}">${r.lift.toFixed(2)}</td>
        <td class="num">${r.iv.toFixed(3)}</td></tr>`
    }).join('')
    const fstats = stats
      ? `类型：${stats.type === 'numeric' ? '数值' : '分类'} · 缺失率：${stats.missingRate > 0 ? pct(stats.missingRate) : '—'} · 基数：${stats.cardinality}`
      : ''
    const maxLift = Math.max(1.01, ...pf.rules.map((r) => r.lift))
    const bars = pf.rules.slice(0, 6).map((r) => `
      <div style="margin-top:8px">
        <div style="font-family:Consolas,Menlo,monospace;font-size:12px;color:#374151;margin-bottom:2px">${esc(r.expression)}</div>
        ${BAR('lift', r.lift, maxLift * 1.05, 'hit', (v) => `Lift ${v.toFixed(2)}`)}
        ${BAR('bad', r.badRateHit, Math.max(y.badRate, ...pf.rules.map((x) => x.badRateHit)) * 1.05, 'bad', (v) => `坏率 ${pct(v)}`)}
      </div>`).join('')
    return `
    <div class="feat-block">
      <div class="feat-head"><span class="fname">${esc(pf.feature)}</span><span class="fstats">${fstats}</span></div>
      ${pf.rules.length === 0 ? '<div style="color:var(--muted);font-size:12px;margin-top:6px">未挖掘到满足约束的候选规则</div>' : ''}
      ${bars}
      ${pf.rules.length === 0 ? '' : `<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--muted)">完整候选规则表</summary>
      <table><thead><tr><th>规则</th><th>命中率</th><th>命中坏率</th><th>Lift</th><th>IV</th></tr></thead><tbody>${rows}</tbody></table></details>`}
    </div>`
  }).join('')

  const stepRows = final.rules.map((r, i) => `
    <tr><td>${i + 1}</td><td><span class="rule-expr">${esc(r.expression)}</span></td>
      <td class="num">${pct(r.single.hitRate)}</td><td class="num">${r.single.lift.toFixed(2)}</td>
      <td class="num">${pct(r.cumulative.hitRate)}</td>
      <td class="num ${r.cumulative.lift > 1 ? 'bad-tag' : ''}">${r.cumulative.lift.toFixed(2)}</td>
      <td class="num">${pct(r.cumulative.badCoverage)}</td>
      <td class="num gain">${r.marginalGain.dHitRate >= 0 ? '+' : ''}${pct(r.marginalGain.dHitRate)} / ${r.marginalGain.dLift >= 0 ? '+' : ''}${r.marginalGain.dLift.toFixed(2)}</td></tr>
  `).join('')

  const ruleSteps = final.rules.map((r, i) => `
    <div class="rule-item">
      <div class="rule-expr">${i + 1}. ${esc(r.expression)}</div>
      <div class="rule-step">单规则：命中率 ${pct(r.single.hitRate)}，Lift ${r.single.lift.toFixed(2)}　·　
        累计：命中率 ${pct(r.cumulative.hitRate)}，命中坏率 ${pct(r.cumulative.badRateHit)}，Lift ${r.cumulative.lift.toFixed(2)}，坏样本覆盖率 ${pct(r.cumulative.badCoverage)}　·　
        边际增益：${r.marginalGain.dHitRate >= 0 ? '+' : ''}${pct(r.marginalGain.dHitRate)} 命中率 / ${r.marginalGain.dLift >= 0 ? '+' : ''}${r.marginalGain.dLift.toFixed(2)} Lift</div>
    </div>`).join('')

  const consideredRows = consideredCandidates.map((c) => `
    <tr><td><span class="rule-expr">${esc(c.expression)}</span></td>
      <td class="num">${pct(c.hitRate)}</td><td class="num">${c.lift.toFixed(2)}</td>
      <td>${c.selected ? '<span class="tag keep">入选</span>' : '<span class="tag">候选</span>'}</td></tr>`).join('')

  const comboRows = combos.map((c) => `
    <tr${c.isChosen ? ' style="background:#fffbe6"' : ''}><td class="num">${c.rank}</td>
      <td><span class="rule-expr" style="font-size:12px">${esc(c.rules.join(' ∪ '))}</span></td>
      <td class="num ${c.precision > y.badRate ? 'bad-tag' : ''}">${pct(c.precision)}</td>
      <td class="num">${pct(c.recall)}</td>
      <td class="num bad-tag">${c.f1.toFixed(3)}</td>
      <td class="num">${pct(c.hitRate)}</td>
      <td class="num ${c.lift > 1 ? 'bad-tag' : ''}">${c.lift.toFixed(2)}</td>
      <td>${selection.topCount > 0 && c.inTopPct ? '<span class="tag" style="border-color:#c9a227;background:#fffbe6">⭐top5%</span>' : '<span class="tag">—</span>'}</td>
      <td>${c.isChosen ? '<span class="tag keep">✓ 最优</span>' : ''}</td></tr>`).join('')

  const optRows = [
    ['目标变量（y）', esc(target)],
    ['参与特征数（X）', `${requestedFeatures.length} 个：${esc(requestedFeatures.join('、'))}`],
    ['样本量', `${n.toLocaleString()} 行`],
    ['全局坏样本率', pct(y.badRate)],
    ['组合评估目标', {
      f1: 'f1（精准率与召回率最平衡且都大，F1 最大）',
      top_lift: `top_lift（所有组合按 Lift 降序，取前 ${pct(selection.topLiftPct)}（至少 ${selection.topLiftMin} 个）内命中率最小者）`,
      composite: 'composite（lift × (1−命中率) 最大）',
      max_lift: 'max_lift（预算内最大化 lift）',
      min_hit: 'min_hit（lift 达标下最小化命中率）',
    }[options.objective] || options.objective],
    ['挖掘流程（逐层遍历树）', `第一条规则：单规则 Lift 前 ${pct(selection.topLiftPct)}（至少 ${selection.topLiftMin} 个）轮番作种子；之后每层取对当前组合增益前 ${pct(selection.branchPct)}（至少 ${selection.branchMin} 个）的规则遍历组合；停止条件 = 召回率无法提高`],
    ['评估组合数', `${selection.allComboCount} 个（展示 ${selection.displayedCount} 个）`],
    ['约束', `minSupport=${options.minSupport}，minLift=${options.minLift}，hitRateBudget=${options.hitRateBudget}${options.minBadCoverage > 0 ? `，minBadCoverage=${options.minBadCoverage}` : ''}，maxRules=${options.maxRules}`],
    ['连续变量切分阈值', `分位数 ${options.cutQuantiles.join('% / ')}%（每个阈值遍历选小/选大两个方向）`],
    ['候选规则池', `${options.candidateCount} 条（每特征最多 ${options.maxRulesPerFeature} 条）`],
    ['搜索抽样', options.downsampled ? '是（大样本，最终指标在全体数据上精确重算）' : '否（全体数据）'],
  ].map(([k, v]) => `<tr><td>${k}</td><td style="text-align:left">${v}</td></tr>`).join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <h1>${esc(title)}</h1>
    <div class="sub">风控规则挖掘分析报告 · Risk Rule Design · risk_rule_design 插件</div>
    <div class="meta">
      <span>数据源：<b>${esc(datasetPath)}</b></span>
      <span>生成时间：<b>${esc(generatedAt)}</b></span>
      <span>样本量：<b>${n.toLocaleString()}</b></span>
      <span>全局坏率：<b>${pct(y.badRate)}</b></span>
    </div>
  </header>

  <section>
    <h2>一、数据集与质量检查<span class="en">Dataset & Quality</span></h2>
    <div class="sec-desc">确认 X / y，剔除无用特征（ID、序号、常量、近似唯一列等）并完成质量检查。</div>
    <div class="cards">
      <div class="card"><div class="k">样本行数</div><div class="v">${n.toLocaleString()}</div></div>
      <div class="card"><div class="k">字段总数（含 y）</div><div class="v">${columns.length + 1}</div></div>
      <div class="card"><div class="k">全局坏样本率</div><div class="v small bad-tag">${pct(y.badRate)}</div><div class="hint">坏样本 ${y.badCount.toLocaleString()} / 好样本 ${y.goodCount.toLocaleString()}</div></div>
      <div class="card"><div class="k">重复行</div><div class="v small">${duplicateRows.toLocaleString()}</div></div>
      <div class="card"><div class="k">自动剔除字段</div><div class="v small">${autoExcluded.length}</div><div class="hint">${esc(autoExcluded.map((e) => e.name).join('、') || '无')}</div></div>
      <div class="card"><div class="k">参与规则挖掘的特征</div><div class="v small">${requestedFeatures.length}</div></div>
    </div>
    <h3 style="font-size:15px;color:var(--navy);margin:22px 0 4px">字段清单与处理决策</h3>
    <table>
      <thead><tr><th>字段</th><th>类型</th><th>缺失率</th><th>基数</th><th>处理</th></tr></thead>
      <tbody>${colRows}</tbody>
    </table>
    ${issueRows.length ? `<h3 style="font-size:15px;color:var(--navy);margin:22px 0 4px">质量检查问题</h3>${issueRows}` : ''}
  </section>

  <section>
    <h2>二、单变量效果分析<span class="en">Univariate Rule Analysis</span></h2>
    <div class="sec-desc">对每个特征挖掘候选规则：命中率（= 通过率减少）、命中样本坏率、Lift（命中坏浓度 / 全局坏率）、IV。仅展示满足 minSupport / minLift 约束的规则。</div>
    ${featBlocks}
  </section>

  <section>
    <h2>三、组合规则效果分析<span class="en">Combined Rule Analysis</span></h2>
    <div class="sec-desc">规则集为<b>并行（OR）</b>语义：命中任一规则即拒绝。连续变量按切分阈值（分位数 ${options.cutQuantiles.join('/')}%，每个阈值尝试「选小 / 选大」两个方向）遍历挖掘。<br/>
    <b>挖掘流程（逐层遍历树）</b>：第一条规则 = 单规则 Lift 前 ${pct(selection.topLiftPct)}（至少 ${selection.topLiftMin} 个）<b>轮番作种子</b>；之后每层选取对当前组合<b>增益效果</b>前 ${pct(selection.branchPct)}（至少 ${selection.branchMin} 个）的规则<b>遍历组合</b>；<b>停止条件 = 召回率无法提高</b>。<br/>
    <b>评估标准（默认 f1）</b>：全部评估组合（${selection.allComboCount} 个）中，<b>精准率与召回率最平衡且都大（F1 最大）</b>的组合为最优。下方表格与两张图展示<b>全部组合</b>（按 F1 降序）。</div>
    <div class="cards">
      <div class="card"><div class="k">精准率 Precision</div><div class="v bad-tag">${pct(final.precision)}</div><div class="hint">命中样本坏浓度 · 全局 ${pct(y.badRate)}</div></div>
      <div class="card"><div class="k">召回率 Recall</div><div class="v bad-tag">${pct(final.recall)}</div><div class="hint">捕获坏样本占比</div></div>
      <div class="card"><div class="k">F1（平衡度）</div><div class="v bad-tag">${final.f1.toFixed(3)}</div></div>
      <div class="card"><div class="k">命中率（通过率减少）</div><div class="v bad-tag">${pct(final.hitRate)}</div><div class="hint">通过率 ${pct(passRate)}</div></div>
      <div class="card"><div class="k">组合 Lift</div><div class="v bad-tag">${final.lift.toFixed(2)}x</div></div>
      <div class="card"><div class="k">拒绝样本数</div><div class="v small">${final.rejected.toLocaleString()}</div><div class="hint">其中坏样本 ${final.badCount.toLocaleString()}</div></div>
    </div>
    ${final.coverageMet ? '' : `<div class="note" style="margin-top:12px">⚠️ 组合召回率 ${pct(final.recall)} 未达到设定的 minBadCoverage=${pct(options.minBadCoverage)} 目标：请放宽该目标、补充更有区分度的特征，或降低 hitRateBudget 再试。</div>`}

    <div class="final-box">
      <h3 style="margin:0 0 6px;font-size:16px;color:var(--navy)">最优组合规则（按命中顺序）</h3>
      ${ruleSteps}
      <div class="note">并行（OR）应用：命中以下任一规则的样本直接拒绝（或进入人工审核），其余样本通过。<br/>
      评估标准（${options.objective === 'f1' ? '<b>f1（默认）</b>' : options.objective}）：全部组合中<b>精准率与召回率最平衡且都大（F1 最大）</b>者为最优。<br/>
      注：第一条规则 Lift 区分度最好，累加后续规则后组合累积 Lift 会逐渐下降、命中率逐渐提升，属正常现象——组合的价值在于<b>更平衡的精准率×召回率</b>。</div>
    </div>

    <h3 style="font-size:15px;color:var(--navy);margin:18px 0 4px">组合累积效果明细</h3>
    <table>
      <thead><tr><th>顺序</th><th>规则</th><th>单规则命中率</th><th>单规则 Lift</th><th>累计命中率</th><th>累计 Lift</th><th>累计召回率</th><th>边际增益(Δ命中率 / ΔLift)</th></tr></thead>
      <tbody>${stepRows}</tbody>
    </table>

    <h3 style="font-size:15px;color:var(--navy);margin:22px 0 4px">全部组合评估表（${selection.displayedCount} 个 · 按 F1 降序）</h3>
    <div class="legend">展示<b>全部</b>评估组合（${selection.allComboCount} 个${selection.displayedCount < selection.allComboCount ? `，此处展示 F1 前 ${selection.displayedCount} 个` : ''}）的精准率 / 召回率 / F1 / 命中率 / Lift。<br/>
    评估目标：${options.objective === 'f1' ? '<b>F1 最大</b>（精准率×召回率最平衡且都大）' : options.objective}，最优为金色行。${selection.topCount > 0 ? `（⭐top5% = Lift 前 ${selection.topCount} 个，仅 top_lift 目标使用）` : ''}</div>
    <table>
      <thead><tr><th>排名</th><th>组合规则（并行 OR）</th><th>精准率</th><th>召回率</th><th>F1</th><th>命中率</th><th>Lift</th><th>区间</th><th>最优</th></tr></thead>
      <tbody>${comboRows}</tbody>
    </table>

    <h3 style="font-size:15px;color:var(--navy);margin:22px 0 4px">全部组合点位：命中率 × Lift</h3>
    <div class="legend">全部评估组合的命中率（通过率减少）与 Lift 点位（蓝色）；金色圆点为最优组合（F1 最大）。<br/>可见累加规则后点位沿「命中率 ↑、Lift ↓」方向移动（正常现象）。</div>
    ${liftScatter(combos)}

    <h3 style="font-size:15px;color:var(--navy);margin:22px 0 4px">全部组合：精准率-召回率曲线（F1 最高点 = 最优组合）</h3>
    <div class="legend">全部评估组合按召回率升序的精准率-召回率曲线；<b>金色圆点为 F1 最高的点</b>（即最优组合对应的点，与命中率×Lift 点位图中的最优高亮一致）——精准率与召回率最平衡的位置，而非曲线的拐点。</div>
    ${prCurveSvg(prCurve, { recall: final.recall, precision: final.precision })}

    <h3 style="font-size:15px;color:var(--navy);margin:22px 0 4px">候选规则池与入选情况</h3>
    <table>
      <thead><tr><th>规则</th><th>命中率</th><th>Lift</th><th>状态</th></tr></thead>
      <tbody>${consideredRows}</tbody>
    </table>
  </section>

  <section>
    <h2>附录：分析配置<span class="en">Configuration</span></h2>
    <table><tbody>${optRows}</tbody></table>
    ${note ? `<div class="note">${esc(note)}</div>` : ''}
  </section>

  <footer>由 risk_rule_design 插件生成 · 挖掘方法：连续变量阈值遍历（1/3/5/95/97/99 分位）+ 逐层遍历树（种子轮番 + 增益 top5% 遍历 + 召回率停止），评估标准：F1 最大（精准率×召回率平衡）</footer>
</div>
</body>
</html>`
}

function factorial(k) {
  let r = 1
  for (let i = 2; i <= k; i++) r *= i
  return r
}
