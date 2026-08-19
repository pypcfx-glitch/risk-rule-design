// index.js — risk_rule_design 插件入口
// 注册 3 个工具（rrd_profiling / rrd_mining / rrd_report）+ 1 个专家技能（risk-rule-design）。
// 注意：本插件为保持零构建、零外部依赖，仅使用 Node 内置模块与相对导入，
// 因此可在任意 dsh profile 中以绝对路径直接加载（参照插件教程的 insert 方式）。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, basename, resolve, join, isAbsolute } from 'node:path'

import { parseCsv, profileDataset, mineRules, pct } from './engine.js'
import { buildReport } from './report.js'

export const name = 'risk-rule-design'
export const inject = ['tools']

// ─────────────────────────── 专家技能内容 ───────────────────────────

const SKILL_NAME = 'risk-rule-design'
const SKILL_DESCRIPTION = '金融风控规则挖掘：以风控专家身份对给定数据集（X/y）进行数据质检、单规则挖掘、并行规则组合最优搜索并输出 HTML 分析报告。配合 rrd_profiling / rrd_mining / rrd_report 工具使用。'
const SKILL_WHEN_TO_USE = '当用户提供信贷/金融数据集并要求规则挖掘、拒绝策略设计、坏样本分析、风控规则报告时。'
const SKILL_CONTENT = `# 金融风控规则挖掘（risk rule design）

## 角色
你现在是一名金融风控领域的专家。当用户提供指定数据集后，你需要根据数据集中的 X（特征）和 y（目标）进行规则挖掘，并以「拒绝效率最优」为最终目标锁定并行规则组合，最后输出结构化的 HTML 分析报告。

## 标准流程

### 第 1 步：数据集确认与质量检查
1. 调用 \`rrd_profiling\` 确认 X 与 y：
   - \`target\` 必须是二分类目标（bad=1 / good=0，或 true/false、good/bad、正常/违约等等价写法）；
   - X 需要剔除无用特征：ID、serialno、流水号、证件号等唯一标识字段、常量列、近似唯一列（基数 ≈ 样本数）、缺失率超过 90% 的列——工具会自动识别并给出剔除原因，人工确认后以 \`exclude\` 或 \`features\` 显式指定；
2. 检查数据质量：缺失率、基数、重复行、y 分布（全局坏率）。质量无误后再进入规则挖掘；若发现问题（如 y 非二分类、目标列缺失、特征全为常量），先向用户说明并协商处理，不强行挖掘。

### 第 2 步：规则挖掘（单规则 → 逐层遍历树组合 → F1 平衡最优）
1. 单规则有效性：对每个特征挖掘候选规则——**连续变量遍历切分阈值**（默认分位数 1%/3%/5%/95%/97%/99%，每个阈值尝试「选小 x<=q / 选大 x>=q」两个方向，阈值集合可用 \`cutQuantiles\` 自定义）；分类变量用取值等于/并集；另含缺失规则。指标包括：
   - 命中率 hitRate（= 通过率减少）：命中样本占比，越小越好；
   - 精准率 Precision = 命中样本中坏样本占比（命中坏浓度）；
   - 召回率 Recall = 命中样本中坏样本 / 全部坏样本；
   - Lift = 精准率 / 全局坏率：坏浓度提升倍数，越高越好；
   - F1 = 2·P·R/(P+R)：精准率与召回率的平衡点；
   - IV：信息值，衡量规则区分度。
2. 组合规则（关键）：规则集是**并行（OR）**的——命中任一规则即拒绝，所以真正重要的是**组合**效果，而不是单条规则：
   - **挖掘流程（逐层遍历树，\`rrd_mining\` 默认即此逻辑）**：
     ① 第一条规则：取所有单规则中 **Lift 最高**的前 topLiftPct（至少 topLiftMin 个），
        这 top 个单规则**轮番作为第一条规则**（每个建立一个搜索分支）；
     ② 第二条及以后：对当前已锁定组合，评估每个候选规则的**增益效果**（组合效果提升，
        且必须提高召回率），按增益降序取前 branchPct（至少 branchMin 个）的规则**遍历组合**，
        每个再递归扩展下一层；
     ③ **停止条件：召回率无法提高**（或达到 maxRules）。
   - **效果判断（默认 f1）**：在全部评估组合中，以**精准率与召回率最平衡且都大（F1 最大）**的组合为最优；并列时取 Lift 更大、命中率更小。
   - **正常现象**：第一条规则 Lift 区分度最好，累加第二第三条规则后，组合累积 **Lift 会逐渐下降、命中率会逐渐提升**——不要因此误判，组合的价值在于更平衡的精准率×召回率。
   - 可调参数：\`objective\`（f1/top_lift/composite/max_lift/min_hit）、\`topLiftPct\`/\`topLiftMin\`（种子）、\`branchPct\`/\`branchMin\`（每层增益遍历）、\`hitRateBudget\`、\`cutQuantiles\`、\`minSupport\`、\`minLift\`、\`maxRules\` 等。
3. 调用 \`rrd_mining\` 完成挖掘；检查返回的最优组合、**全部组合评估表**（精准率/召回率/F1/命中率/Lift，按 F1 降序）与 PR 曲线；如不理想，调整参数（如调大 branchMin/topLiftMin 遍历更充分、调整 cutQuantiles、收紧 hitRateBudget）重跑，直至「精准率×召回率平衡（F1）」达到满意。

### 第 3 步：生成 HTML 报告
1. \`rrd_mining\` 默认已生成 HTML 报告；如需调整标题/备注或重新生成，使用 \`rrd_report\`（基于挖掘快照 JSON，不重新计算）。
2. 报告必须包含以下结构：
   - 一、数据集与质量检查（字段清单、剔除原因、质量检查问题、y 分布）；
   - 二、单变量效果分析（每个特征的候选规则：命中率、命中坏率、Lift、IV 及可视化）；
   - 三、组合规则效果分析：
     - 全部评估组合及其指标（精准率、召回率、F1、命中率、Lift），按 F1 降序，最优高亮；
     - 以命中率为 x 坐标、lift 为 y 坐标展示全部组合规则的点位，最优高亮标出
       （可见累加规则后沿「命中率↑、Lift↓」移动）；
     - 以精准率、召回率为横纵坐标展示全部组合的曲线，并标注 **F1 最高点（即最优组合对应的点）**；
     - 最优组合内的所有规则以及累积的命中率和 lift 值；
   - 附录（分析配置与约束）。
3. 向用户给出报告路径与关键结论（最优组合、精准率/召回率/F1、通过率减少、组合 Lift、拒绝样本中的坏样本数）。

## 注意事项
- 若数据量很大（>5 万行），组合搜索会抽样加速，最终指标在全体数据上精确重算，报告中已注明；
- 规则表达式应可读、可上线：拒绝策略 = 命中任一规则即拒绝；
- 组合判断的本质是「精准率与召回率的平衡」：不要只报单条规则而忽略组合；单条规则也可能 P/R 双高
  （如 Titanic 的 Sex==female），此时叠加增益规则应进一步提升 F1；不要因为组合 Lift 下降就否定组合。`

