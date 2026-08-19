// make_demo_data.mjs — 生成演示用的信贷数据集（含已知的潜在规则结构）
// 运行: node make_demo_data.mjs [输出路径] [行数]
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const OUT = resolve(process.argv[2] || 'demo_credit_data.csv')
const ROWS = Number(process.argv[3] || 8000)

// 确定性伪随机数
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20250117)
const ri = (min, max) => min + Math.floor(rnd() * (max - min + 1))
const rf = (min, max) => min + rnd() * (max - min)
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]

const REGIONS = ['华东', '华南', '华北', '西南', '东北', '西北']
const INDUSTRIES = ['制造业', '批发零售', '信息技术', '房地产', '金融', '农林牧渔', '交通运输']
const EDU = ['高中及以下', '大专', '本科', '硕士及以上']

function badProb(row) {
  // 潜在规则结构（真实但带噪声）。缺失值按中性取值参与计算（缺失本身不产生坏信号）。
  const cs = row.credit_score === '' ? 650 : Number(row.credit_score)
  const inc = row.income === '' ? 8000 : Number(row.income)
  const dr = Number(row.debt_ratio)
  let p = 0.02
  if (cs < 600) p += 0.45
  if (cs < 550) p += 0.25
  if (dr > 0.8) p += 0.35
  if (dr > 0.8 && inc < 8000) p += 0.2
  if (row.region === '东北' && row.industry === '房地产') p += 0.3
  if (Number(row.account_age_months) < 6) p += 0.08
  if (row.education === '高中及以下' && dr > 0.6) p += 0.12
  return Math.min(0.97, p)
}

const rows = []
for (let i = 0; i < ROWS; i++) {
  const row = {
    id: `CUST_${String(i + 1).padStart(6, '0')}`,
    serialno: `SN-${(i * 7919) % 999999}`,
    age: ri(20, 65),
    income: Math.round(rf(3000, 30000) * (rnd() < 0.3 ? 1.8 : 1)),
    credit_score: Math.round(Math.min(850, Math.max(300, 720 + (rnd() - 0.5) * 220 + (rnd() < 0.12 ? -180 : 0)))),
    debt_ratio: Math.min(1.5, Math.max(0.02, rf(0.02, 0.8) + (rnd() < 0.2 ? 0.55 : 0))),
    account_age_months: ri(1, 120),
    loan_amount: Math.round(rf(5000, 500000) / 1000) * 1000,
    region: pick(REGIONS),
    industry: pick(INDUSTRIES),
    education: pick(EDU),
    has_guarantee: rnd() < 0.35 ? '是' : '否',
    sms_count: ri(0, 60),
  }
  // 人为制造少量缺失
  if (rnd() < 0.03) row.credit_score = ''
  if (rnd() < 0.02) row.income = ''
  if (rnd() < 0.02) row.education = ''
  // 目标：坏概率 + 8% 噪声翻转
  let y = rnd() < badProb(row) ? 1 : 0
  if (rnd() < 0.08) y = y === 1 ? 0 : 1
  rows.push({ ...row, default_flag: y })
}

const esc = (v) => {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const headers = Object.keys(rows[0])
const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n')

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, '\ufeff' + csv, 'utf8')
const badRate = rows.filter((r) => r.default_flag === 1).length / rows.length
console.log(`已生成 ${ROWS} 行 → ${OUT}`)
console.log(`全局坏率: ${(badRate * 100).toFixed(2)}%（含 8% 噪声翻转）`)
