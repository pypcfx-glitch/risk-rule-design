// engine.js — 风控规则挖掘引擎（纯逻辑，零依赖，可在任意 Node 环境运行）
// 包含：CSV 解析、数据类型推断、数据质量检查、单规则挖掘、并行规则组合最优搜索（遍历规则先后顺序）。

'use strict'

// ─────────────────────────── 小工具 ───────────────────────────

/** 16-bit 布特计数表（用于 bitset 快速 popcount） */
const POP16 = (() => {
  const t = new Uint8Array(65536)
  for (let i = 0; i < 65536; i++) {
    let x = i, c = 0
    while (x) { x &= x - 1; c++ }
    t[i] = c
  }
  return t
})()

/** 紧凑位集：每个样本占 1 bit，支持 or / count / andCount，用于并行规则命中集合的快速计算 */
class Bits {
  constructor(n) {
    this.n = n
    this.words = new Uint32Array((n + 31) >>> 5)
  }
  set(i) { this.words[i >>> 5] |= (1 << (i & 31)) >>> 0 }
  copy() {
    const b = new Bits(this.n)
    b.words.set(this.words)
    return b
  }
  orInPlace(other) {
    const a = this.words, b = other.words
    for (let i = 0; i < a.length; i++) a[i] |= b[i]
    return this
  }
  count() {
    let c = 0
    const a = this.words
    for (let i = 0; i < a.length; i++) {
      const w = a[i]
      c += POP16[w & 0xffff] + POP16[w >>> 16]
    }
    return c
  }
  /** 与另一集合的交集元素个数 */
  andCount(other) {
    let c = 0
    const a = this.words, b = other.words
    for (let i = 0; i < a.length; i++) {
      const w = a[i] & b[i]
      c += POP16[w & 0xffff] + POP16[w >>> 16]
    }
    return c
  }
}

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`
const fmt = (x, d = 4) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))

function quantile(sorted, p) {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function lowerBound(arr, v) { // 第一个 >= v 的下标
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] < v) lo = mid + 1; else hi = mid
  }
  return lo
}

function upperBound(arr, v) { // 第一个 > v 的下标
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] <= v) lo = mid + 1; else hi = mid
  }
  return lo
}

// ─────────────────────────── CSV 解析 ───────────────────────────

/**
 * 解析 CSV 文本（支持引号、转义引号、引号内逗号/换行、CRLF、BOM）。
 * 返回 { headers, columns }，columns 为**按列**的原始字符串数组（string[][]），
 * 供 buildColumns 原地转换，避免「行数组 + 列数组」双重驻留导致大样本内存溢出。
 */
function parseCsv(text) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('数据集为空')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let headers = null
  const columns = [] // string[][]
  let field = '', row = [], inQuotes = false, i = 0
  const n = text.length

  const pushField = () => { row.push(field); field = '' }
  const flushRow = () => {
    if (row.length === 0) return
    if (headers === null) {
      headers = row.slice()
      for (let j = 0; j < headers.length; j++) columns.push([])
      row = []
      return
    }
    if (!row.some((v) => v.trim() !== '')) { row = []; return } // 跳过全空行
    const width = headers.length
    for (let j = 0; j < width; j++) columns[j].push(j < row.length ? row[j] : '')
    row = []
  }

  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"' && field.length === 0) { inQuotes = true; i++; continue }
    if (c === ',') { pushField(); i++; continue }
    if (c === '\n') { pushField(); flushRow(); i++; continue }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++
      pushField(); flushRow(); i++; continue
    }
    field += c; i++
  }
  if (field.length > 0 || row.length > 0) { pushField(); flushRow() }

  if (headers === null || columns.length === 0 || columns[0].length === 0) throw new Error('CSV 没有数据行')
  const headerSet = new Set(headers)
  if (headerSet.size !== headers.length) throw new Error(`表头存在重复列: ${headers.filter((h, idx) => headers.indexOf(h) !== idx).join(', ')}`)
  return { headers, columns }
}

const MISSING_TOKENS = new Set(['', 'na', 'n/a', 'null', 'nan', 'none', 'missing', 'undefined'])

/**
 * 推断列类型并**原地**把原始字符串数组转换为 typed values
 * （元素被替换为 number | string | null，数组对象复用，控制大样本内存）。
 * type: 'numeric' | 'categorical'，值域 number|string|null。
 * 幂等：转换过的列数组带有 __typed/__type 标记，同一 dataset 二次处理时直接复用。
 */
function buildColumns(headers, columns) {
  const cols = headers.map((name, j) => {
    const raw = columns[j]
    if (raw.__typed) return { name, type: raw.__type, values: raw }
    let nonNull = 0, numeric = 0
    for (const v of raw) {
      if (v === null) continue
      const t = v.trim()
      if (MISSING_TOKENS.has(t.toLowerCase())) continue
      nonNull++
      if (t !== '' && Number.isFinite(Number(t))) numeric++
    }
    const type = nonNull > 0 && numeric / nonNull >= 0.95 ? 'numeric' : 'categorical'
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i].trim()
      const low = t.toLowerCase()
      if (MISSING_TOKENS.has(low)) { raw[i] = null; continue }
      if (type === 'numeric') {
        const num = Number(t)
        raw[i] = Number.isFinite(num) ? num : null
        continue
      }
      raw[i] = t
    }
    raw.__typed = true
    raw.__type = type
    return { name, type, values: raw }
  })
  return cols
}

/** 目标列缺失（null）的行索引：target 为空的不纳入统计样本 */
function dropTargetMissingIndices(values) {
  const indices = []
  let removed = 0
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) { removed++; continue }
    indices.push(i)
  }
  return { indices, removed }
}

// ─────────────────────────── 目标变量 (y) ───────────────────────────

const BAD_TRUE = new Set(['1', 'true', 'yes', 'y', 'bad', 'default', '违约', '逾期', '坏', '是', '1.0', '高风险'])
const BAD_FALSE = new Set(['0', 'false', 'no', 'n', 'good', 'normal', '正常', '未逾期', '好', '否', '0.0', '低风险'])

/** 将目标列映射为 0/1。非二分类时报错并给出可用取值。 */
function mapTarget(values, name) {
  const y = []
  const seen = new Set()
  for (const v of values) {
    if (v === null) throw new Error(`目标列 "${name}" 存在缺失值，无法作为 y`)
    const key = String(v).trim().toLowerCase()
    seen.add(key)
    if (BAD_TRUE.has(key)) { y.push(1); continue }
    if (BAD_FALSE.has(key)) { y.push(0); continue }
    const num = Number(key)
    if (Number.isFinite(num)) {
      if (num === 1) { y.push(1); continue }
      if (num === 0) { y.push(0); continue }
    }
    throw new Error(`目标列 "${name}" 不是二分类（bad=1 / good=0）。当前取值: ${[...seen].slice(0, 12).join(', ')}${seen.size > 12 ? ' …' : ''}。请使用 0/1、true/false、good/bad、正常/违约 等二值取值。`)
  }
  return y
}

// ─────────────────────────── 无用特征识别 ───────────────────────────

const IDLIKE_RE = /(^|_|-|\.)(id|serial|serialno|serial_no|seq|seqno|seq_no|rowid|row_id|caseid|case_id|clientid|client_id|customerid|customer_id|uid|uuid|key|no|num|编号|序号|证件号|身份证|手机号|客户号|流水号|单号)(_|$|-|\.)/i

function isIdLike(name) {
  const n = String(name).trim()
  if (/^(id|serialno|serial_no|seq|seqno|rowid|caseid|uid|uuid|key|no|编号|序号|证件号|流水号)$/i.test(n)) return true
  return IDLIKE_RE.test(n)
}

// ─────────────────────────── 数据质量检查 ───────────────────────────

/** 对指定列做统计：类型、缺失率、基数、常量/近似唯一、是否建议剔除 */
function columnStats(col, n) {
  const { name, type, values } = col
  let missing = 0
  const set = new Set()
  for (const v of values) {
    if (v === null) { missing++; continue }
    if (type === 'numeric') set.add(Math.round(v * 10000) / 10000)
    else set.add(v)
  }
  const missingRate = missing / n
  const cardinality = set.size
  let dropReason = ''
  if (isIdLike(name)) dropReason = 'ID/序号类字段（按命名识别）'
  else if (cardinality <= 1) dropReason = '常量列（无区分度）'
  else if (cardinality >= Math.max(2, Math.floor(n * 0.999)) && n > 200) dropReason = '近似唯一（每行取值几乎都不同）'
  else if (missingRate > 0.9) dropReason = `缺失率过高 (${pct(missingRate)})`
  return { name, type, missing, missingRate, cardinality, dropReason }
}

/** 数据质量检查：返回列统计、自动剔除清单、问题列表、重复行数 */
function qualityCheck(columns, n) {
  const stats = columns.map((c) => columnStats(c, n))
  const autoExcluded = stats.filter((s) => s.dropReason).map((s) => ({ name: s.name, reason: s.dropReason }))
  const issues = []
  for (const s of stats) {
    if (s.dropReason) issues.push({ level: 'warn', message: `列 "${s.name}" 自动剔除：${s.dropReason}` })
    else if (s.missingRate > 0.3) issues.push({ level: 'warn', message: `列 "${s.name}" 缺失率 ${pct(s.missingRate)}，请确认是否需要填充或删除` })
  }
  // 重复行（超过 20 万行时抽样检查）
  let duplicateRows = 0
  const dupCap = 200000
  if (n <= dupCap && columns.length > 0) {
    const seen = new Set()
    for (let i = 0; i < n; i++) {
      let key = ''
      for (const c of columns) {
        const v = c.values[i]
        key += v === null ? '\u0000' : String(v)
        key += '\u0001'
      }
      if (seen.has(key)) duplicateRows++
      else seen.add(key)
    }
  } else if (n > dupCap) {
    issues.push({ level: 'info', message: `样本量 ${n} 超过 ${dupCap}，重复行检查已跳过` })
  }
  if (duplicateRows > 0) issues.push({ level: 'warn', message: `存在 ${duplicateRows} 行完全重复数据 (${pct(duplicateRows / n)})` })
  return { stats, autoExcluded, issues, duplicateRows }
}

// ─────────────────────────── 单规则挖掘 ───────────────────────────

const DEFAULT_CUT_QUANTILES = [1, 3, 5, 95, 97, 99] // 连续变量切分阈值（分位数 %），默认 6 个

function ruleScore(lift, h) { return (lift - 1) * (1 - h) }

/**
 * 对单个特征生成候选规则（不做 mask，直接用算术统计）。
 * 返回规则数组（每项含 feature/expression/operator/kind/metrics）。
 *
 * 连续变量按「遍历切分阈值」挖掘：对 opts.cutQuantiles（默认 1%/3%/5%/95%/97%/99%）
 * 中的每个分位数计算切分点，并同时尝试两个方向（选小 x<=q / 选大 x>=q），
 * 方向与阈值是否入选由数据实际情况决定（命中率/Lift 过滤 + 排序截断）。
 */
function candidatesForFeature(col, y, n, b0, opts) {
  const { name, type, values } = col
  const minSupport = opts.minSupport
  const minLift = opts.minLift
  const cutQuantiles = opts.cutQuantiles && opts.cutQuantiles.length ? opts.cutQuantiles : DEFAULT_CUT_QUANTILES
  const candidates = []
  const keep = (r) => {
    r.hitRate = r.support / n
    r.lift = r.badHit > 0 && r.support > 0 ? r.badHit / r.support / b0 : 0
    if (r.hitRate < minSupport || r.lift < minLift || r.hitRate > 0.6) return
    r.badRate = b0
    r.badRateHit = r.badHit / r.support
    r.iv = ivOf(r.support, r.badHit, n, b0)
    r.score = ruleScore(r.lift, r.hitRate)
    candidates.push(r)
  }

  if (type === 'numeric') {
    // 非缺失值排序 + 前缀坏样本数
    const idx = []
    for (let i = 0; i < n; i++) if (values[i] !== null) idx.push(i)
    idx.sort((a, b) => values[a] - values[b])
    const sorted = idx.map((i) => values[i])
    const m = sorted.length
    const prefixBad = new Float64Array(m + 1)
    for (let k = 0; k < m; k++) prefixBad[k + 1] = prefixBad[k] + y[idx[k]]

    const addCut = (cut) => {
      const lb = lowerBound(sorted, cut)
      const ub = upperBound(sorted, cut)
      // 选大：x >= cut
      const geCount = m - lb, geBad = prefixBad[m] - prefixBad[lb]
      if (geCount > 0) {
        keep({
          feature: name, kind: 'numeric-gte', operator: '>=', value: cut,
          expression: `${name} >= ${fmt(cut, 2)}`,
          support: geCount, badHit: geBad,
        })
      }
      // 选小：x <= cut
      if (ub > 0) {
        keep({
          feature: name, kind: 'numeric-lte', operator: '<=', value: cut,
          expression: `${name} <= ${fmt(cut, 2)}`,
          support: ub, badHit: prefixBad[ub],
        })
      }
    }

    // 遍历切分阈值：对每个分位数生成切分点（阈值本身也是挖掘维度）
    const seenCut = new Set()
    for (const p of cutQuantiles) {
      if (!(p > 0 && p < 100)) continue
      const cut = quantile(sorted, p / 100)
      const key = Math.round(cut * 1000)
      if (!seenCut.has(key)) { seenCut.add(key); addCut(cut) }
    }

    // 缺失规则
    const missing = n - m
    if (missing > 0 && missing / n >= 0.005) {
      let badMissing = 0
      for (let i = 0; i < n; i++) if (values[i] === null) badMissing += y[i]
      if (missing > 0) {
        const lift = badMissing / missing / b0
        if (lift >= Math.max(minLift, 1.1)) {
          candidates.push({
            feature: name, kind: 'missing', operator: 'is', value: null,
            expression: `${name} 为缺失`,
            support: missing, badHit: badMissing, hitRate: missing / n,
            lift, badRate: b0, badRateHit: badMissing / missing,
            iv: ivOf(missing, badMissing, n, b0),
            score: ruleScore(lift, missing / n),
          })
        }
      }
    }
  } else {
    // 分类变量：单值规则 + 高坏浓度取值并集 + 缺失规则
    const counts = new Map() // value -> { count, bad }
    for (let i = 0; i < n; i++) {
      const v = values[i]
      if (v === null) continue
      let rec = counts.get(v)
      if (!rec) { rec = { count: 0, bad: 0 }; counts.set(v, rec) }
      rec.count++; rec.bad += y[i]
    }
    const ranked = [...counts.entries()].map(([v, rec]) => ({
      value: v, count: rec.count, bad: rec.bad,
      rate: rec.bad / rec.count, lift: rec.bad / rec.count / b0,
    })).filter((r) => r.count / n >= minSupport && r.lift >= minLift)
      .sort((a, b) => b.lift - a.lift)

    for (const r of ranked.slice(0, 12)) {
      candidates.push({
        feature: name, kind: 'cat-eq', operator: '==', value: r.value,
        expression: `${name} == ${JSON.stringify(r.value)}`,
        support: r.count, badHit: r.bad, hitRate: r.count / n,
        lift: r.lift, badRate: b0, badRateHit: r.rate,
        iv: ivOf(r.count, r.bad, n, b0), score: ruleScore(r.lift, r.count / n),
      })
    }

    // 并集规则：从高坏浓度取值开始贪心并集（模拟并行命中）
    if (ranked.length >= 2) {
      const maxUnion = Math.max(minSupport * n, 3)
      const chosen = []
      const chosenSet = new Set()
      let uCount = 0, uBad = 0
      for (const r of ranked) {
        if (uCount >= maxUnion) break
        chosen.push(r.value); chosenSet.add(r.value)
        uCount += r.count; uBad += r.bad
      }
      if (chosen.length >= 2) {
        const lift = uBad / uCount / b0
        if (lift >= minLift && uCount / n <= 0.6) {
          candidates.push({
            feature: name, kind: 'cat-in', operator: 'in', value: chosen,
            expression: `${name} in [${chosen.map((v) => JSON.stringify(v)).join(', ')}]`,
            support: uCount, badHit: uBad, hitRate: uCount / n,
            lift, badRate: b0, badRateHit: uBad / uCount,
            iv: ivOf(uCount, uBad, n, b0), score: ruleScore(lift, uCount / n),
          })
        }
      }
    }

    // 缺失规则
    let missing = 0, badMissing = 0
    for (let i = 0; i < n; i++) {
      if (values[i] === null) { missing++; badMissing += y[i] }
    }
    if (missing > 0 && missing / n >= 0.005) {
      const lift = badMissing / missing / b0
      if (lift >= Math.max(minLift, 1.1)) {
        candidates.push({
          feature: name, kind: 'missing', operator: 'is', value: null,
          expression: `${name} 为缺失`,
          support: missing, badHit: badMissing, hitRate: missing / n,
          lift, badRate: b0, badRateHit: badMissing / missing,
          iv: ivOf(missing, badMissing, n, b0), score: ruleScore(lift, missing / n),
        })
      }
    }
  }

  // 每特征去重（同方向同取值只留一个）并按分数截断
  const dedup = new Map()
  for (const r of candidates) {
    const key = `${r.kind}|${r.operator}|${r.value === null ? 'null' : (Array.isArray(r.value) ? JSON.stringify(r.value) : Math.round(r.value * 1000))}`
    const prev = dedup.get(key)
    if (!prev || r.score > prev.score) dedup.set(key, r)
  }
  const list = [...dedup.values()].sort((a, b) => b.score - a.score)
  return list.slice(0, opts.maxRulesPerFeature)
}

/** 二元规则的 IV（信息值），分组 = 命中/未命中 */
function ivOf(hitCount, badHit, n, b0) {
  const missCount = n - hitCount
  const goodHit = hitCount - badHit
  const badMiss = Math.round(b0 * n) - badHit
  const goodMiss = missCount - badMiss
  if (badMiss <= 0 || goodMiss <= 0 || goodHit <= 0 || badHit <= 0) return 0
  const badShareH = badHit / (b0 * n), badShareM = badMiss / (b0 * n)
  const goodShareH = goodHit / ((1 - b0) * n), goodShareM = goodMiss / ((1 - b0) * n)
  const woeH = Math.log(goodShareH / badShareH), woeM = Math.log(goodShareM / badShareM)
  return Math.abs((goodShareH - badShareH) * woeH + (goodShareM - badShareM) * woeM)
}

// ─────────────────────────── 组合搜索 ───────────────────────────

/** 评估一个规则集合（并行 OR 语义）的命中与坏浓度 */
function evaluateSet(masks, yBad, n, b0) {
  const acc = new Bits(n)
  for (const m of masks) acc.orInPlace(m)
  const hit = acc.count()
  const badHit = acc.andCount(yBad)
  const h = hit / n
  const badRateHit = hit > 0 ? badHit / hit : 0
  const lift = badRateHit / b0
  return { hit, h, badHit, badRateHit, lift, acc }
}

/** F1 = 2·P·R/(P+R)：精准率与召回率最平衡且都大的指标 */
function f1Score(p, r) {
  if (p <= 0 || r <= 0) return 0
  return 2 * p * r / (p + r)
}

function makeComparator(objective, opts) {
  const budget = opts.hitRateBudget
  const minLift = opts.minLift
  // 基础约束（集合级）：命中率预算 + 最小 Lift
  const ok = (r) => r.hit > 0 && r.h <= budget && r.lift >= minLift
  const cmp = (a, b) => { // 返回 true 表示 a 优于 b（组合择优；top_lift 有独立逻辑）
    if (objective === 'f1') {
      // 默认：精准率与召回率最平衡且都大（F1 最大）；并列取 lift 更大、命中率更小
      const fa = f1Score(a.precision, a.recall), fb = f1Score(b.precision, b.recall)
      if (Math.abs(fa - fb) > 1e-9) return fa > fb
      if (Math.abs(a.lift - b.lift) > 1e-9) return a.lift > b.lift
      return a.h < b.h
    }
    if (objective === 'max_lift') {
      if (Math.abs(a.lift - b.lift) > 1e-9) return a.lift > b.lift
      return a.h < b.h
    }
    if (objective === 'min_hit') {
      if (Math.abs(a.h - b.h) > 1e-9) return a.h < b.h
      return a.lift > b.lift
    }
    // composite：lift × (1 - h)，兼顾「通过率减少越小越好 且 lift 越高越好」
    const sa = a.lift * (1 - a.h), sb = b.lift * (1 - b.h)
    if (Math.abs(sa - sb) > 1e-9) return sa > sb
    return a.h < b.h
  }
  return { ok, cmp }
}

/**
 * 组合最优搜索：逐层遍历树，收集所有评估过的可行组合。
 * 规则集为并行(OR)：命中任一规则即拒绝。
 *
 * 挖掘流程（逐层递进）：
 *   1. 第一条规则：取所有单条规则中 Lift 最高的前 topLiftPct（至少 topLiftMin 个），
 *      这 top 个单规则**轮番作为第一条规则**（每个建立一个搜索分支）；
 *   2. 第二条及以后：对当前已锁定组合，评估每个候选规则的「增益效果」
 *      （组合效果提升 = F1 提升，且必须提高召回率），按增益降序取前 branchPct
 *      （至少 branchMin 个）的规则**遍历组合**，每个再递归扩展下一层；
 *   3. 停止条件：**召回率无法提高**（没有任何候选能使召回率上升，或达到 maxRules）。
 *
 * 评估标准（objective，默认 f1）：以精准率与召回率**最平衡且都大**的组合为最优（F1 最大）；
 * top_lift / composite / max_lift / min_hit 为备选。
 * 注：第一条规则 Lift 区分度最好，累加后续规则后组合 Lift 会逐渐下降、命中率逐渐提升，属正常现象。
 */
function searchCombination(candidates, y, n, b0, opts, sampledRows) {
  const objective = opts.objective || 'f1'
  const searchN = sampledRows ? sampledRows.length : n
  const yBad = new Bits(searchN)
  const buildMask = (rule) => {
    const b = new Bits(searchN)
    const col = rule._col
    const vals = col.values
    const it = sampledRows || null
    const loopN = it ? it.length : n
    for (let i = 0; i < loopN; i++) {
      const rowIdx = it ? it[i] : i
      const v = vals[rowIdx]
      let hit = false
      if (rule.kind === 'numeric-gte') hit = v !== null && v >= rule.value
      else if (rule.kind === 'numeric-lte') hit = v !== null && v <= rule.value
      else if (rule.kind === 'cat-eq') hit = v !== null && v === rule.value
      else if (rule.kind === 'cat-in') hit = v !== null && rule.value.includes(v)
      else if (rule.kind === 'missing') hit = v === null
      if (hit) b.set(i)
    }
    return b
  }
  for (let i = 0; i < searchN; i++) {
    if (sampledRows ? y[sampledRows[i]] : y[i]) yBad.set(i)
  }
  const totalBad = yBad.count()
  const { ok, cmp } = makeComparator(objective, opts)
  const maxRules = opts.maxRules || 8
  const budget = opts.hitRateBudget

  const pool = candidates.slice(0, opts.maxCandidates)
  const masks = pool.map((r) => buildMask(r))

  const evalSet = (idxList) => {
    const acc = new Bits(searchN)
    for (const i of idxList) acc.orInPlace(masks[i])
    const hit = acc.count()
    const badHit = acc.andCount(yBad)
    const h = hit / searchN
    const precision = hit > 0 ? badHit / hit : 0
    const recall = totalBad > 0 ? badHit / totalBad : 0
    const lift = precision / b0
    return { hit, h, badHit, precision, recall, lift, score: lift * (1 - h) }
  }
  const f1Of = (res) => f1Score(res.precision, res.recall)

  // 收集所有评估过的可行组合（按规则集合去重；集合内完全冗余的规则会被移除）
  const allCombos = new Map()
  const record = (idxList) => {
    if (idxList.length === 0) return
    let cleaned = idxList.slice()
    let changed = true
    while (changed && cleaned.length > 1) {
      changed = false
      const base = evalSet(cleaned)
      for (let k = 0; k < cleaned.length; k++) {
        const trial = evalSet(cleaned.filter((_, j) => j !== k))
        if (trial.hit === base.hit) { // 去掉该规则并集不变 → 集合内冗余
          cleaned = cleaned.filter((_, j) => j !== k)
          changed = true
          break
        }
      }
    }
    const key = [...cleaned].sort((a, b) => a - b).join(',')
    if (allCombos.has(key)) return
    const res = evalSet(cleaned)
    if (!ok(res)) return
    allCombos.set(key, { indices: cleaned, res })
  }

  for (let i = 0; i < pool.length; i++) record([i])

  // ── 1. 第一条规则：单规则 Lift 前 top5%（至少 topLiftMin）轮番作种子 ──
  const topLiftPct = opts.topLiftPct ?? 0.05
  const topLiftMin = opts.topLiftMin ?? 5
  const singles = pool
    .map((_, i) => ({ i, res: evalSet([i]) }))
    .filter((s) => ok(s.res))
    .sort((a, b) => b.res.lift - a.res.lift || a.res.h - b.res.h)
  if (singles.length === 0) {
    throw new Error(`未找到任何满足基础约束的规则（minSupport=${opts.minSupport}, minLift=${opts.minLift}, hitRateBudget=${opts.hitRateBudget}）。请放宽约束（如降低 minLift/hitRateBudget），或检查特征与目标列的相关性。`)
  }
  const seedTop = Math.max(topLiftMin, Math.ceil(singles.length * topLiftPct))
  const seeds = singles.slice(0, Math.min(seedTop, singles.length)).map((s) => s.i)

  // ── 2. 逐层扩展：对当前组合增益 top5%（至少 branchMin）的规则遍历组合；召回率无法提高则停止 ──
  const branchPct = opts.branchPct ?? 0.05
  const branchMin = opts.branchMin ?? 3
  const expand = (B) => {
    if (B.length >= maxRules) return
    const baseRes = evalSet(B)
    const baseF1 = f1Of(baseRes)
    const trials = []
    for (let i = 0; i < pool.length; i++) {
      if (B.includes(i)) continue
      const res = evalSet([...B, i])
      if (!ok(res)) continue
      if (res.recall <= baseRes.recall + 1e-9) continue // 召回率必须提高（停止条件）
      trials.push({ i, gain: f1Of(res) - baseF1 })
    }
    if (trials.length === 0) return // 召回率无法提高 → 本分支停止
    trials.sort((a, b) => b.gain - a.gain)
    const topN = Math.max(branchMin, Math.ceil(trials.length * branchPct))
    for (const t of trials.slice(0, Math.min(topN, trials.length))) {
      const next = [...B, t.i]
      record(next)
      expand(next)
    }
  }
  for (const s of seeds) {
    record([s])
    expand([s])
  }

  // ── 3. 最终判定 ──
  const list = [...allCombos.values()]
  if (list.length === 0) {
    throw new Error(`未找到任何满足基础约束的组合（minSupport=${opts.minSupport}, minLift=${opts.minLift}, hitRateBudget=${opts.hitRateBudget}）。请放宽约束（如降低 minLift/hitRateBudget），或检查特征与目标列的相关性。`)
  }

  let chosen
  let topCount = 0
  if (objective === 'top_lift') {
    list.sort((a, b) => b.res.lift - a.res.lift || a.res.h - b.res.h)
    const topN = Math.max(topLiftMin, Math.ceil(list.length * topLiftPct))
    topCount = Math.min(topN, list.length)
    const top = list.slice(0, topCount).sort((a, b) => a.res.h - b.res.h || b.res.lift - a.res.lift)
    chosen = top[0]
  } else {
    const minCoverage = opts.minBadCoverage || 0
    let poolList = list
    if (minCoverage > 0) {
      const met = list.filter((c) => c.res.recall >= minCoverage)
      if (met.length > 0) poolList = met
    }
    let best = poolList[0]
    for (const c of poolList) if (cmp(c.res, best.res)) best = c
    chosen = best
  }

  // 展示用：全部组合（按 F1 降序；超过上限时保留前 maxCombos 个）与 PR 曲线
  const maxCombos = opts.maxCombos ?? 200
  const combosAll = list.slice().sort((a, b) => {
    const fa = f1Of(a.res), fb = f1Of(b.res)
    if (Math.abs(fa - fb) > 1e-9) return fb - fa
    return b.res.lift - a.res.lift || a.res.h - b.res.h
  }).slice(0, maxCombos)
  const prPoints = combosAll
    .map((c) => ({ recall: c.res.recall, precision: c.res.precision }))
    .sort((a, b) => a.recall - b.recall)

  return {
    chosenIndices: chosen.indices,
    pool,
    chosenRes: chosen.res,
    combos: combosAll.map((c) => ({ indices: c.indices, res: c.res })),
    selection: {
      objective,
      topLiftPct,
      topLiftMin,
      branchPct,
      branchMin,
      topCount,
      allComboCount: list.length,
      displayedCount: combosAll.length,
    },
    prCurve: prPoints,
    objective,
    totalBad,
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

const DEFAULTS = {
  minSupport: 0.01,
  minLift: 1.05,
  hitRateBudget: 0.5,
  minBadCoverage: 0, // 仅 legacy 目标（composite/max_lift/min_hit）生效；f1/top_lift 不使用
  objective: 'f1', // 默认：精准率与召回率最平衡且都大（F1 最大）
  topLiftPct: 0.05, // 第一条规则：单规则 Lift 前百分之几作种子
  topLiftMin: 5, // 第一条规则：种子数下限
  branchPct: 0.05, // 逐层扩展：对当前组合增益前百分之几的规则遍历组合
  branchMin: 3, // 逐层扩展：每层遍历的候选规则数下限
  cutQuantiles: [1, 3, 5, 95, 97, 99], // 连续变量切分阈值（分位数 %），遍历该维度
  maxCandidates: 14,
  maxRulesPerFeature: 5,
  maxRules: 8,
  maxCombos: 200, // 展示的组合数上限（全部组合，超出时按 F1 保留前 N）
  searchMaxRows: 50000,
}

/** 数据集确认与质检 */
function profileDataset({ headers, columns }, target, opts = {}) {
  const tIdx = headers.indexOf(target)
  if (tIdx < 0) throw new Error(`未找到目标列 "${target}"。可用列: ${headers.join(', ')}`)
  const typed = buildColumns(headers, columns)
  const drop = dropTargetMissingIndices(typed[tIdx].values)
  const n = drop.indices.length
  if (n === 0) throw new Error(`目标列 "${target}" 全部为缺失/空值，无法进行规则挖掘`)
  // 压缩所有列到有效样本（target 为空的不纳入统计）
  for (const col of typed) col.values = drop.indices.map((i) => col.values[i])
  const y = mapTarget(typed[tIdx].values, target)
  const b0 = y.reduce((a, b) => a + b, 0) / n
  if (b0 === 0 || b0 === 1) throw new Error(`目标列 "${target}" 取值单一（bad 占比 ${pct(b0)}），无法进行规则挖掘`)

  const qc = qualityCheck(typed, n)
  const autoExcludedNames = new Set(qc.autoExcluded.map((e) => e.name))
  const requestedFeatures = (opts.features && opts.features.length) ? opts.features
    : headers.filter((name) => name !== target && !autoExcludedNames.has(name))

  const excludeSet = new Set(opts.exclude || [])
  const features = requestedFeatures.filter((name) => headers.includes(name) && name !== target && !excludeSet.has(name))
  const unknown = requestedFeatures.filter((name) => !headers.includes(name))
  if (unknown.length) throw new Error(`指定的特征不存在: ${unknown.join(', ')}`)
  if (excludeSet.size && [...excludeSet].some((name) => !headers.includes(name))) {
    throw new Error(`exclude 中存在不存在的列: ${[...excludeSet].filter((name) => !headers.includes(name)).join(', ')}`)
  }

  const stats = qc.stats.filter((s) => s.name !== target)
  const issues = [...qc.issues]
  if (drop.removed > 0) {
    issues.push({ level: 'info', message: `目标列 "${target}" 有 ${drop.removed} 行缺失/空值，已按「target 为空不纳入统计」剔除；有效样本 ${n} 行` })
  }
  return {
    n,
    targetMissingRows: drop.removed,
    columns: stats,
    target,
    y: { badCount: Math.round(b0 * n), goodCount: n - Math.round(b0 * n), badRate: fmt(b0, 6) },
    autoExcluded: qc.autoExcluded,
    requestedFeatures: features,
    excludedByUser: [...excludeSet],
    duplicateRows: qc.duplicateRows,
    issues,
    columnsData: typed, // 内部使用（不输出到模型）
  }
}

/** 规则挖掘主流程 */
function mineRules(dataset, target, features, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const { headers, columns } = dataset
  const tIdx = headers.indexOf(target)
  if (tIdx < 0) throw new Error(`未找到目标列 "${target}"`)
  const typed = buildColumns(headers, columns)
  const drop = dropTargetMissingIndices(typed[tIdx].values)
  const n = drop.indices.length
  if (n === 0) throw new Error(`目标列 "${target}" 全部为缺失/空值，无法挖掘`)
  for (const col of typed) col.values = drop.indices.map((i) => col.values[i])
  const y = mapTarget(typed[tIdx].values, target)
  const b0 = y.reduce((a, b) => a + b, 0) / n
  if (b0 === 0 || b0 === 1) throw new Error(`目标列 "${target}" 取值单一，无法挖掘`)

  const colIdx = features.map((f) => {
    const i = headers.indexOf(f)
    if (i < 0) throw new Error(`特征 "${f}" 不存在于数据集中`)
    return i
  })
  const usedColumns = colIdx.map((i) => typed[i])

  // 1. 单规则候选
  const perFeature = []
  for (const col of usedColumns) {
    const cands = candidatesForFeature(col, y, n, b0, o)
    perFeature.push({ feature: col.name, type: col.type, candidates: cands })
  }
  const allCandidates = []
  for (const pf of perFeature) {
    for (const c of pf.candidates) {
      c._col = usedColumns.find((col) => col.name === pf.feature)
      allCandidates.push(c)
    }
  }
  allCandidates.sort((a, b) => b.score - a.score)
  const pooled = allCandidates.slice(0, o.maxCandidates)
  if (pooled.length === 0) {
    throw new Error(`特征中没有挖掘到满足 minSupport=${o.minSupport}、minLift=${o.minLift} 的候选规则，请检查特征与目标列的相关性`)
  }

  // 2. 组合搜索（大样本时抽样加速，最终指标在全体数据上精确重算）
  let sampledRows = null
  if (n > o.searchMaxRows) {
    const step = Math.ceil(n / o.searchMaxRows)
    sampledRows = []
    for (let i = 0; i < n; i += step) sampledRows.push(i)
  }
  const search = searchCombination(pooled, y, n, b0, o, sampledRows)

  // 3. 在全体数据上精确重算指标（组合集合按搜索阶段 lift 选取，指标全部为精确值）
  const yBadFull = new Bits(n)
  for (let i = 0; i < n; i++) if (y[i]) yBadFull.set(i)
  const totalBadFull = yBadFull.count()
  const buildFullMask = (rule) => {
    const b = new Bits(n)
    const vals = rule._col.values
    for (let i = 0; i < n; i++) {
      const v = vals[i]
      let hit = false
      if (rule.kind === 'numeric-gte') hit = v !== null && v >= rule.value
      else if (rule.kind === 'numeric-lte') hit = v !== null && v <= rule.value
      else if (rule.kind === 'cat-eq') hit = v !== null && v === rule.value
      else if (rule.kind === 'cat-in') hit = v !== null && rule.value.includes(v)
      else if (rule.kind === 'missing') hit = v === null
      if (hit) b.set(i)
    }
    return b
  }
  const fullMaskCache = new Map()
  const fullMaskOf = (poolIdx) => {
    let m = fullMaskCache.get(poolIdx)
    if (!m) { m = buildFullMask(search.pool[poolIdx]); fullMaskCache.set(poolIdx, m) }
    return m
  }
  const evalFull = (idxList) => {
    const acc = new Bits(n)
    for (const i of idxList) acc.orInPlace(fullMaskOf(i))
    const hit = acc.count()
    const badHit = acc.andCount(yBadFull)
    const h = hit / n
    const precision = hit > 0 ? badHit / hit : 0
    return {
      hit, h, badHit, precision,
      recall: totalBadFull > 0 ? badHit / totalBadFull : 0,
      lift: precision / b0, score: precision / b0 * (1 - h),
    }
  }

  // 全部组合精确重算（展示用；排序与重选基于精确指标）
  const combosExact = search.combos.map((c) => ({ indices: c.indices, res: evalFull(c.indices) }))
  combosExact.sort((a, b) => b.res.lift - a.res.lift || a.res.h - b.res.h)
  const topN = Math.min(search.selection.topCount || 0, combosExact.length)

  let chosenIndices
  let chosenEval
  let coverageMet = true
  if (search.objective === 'top_lift') {
    // lift 前 top5% 内，通过率减少（命中率）最小者为最优
    const top = combosExact.slice(0, topN).sort((a, b) => a.res.h - b.res.h || b.res.lift - a.res.lift)
    chosenIndices = top[0].indices
    chosenEval = top[0].res
  } else {
    // f1（默认）/ composite / max_lift / min_hit：按各自比较器在全部组合中取最优
    const { cmp } = makeComparator(search.objective, o)
    const minCoverage = o.minBadCoverage || 0
    let poolList = combosExact
    if (minCoverage > 0) {
      const met = combosExact.filter((c) => c.res.recall >= minCoverage)
      if (met.length > 0) poolList = met
    }
    let best = poolList[0]
    for (const c of poolList) if (cmp(c.res, best.res)) best = c
    chosenIndices = best.indices
    chosenEval = best.res
    if (minCoverage > 0) coverageMet = chosenEval.recall >= minCoverage
  }

  // 逐步累积指标（报告用）
  const fullMasks = chosenIndices.map(fullMaskOf)
  const steps = []
  const accFull = new Bits(n)
  for (let k = 0; k < fullMasks.length; k++) {
    accFull.orInPlace(fullMasks[k])
    const hit = accFull.count()
    const badHit = accFull.andCount(yBadFull)
    const h = hit / n
    const lift = hit > 0 ? badHit / hit / b0 : 0
    const prev = steps[k - 1]
    steps.push({
      rule: search.pool[chosenIndices[k]],
      single: singleMetrics(fullMasks[k], yBadFull, n, b0),
      cumulative: {
        hitRate: fmt(h, 6), passRateReduction: fmt(h, 6),
        badRateHit: fmt(hit > 0 ? badHit / hit : 0, 6), lift: fmt(lift, 4),
        badCoverage: totalBadFull > 0 ? fmt(badHit / totalBadFull, 6) : 0,
        rejected: hit, badCount: badHit,
      },
      marginalGain: prev ? {
        dHitRate: fmt(h - prev.cumulative.hitRate, 6),
        dLift: fmt(lift - prev.cumulative.lift, 4),
      } : { dHitRate: fmt(h, 6), dLift: fmt(lift, 4) },
    })
  }

  // 精准率-召回率曲线（基于全部组合的精确指标，按召回率升序）；
  // 曲线上的关键点为「F1 最高点」（即最优组合），由报告按最优组合坐标标注，不找拐点
  const prPoints = combosExact
    .map((c) => ({ recall: c.res.recall, precision: c.res.precision }))
    .sort((a, b) => a.recall - b.recall)

  // 展示排序：默认按 F1 降序（评估标准为精准率×召回率平衡）
  const combosShown = combosExact.slice().sort((a, b) => {
    const fa = f1Score(a.res.precision, a.res.recall), fb = f1Score(b.res.precision, b.res.recall)
    if (Math.abs(fa - fb) > 1e-9) return fb - fa
    return b.res.lift - a.res.lift || a.res.h - b.res.h
  })

  return {
    singleRules: perFeature.map((pf) => ({
      feature: pf.feature,
      type: pf.type,
      rules: pf.candidates.map((c) => ({
        expression: c.expression, kind: c.kind,
        support: c.support, hitRate: fmt(c.hitRate, 6), badRateHit: fmt(c.badRateHit, 6),
        lift: fmt(c.lift, 4), iv: fmt(c.iv, 4), score: fmt(c.score, 4),
      })),
    })),
    final: {
      rules: steps.map((s) => ({
        expression: s.rule.expression,
        single: s.single,
        cumulative: s.cumulative,
        marginalGain: s.marginalGain,
      })),
      hitRate: fmt(chosenEval.h, 6),
      passRateReduction: fmt(chosenEval.h, 6),
      passRate: fmt(1 - chosenEval.h, 6),
      badRateHit: fmt(chosenEval.precision, 6),
      precision: fmt(chosenEval.precision, 6),
      recall: fmt(chosenEval.recall, 6),
      f1: fmt(f1Score(chosenEval.precision, chosenEval.recall), 4),
      lift: fmt(chosenEval.lift, 4),
      rejected: chosenEval.hit,
      badCount: chosenEval.badHit,
      badCoverage: fmt(chosenEval.recall, 6),
      coverageMet,
      globalBadRate: fmt(b0, 6),
      objectiveScore: fmt(chosenEval.lift * (1 - chosenEval.h), 4),
    },
    options: {
      objective: o.objective, minSupport: o.minSupport, minLift: o.minLift,
      hitRateBudget: o.hitRateBudget, minBadCoverage: o.minBadCoverage, maxRules: o.maxRules,
      topLiftPct: o.topLiftPct, topLiftMin: o.topLiftMin,
      branchPct: o.branchPct, branchMin: o.branchMin,
      cutQuantiles: o.cutQuantiles,
      maxCandidates: o.maxCandidates,
      maxRulesPerFeature: o.maxRulesPerFeature,
      downsampled: sampledRows !== null,
      candidateCount: pooled.length,
    },
    combos: combosShown.map((c, i) => ({
      rank: i + 1,
      rules: c.indices.map((j) => search.pool[j].expression),
      precision: fmt(c.res.precision, 6), recall: fmt(c.res.recall, 6),
      hitRate: fmt(c.res.h, 6), lift: fmt(c.res.lift, 4),
      f1: fmt(f1Score(c.res.precision, c.res.recall), 4),
      inTopPct: search.objective === 'top_lift' && i < topN,
      isChosen: c.indices.length === chosenIndices.length && c.indices.every((v, k) => v === chosenIndices[k]),
    })),
    selection: {
      objective: search.selection.objective,
      topLiftPct: search.selection.topLiftPct,
      topLiftMin: search.selection.topLiftMin,
      branchPct: search.selection.branchPct,
      branchMin: search.selection.branchMin,
      topCount: search.selection.topCount,
      allComboCount: search.selection.allComboCount,
      displayedCount: combosShown.length,
    },
    prCurve: prPoints.map((p) => ({ recall: fmt(p.recall, 6), precision: fmt(p.precision, 6) })),
    consideredCandidates: pooled.map((c) => ({
      expression: c.expression, hitRate: fmt(c.hitRate, 6), lift: fmt(c.lift, 4), score: fmt(c.score, 4), selected: chosenIndices.includes(pooled.indexOf(c)),
    })),
  }
}

function singleMetrics(mask, yBad, n, b0) {
  const hit = mask.count()
  const badHit = mask.andCount(yBad)
  return {
    hitRate: fmt(hit / n, 6), badRateHit: fmt(hit > 0 ? badHit / hit : 0, 6),
    lift: fmt(hit > 0 ? badHit / hit / b0 : 0, 4), support: hit,
  }
}

export {
  parseCsv, buildColumns, mapTarget, qualityCheck, profileDataset, mineRules,
  candidatesForFeature, searchCombination, evaluateSet,
  pct, fmt, esc, Bits,
}