// ─────────────────────────── 参数 JSON Schema（原生对象根） ───────────────────────────

const STR = { type: 'string' }
const NUM = { type: 'number' }
const INT = { type: 'integer' }
const BOOL = { type: 'boolean' }

const str = (description) => ({ type: 'string', description })
const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description })
const num = (description) => ({ type: 'number', description })
const int = (description) => ({ type: 'integer', description })

const obj = (properties, required = []) => ({
  type: 'object', 
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
})

// ─────────────────────────── 工具定义 ───────────────────────────

const COMMON_EXEC = {
  dataset: str('数据集 CSV 文件的绝对路径（必须包含表头）', true),
  target: str('目标变量 y 的列名（二分类：bad=1 / good=0，支持 true/false、good/bad、正常/违约 等写法）', true),
}

const profilingDef = {
  name: 'rrd_profiling',
  description: '【风控规则挖掘 · 第 1 步】对指定数据集进行 X/y 确认与数据质量检查：自动识别并剔除无用特征（ID、serialno、常量列、近似唯一列、高缺失列），统计字段类型/缺失率/基数、y 分布、重复行与质量问题，并给出推荐的 X 特征清单。执行完成后由你（风控专家）确认 X 清单，再进入规则挖掘。',
  parameters: obj({
    ...COMMON_EXEC,
    features: strArr('可选：显式指定 X 特征列名清单；缺省时使用自动推荐的 X'),
    exclude: strArr('可选：额外需要剔除的列名（在自动剔除基础上追加）'),
  }, ['dataset', 'target']),
  output: {
    schema: obj({
      summary: obj({
        datasetPath: STR, rows: INT, columnsTotal: INT,
        target: STR, targetMissingRows: INT, duplicateRows: INT, featureCount: INT,
      }, ['datasetPath', 'rows', 'columnsTotal', 'target', 'targetMissingRows', 'duplicateRows', 'featureCount']),
      y: obj({
        column: STR, badCount: INT, goodCount: INT, badRate: NUM,
      }, ['column', 'badCount', 'goodCount', 'badRate']),
      columns: { type: 'array', items: obj({
        name: STR, type: STR,
        missingRate: NUM, cardinality: INT,
        dropReason: STR,
      }, ['name', 'type', 'missingRate', 'cardinality', 'dropReason']) },
      recommendedFeatures: { type: 'array', items: { type: 'string' } },
      autoExcluded: { type: 'array', items: obj({ name: STR, reason: STR }, ['name', 'reason']) },
      excludedByUser: { type: 'array', items: { type: 'string' } },
      issues: { type: 'array', items: obj({ level: STR, message: STR }, ['level', 'message']) },
    }, ['summary', 'y', 'columns', 'recommendedFeatures', 'autoExcluded', 'excludedByUser', 'issues']),
    render: (_args, value) => {
      const s = value.summary, y = value.y
      const lines = [
        `数据集确认与质检完成：${s.rows.toLocaleString()} 行 × ${s.columnsTotal} 列，目标 y=${y.column}，全局坏率 ${pct(y.badRate)}。`,
        `自动剔除 ${value.autoExcluded.length} 个无用字段：${value.autoExcluded.map((e) => `${e.name}（${e.reason}）`).join('、') || '无'}。`,
        `推荐 X 特征（${value.recommendedFeatures.length} 个）：${value.recommendedFeatures.join('、') || '无'}。`,
        `质量问题 ${value.issues.length} 项：${value.issues.map((i) => i.message).join('；') || '无'}。`,
        `请确认 X 清单后调用 rrd_mining 进行规则挖掘。`,
      ]
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  execute: async (args) => {
    const dataset = await loadDataset(args.dataset)
    const profile = profileDataset(dataset, args.target, { features: args.features, exclude: args.exclude })
    return {
      summary: {
        datasetPath: resolve(args.dataset),
        rows: profile.n,
        columnsTotal: profile.columns.length + 1,
        target: profile.target,
        targetMissingRows: profile.targetMissingRows,
        duplicateRows: profile.duplicateRows,
        featureCount: profile.requestedFeatures.length,
      },
      y: { column: profile.target, badCount: profile.y.badCount, goodCount: profile.y.goodCount, badRate: profile.y.badRate },
      columns: profile.columns.map((c) => ({
        name: c.name, type: c.type, missingRate: c.missingRate, cardinality: c.cardinality, dropReason: c.dropReason || '',
      })),
      recommendedFeatures: profile.requestedFeatures,
      autoExcluded: profile.autoExcluded,
      excludedByUser: profile.excludedByUser,
      issues: profile.issues,
    }
  },
  presentCall: (args) => ({ card: 'generic', title: '数据集确认与质量检查', kind: 'other', rawInput: { dataset: args.dataset, target: args.target } }),
  timeoutMs: 120000,
}

const miningDef = {
  name: 'rrd_mining',
  description: '【风控规则挖掘 · 第 2 步】对确认后的 X/y 进行规则挖掘：单规则评估（命中率/精准率/召回率/Lift/IV）后按逐层遍历树挖掘并行(OR)组合——第一条规则取单规则 Lift 前 topLiftPct（至少 topLiftMin 个）轮番作种子；之后每层选取对当前组合「增益效果」前 branchPct（至少 branchMin 个）的规则遍历组合；停止条件为召回率无法提高。评估标准（默认 f1）：以精准率与召回率最平衡且都大（F1 最大）的组合为最优。返回最优组合、全部组合评估表（精准率/召回率/命中率/Lift/F1）、命中率-Lift 点位图、精准率-召回率曲线（标注 F1 最高点 = 最优组合），并默认生成 HTML 分析报告（第 3 步）。',
  parameters: obj({
    ...COMMON_EXEC,
    features: strArr('X 特征列名清单（第 1 步确认后的结果）；缺省时自动取推荐特征'),
    exclude: strArr('可选：额外剔除的列'),
    objective: { type: 'string', enum: ['f1', 'top_lift', 'composite', 'max_lift', 'min_hit'], description: '组合评估目标：f1=精准率与召回率最平衡且都大（F1 最大，默认）；top_lift=组合 Lift 降序取前 topLiftPct 内筛选命中率最小者；composite=lift×(1−命中率) 最大；max_lift=预算内最大化 lift；min_hit=lift 达标下最小化命中率' },
    topLiftPct: num('第一条规则：取单规则 Lift 前百分之几作种子，0~1，默认 0.05'),
    topLiftMin: int('第一条规则：种子数下限，默认 5'),
    branchPct: num('逐层扩展：对当前组合增益效果前百分之几的规则遍历组合，0~1，默认 0.05'),
    branchMin: int('逐层扩展：每层遍历的候选规则数下限，默认 3'),
    hitRateBudget: num('组合命中率（通过率减少）预算上限，0~1，默认 0.5'),
    minBadCoverage: num('坏样本召回率下限（0~1），仅 legacy 目标（composite/max_lift/min_hit）生效，默认 0（不启用）'),
    minSupport: num('单规则最小支持度（命中占比），默认 0.01'),
    minLift: num('单规则最小 Lift，默认 1.05'),
    cutQuantiles: { type: 'array', items: { type: 'integer' }, description: '连续变量的切分阈值（分位数 %，0~100）：对每个阈值遍历「选小(<=)/选大(>=)」两个方向生成候选规则。默认 [1,3,5,95,97,99] 共 6 个' },
    maxCandidates: int('候选规则池上限，默认 14（1~40）'),
    maxRulesPerFeature: int('每个特征保留的候选规则数，默认 5'),
    maxRules: int('组合规则条数上限，默认 8（1~12）'),
    generateReport: { type: 'boolean', description: '是否生成 HTML 报告，默认 true' },
    reportDir: str('HTML 报告与挖掘快照的输出目录；缺省为数据集所在目录'),
    title: str('可选：报告标题，默认「风控规则挖掘分析报告」'),
  }, ['dataset', 'target']),
  output: {
    schema: obj({
      summary: obj({
        dataset: STR, rows: INT, target: STR,
        featuresUsed: { type: 'array', items: { type: 'string' } },
      }, ['dataset', 'rows', 'target', 'featuresUsed']),
      final: obj({
        rules: { type: 'array', items: obj({
          expression: STR,
          single: obj({ hitRate: NUM, lift: NUM, badRateHit: NUM, support: INT }, ['hitRate', 'lift', 'badRateHit', 'support']),
          cumulative: obj({ hitRate: NUM, passRateReduction: NUM, badRateHit: NUM, lift: NUM, badCoverage: NUM, rejected: INT, badCount: INT }, ['hitRate', 'passRateReduction', 'badRateHit', 'lift', 'badCoverage', 'rejected', 'badCount']),
          marginalGain: obj({ dHitRate: NUM, dLift: NUM }, ['dHitRate', 'dLift']),
        }, ['expression', 'single', 'cumulative', 'marginalGain']) },
        hitRate: NUM, passRateReduction: NUM,
        passRate: NUM, badRateHit: NUM,
        precision: NUM, recall: NUM, f1: NUM,
        lift: NUM, rejected: INT, badCount: INT,
        badCoverage: NUM, coverageMet: BOOL,
        globalBadRate: NUM, objectiveScore: NUM,
      }, ['rules', 'hitRate', 'passRateReduction', 'passRate', 'badRateHit', 'precision', 'recall', 'f1', 'lift', 'rejected', 'badCount', 'badCoverage', 'coverageMet', 'globalBadRate', 'objectiveScore']),
      singleRules: { type: 'array', items: obj({
        feature: STR, type: STR,
        rules: { type: 'array', items: obj({
          expression: STR, kind: STR, support: INT, hitRate: NUM, badRateHit: NUM, lift: NUM, iv: NUM, score: NUM,
        }, ['expression', 'kind', 'support', 'hitRate', 'badRateHit', 'lift', 'iv', 'score']) },
      }, ['feature', 'type', 'rules']) },
      combos: { type: 'array', items: obj({
        rank: INT,
        rules: { type: 'array', items: { type: 'string' }, description: '组合内的规则表达式（并行 OR）' },
        precision: NUM, recall: NUM, hitRate: NUM, lift: NUM, f1: NUM,
        inTopPct: BOOL, isChosen: BOOL,
      }, ['rank', 'rules', 'precision', 'recall', 'hitRate', 'lift', 'f1', 'inTopPct', 'isChosen']) },
      selection: obj({
        objective: STR, topLiftPct: NUM, topLiftMin: INT,
        branchPct: NUM, branchMin: INT,
        topCount: INT, allComboCount: INT, displayedCount: INT,
      }, ['objective', 'topLiftPct', 'topLiftMin', 'branchPct', 'branchMin', 'topCount', 'allComboCount', 'displayedCount']),
      prCurve: { type: 'array', items: obj({ recall: NUM, precision: NUM }, ['recall', 'precision']) },
      consideredCandidates: { type: 'array', items: obj({
        expression: STR, hitRate: NUM, lift: NUM, score: NUM, selected: BOOL,
      }, ['expression', 'hitRate', 'lift', 'score', 'selected']) },
      options: obj({
        objective: STR, minSupport: NUM, minLift: NUM, hitRateBudget: NUM, minBadCoverage: NUM,
        topLiftPct: NUM, topLiftMin: INT, branchPct: NUM, branchMin: INT,
        cutQuantiles: { type: 'array', items: { type: 'integer' } },
        maxCandidates: INT, maxRulesPerFeature: INT, maxRules: INT,
        downsampled: BOOL, candidateCount: INT,
      }, ['objective', 'minSupport', 'minLift', 'hitRateBudget', 'minBadCoverage', 'topLiftPct', 'topLiftMin', 'branchPct', 'branchMin', 'cutQuantiles', 'maxCandidates', 'maxRulesPerFeature', 'maxRules', 'downsampled', 'candidateCount']),
      report: obj({ generated: BOOL, path: STR, basename: STR }, ['generated', 'path', 'basename']),
      snapshot: obj({ path: STR, savedAt: STR }, ['path', 'savedAt']),
    }, ['summary', 'final', 'singleRules', 'combos', 'selection', 'prCurve', 'consideredCandidates', 'options', 'report', 'snapshot']),
    render: (_args, value) => {
      const f = value.final
      const sel = value.selection
      const objDesc = {
        f1: 'F1 最大（精准率×召回率最平衡）',
        top_lift: `Lift 降序前 ${sel.topCount} 个内命中率最小`,
        composite: 'lift×(1−命中率) 最大',
        max_lift: '预算内最大化 lift',
        min_hit: 'lift 达标下最小化命中率',
      }[sel.objective] || sel.objective
      const lines = [
        `规则挖掘完成：候选规则池 ${value.options.candidateCount} 条，逐层遍历树评估组合 ${sel.allComboCount} 个（种子=单规则 Lift 前 ${sel.topLiftMin}~ 个轮番；每层按增益前 ${sel.branchMin}~ 条遍历；召回率无法提高即停止）。`,
        `评估目标：${objDesc}。`,
        `最优并行组合 ${f.rules.length} 条：`,
        f.rules.map((r, i) => `  ${i + 1}. ${r.expression}`).join('\n'),
        `最终效果：精准率 ${pct(f.precision)}，召回率 ${pct(f.recall)}，F1 = ${f.f1.toFixed(3)}，命中率（通过率减少）${pct(f.hitRate)}，Lift = ${f.lift.toFixed(2)}（全局坏率 ${pct(f.globalBadRate)}）。`,
        `拒绝 ${f.rejected.toLocaleString()} 个样本，其中坏样本 ${f.badCount.toLocaleString()} 个。`,
        value.report.path ? `HTML 报告已生成：${value.report.path}` : '未生成 HTML 报告。',
        `如需调整（objective/topLiftPct/branchPct/branchMin/hitRateBudget/cutQuantiles 等），可修改参数后重跑。`,
      ]
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  execute: async (args) => {
    const dataset = await loadDataset(args.dataset)
    const profile = profileDataset(dataset, args.target, { features: args.features, exclude: args.exclude })
    const features = args.features && args.features.length ? args.features : profile.requestedFeatures
    if (features.length === 0) throw new Error('没有可用于规则挖掘的特征：请先在 rrd_profiling 中确认 X 清单')
    const mining = mineRules(dataset, args.target, features, {
      objective: args.objective || 'f1',
      topLiftPct: numberArg(args.topLiftPct, 0.05, 0.001, 1, 'topLiftPct'),
      topLiftMin: intArg(args.topLiftMin, 5, 1, 100, 'topLiftMin'),
      branchPct: numberArg(args.branchPct, 0.05, 0.001, 1, 'branchPct'),
      branchMin: intArg(args.branchMin, 3, 1, 50, 'branchMin'),
      hitRateBudget: numberArg(args.hitRateBudget, 0.5, 0.0001, 1, 'hitRateBudget'),
      minSupport: numberArg(args.minSupport, 0.01, 0.0001, 1, 'minSupport'),
      minLift: numberArg(args.minLift, 1.05, 1, 100, 'minLift'),
      cutQuantiles: cutQuantilesArg(args.cutQuantiles),
      minBadCoverage: numberArg(args.minBadCoverage, 0, 0, 1, 'minBadCoverage'),
      maxCandidates: intArg(args.maxCandidates, 14, 1, 40, 'maxCandidates'),
      maxRulesPerFeature: intArg(args.maxRulesPerFeature, 5, 1, 20, 'maxRulesPerFeature'),
      maxRules: intArg(args.maxRules, 8, 1, 12, 'maxRules'),
    })

    const snapshot = {
      meta: {
        datasetPath: resolve(args.dataset),
        title: args.title || '风控规则挖掘分析报告',
        note: '由 risk_rule_design 插件生成',
        generatedAt: timestamp(),
      },
      profile: stripProfile(profile),
      mining,
    }
    let report = { generated: false, path: '', basename: '' }
    let snap = { path: '', savedAt: '' }
    if (args.generateReport !== false) {
      const dir = await reportDirOf(args.reportDir, args.dataset)
      const ts = timestamp()
      const htmlPath = join(dir, `risk_rule_report_${ts}.html`)
      const snapPath = join(dir, `risk_rule_mining_${ts}.json`)
      await mkdir(dir, { recursive: true })
      await writeFile(htmlPath, buildReport({
        profile: stripProfile(profile), mining,
        meta: { ...snapshot.meta, generatedAt: ts },
      }), 'utf8')
      await writeFile(snapPath, JSON.stringify(snapshot, null, 2), 'utf8')
      report = { generated: true, path: htmlPath, basename: basename(htmlPath) }
      snap = { path: snapPath, savedAt: ts }
    }
    return {
      summary: { dataset: resolve(args.dataset), rows: profile.n, target: args.target, featuresUsed: features },
      final: mining.final,
      singleRules: mining.singleRules,
      combos: mining.combos,
      selection: mining.selection,
      prCurve: mining.prCurve,
      consideredCandidates: mining.consideredCandidates,
      options: mining.options,
      report,
      snapshot: snap,
    }
  },
  presentCall: (args) => ({ card: 'generic', title: '风控规则挖掘', kind: 'other', rawInput: { dataset: args.dataset, target: args.target, features: args.features } }),
  timeoutMs: 600000,
}

const reportDef = {
  name: 'rrd_report',
  description: '【风控规则挖掘 · 第 3 步】基于 rrd_mining 保存的挖掘快照 JSON 重新生成（或调整）HTML 分析报告，不重新计算规则。报告包含：一、数据集与质量检查；二、单变量效果分析；三、组合规则效果分析（全部组合评估表、命中率-Lift 点位图、精准率-召回率曲线与 F1 最高点）；附录：分析配置。',
  parameters: obj({
    snapshot: str('rrd_mining 返回的 snapshot.path（挖掘快照 JSON 的绝对路径）', true),
    reportDir: str('可选：报告输出目录；缺省为快照所在目录'),
    title: str('可选：覆盖报告标题'),
    note: str('可选：追加到报告附录的备注文字'),
  }, ['snapshot']),
  output: {
    schema: obj({
      summary: obj({ snapshot: STR, reportPath: STR, title: STR, generatedAt: STR }, ['snapshot', 'reportPath', 'title', 'generatedAt']),
    }, ['summary']),
    render: (_args, value) => [{ type: 'text', text: `报告已生成：${value.summary.reportPath}\n标题：${value.summary.title}\n快照来源：${value.summary.snapshot}` }],
  },
  execute: async (args) => {
    let snapshot
    try {
      snapshot = JSON.parse(await readFile(args.snapshot, 'utf8'))
    } catch (e) {
      throw new Error(`无法读取挖掘快照 ${args.snapshot}: ${e.message}。请先运行 rrd_mining（generateReport=true）生成快照。`)
    }
    if (!snapshot.mining || !snapshot.profile) throw new Error('快照格式不正确：缺少 mining/profile 字段')
    const dir = await reportDirOf(args.reportDir, args.snapshot)
    const ts = timestamp()
    const htmlPath = join(dir, `risk_rule_report_${ts}.html`)
    await mkdir(dir, { recursive: true })
    const meta = {
      datasetPath: snapshot.meta.datasetPath,
      title: args.title || snapshot.meta.title || '风控规则挖掘分析报告',
      note: args.note || snapshot.meta.note || '',
      generatedAt: ts,
    }
    await writeFile(htmlPath, buildReport({ profile: snapshot.profile, mining: snapshot.mining, meta }), 'utf8')
    return { summary: { snapshot: args.snapshot, reportPath: htmlPath, title: meta.title, generatedAt: ts } }
  },
  presentCall: (args) => ({ card: 'generic', title: '生成规则挖掘 HTML 报告', kind: 'other', rawInput: { snapshot: args.snapshot } }),
  timeoutMs: 120000,
}

// ─────────────────────────── 工具函数 ───────────────────────────

async function loadDataset(path) {
  if (!path || typeof path !== 'string') throw new Error('dataset 必须为 CSV 文件路径（字符串）')
  const abs = resolve(path)
  let text
  try {
    text = await readFile(abs, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`找不到数据集文件: ${abs}`)
    throw new Error(`读取数据集失败: ${abs} (${e.message})`)
  }
  return parseCsv(text)
}

function stripProfile(profile) {
  const { columnsData, ...rest } = profile
  return rest
}

function numberArg(v, dflt, min, max, label) {
  if (v === undefined || v === null) return dflt
  const x = Number(v)
  if (!Number.isFinite(x)) throw new Error(`${label} 必须是数字`)
  if (x < min || x > max) throw new Error(`${label} 必须在 [${min}, ${max}] 之间`)
  return x
}

function intArg(v, dflt, min, max, label) {
  const x = numberArg(v, dflt, min, max, label)
  if (!Number.isInteger(x)) throw new Error(`${label} 必须是整数`)
  return x
}

function cutQuantilesArg(v) {
  if (v === undefined || v === null) return [1, 3, 5, 95, 97, 99]
  if (!Array.isArray(v) || v.length === 0) throw new Error('cutQuantiles 必须是非空数组（分位数 %，0~100）')
  const out = []
  for (const q of v) {
    const x = Number(q)
    if (!Number.isInteger(x) || x <= 0 || x >= 100) throw new Error(`cutQuantiles 的每个取值必须是 0~100 之间的整数，收到: ${q}`)
    if (!out.includes(x)) out.push(x)
  }
  return out
}

async function reportDirOf(reportDir, datasetPath) {
  if (reportDir && typeof reportDir === 'string') return resolve(reportDir)
  const abs = resolve(datasetPath)
  return isAbsolute(abs) ? dirname(abs) : process.cwd()
}

function timestamp() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ─────────────────────────── 插件主体 ───────────────────────────

export function apply(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger?.warn?.('[risk-rule-design] tools 服务不可用，跳过工具注册')
  } else {
    for (const def of [profilingDef, miningDef, reportDef]) {
      tools.register(def)
      ctx.logger?.info?.(`[risk-rule-design] 已注册工具 ${def.name}`)
    }
  }

  const skills = ctx.get('skills')
  if (skills === undefined) {
    ctx.logger?.warn?.('[risk-rule-design] skills 服务不可用，跳过技能注册')
  } else {
    skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      whenToUse: SKILL_WHEN_TO_USE,
      content: SKILL_CONTENT,
      // 加载时 validateDefinition 要求 source 为字符串（runtime 技能固定为 'runtime'），
      // 缺失会导致技能出现在目录中、加载内容时报 "loaded skill ... source must be a string"
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    })
    ctx.logger?.info?.('[risk-rule-design] 已注册技能 risk-rule-design')
  }
}
