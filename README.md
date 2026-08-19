# risk_rule_design — DeepSeek Harness 风控规则挖掘插件

一个面向 DeepSeek Harness 的第三方插件：让 Agent 以**金融风控专家**身份，对指定数据集（X/y）进行
**数据质检 → 单规则挖掘 → 并行规则组合最优搜索 → HTML 分析报告**的完整流程。

插件注册 **3 个工具** + **1 个专家技能**：

| 能力 | 名称 | 说明 |
|---|---|---|
| 工具 | `rrd_profiling` | 第 1 步：X/y 确认与数据质量检查（自动剔除 ID/serialno/常量/近似唯一/高缺失列） |
| 工具 | `rrd_mining` | 第 2 步：单规则评估 + 并行组合最优搜索（遍历规则先后顺序）+ 默认生成 HTML 报告 |
| 工具 | `rrd_report` | 第 3 步：基于挖掘快照重新生成/调整 HTML 报告 |
| 技能 | `risk-rule-design` | 专家方法论（角色、流程、评判标准、报告结构），可被模型/用户加载 |

---

## 目录结构

```
risk_rule_design/
├── cordis.yml            # 插件补丁覆盖层（绝对路径版，源码直挂用 --patch 或合并进 profile）
├── cordis.patch.yml      # 插件补丁（npm 包形态，发布后由 dsh plugin 安装）
├── package.json          # npm 发布清单（零依赖）
├── LICENSE               # MIT
├── src/
│   ├── index.js          # 插件入口：注册工具与技能（零外部依赖）
│   ├── engine.js         # 挖掘引擎：CSV 解析、质检、单规则、组合搜索（纯逻辑）
│   └── report.js         # 自包含 HTML 报告生成（内联 CSS/SVG，无外部资源）
├── demo/
│   ├── make_demo_data.mjs    # 演示数据集生成器（含已知潜在规则结构）
│   └── report/smoke_report.html  # 演示输出样例（生成物，不入库）
└── test/
    ├── smoke.mjs         # 引擎 + 报告冒烟测试
    ├── load_plugin.mjs   # 插件模块加载测试（桩 ctx）
    └── run_tools.mjs     # 3 个工具端到端执行 + schema 一致性校验
```

## 安装

插件是**纯 JavaScript（ESM）**，零构建、零外部依赖，仅使用 Node 内置模块，因此可在任何 dsh profile
中以绝对路径加载（与[插件教程](index.zh.md)的 insert 方式一致）。

### 方式一：合并进 web profile（推荐，持久生效）

编辑 `C:\Users\yaodyu\.dsh\profiles\web\cordis.patch.yml`，追加：

```yaml
- insert:
    - id: risk-rule-design
      name: 'D:\2. 学习\00-AI\dsh\risk_rule_design\src\index.js'
```

### 方式二：启动参数临时加载

```sh
dsh web --patch "D:\2. 学习\00-AI\dsh\risk_rule_design\cordis.yml"
```

> ⚠️ 插件在 dsh **启动时**加载，安装后需重启 `dsh web` 才会生效。
> 启动日志中会出现 `[risk-rule-design] 已注册工具 rrd_profiling / rrd_mining / rrd_report`
> 与 `已注册技能 risk-rule-design`。

## 使用流程（专家工作流）

在会话中让 Agent 按以下顺序调用工具（Agent 加载技能 `risk-rule-design` 后会遵循完整方法论）：

1. **确认 X/y**：`rrd_profiling`，参数 `dataset`（CSV 绝对路径）、`target`（y 列名，二分类）。
   返回字段清单、自动剔除原因、质量问题、推荐 X 特征。Agent 作为风控专家复核 X 清单。
2. **规则挖掘**：`rrd_mining`，参数 `dataset`、`target`、`features`（第 1 步确认的 X）。
   返回最优并行组合、顺序与累计指标、帕累托前沿，并默认写出 HTML 报告与挖掘快照 JSON。
3. **（可选）重出报告**：`rrd_report`，参数 `snapshot`（上一步返回的 snapshot.path），
   可覆盖标题/备注，不重新计算。

```
rrd_profiling(dataset, target)
   ↓ 确认 X 清单
rrd_mining(dataset, target, features, [objective, hitRateBudget, minBadCoverage, ...])
   ↓ 输出最优组合 + HTML 报告 + 快照
rrd_report(snapshot, [title, note])   # 可选
```

## 方法论

### 连续变量：遍历切分阈值

连续型变量的切分阈值是无限维的，为控制计算量，引擎对每个连续特征遍历一组**选定分位数**
（默认 `cutQuantiles=[1,3,5,95,97,99]`，6 个阈值），对每个阈值同时尝试两个方向
（**选小** `x <= q` / **选大** `x >= q`），方向与阈值是否入选由数据实际决定（命中率/Lift 过滤 + 排序截断）。
阈值集合可通过 `cutQuantiles` 参数自定义——即"阈值也是挖掘维度"。

### 并行（OR）组合：逐层遍历树

- 规则集为**并行（OR）**语义：命中任一规则即拒绝。
- 挖掘流程（逐层递进）：
  1. **第一条规则**：取所有单条规则中 **Lift 最高**的前 `topLiftPct`（至少 `topLiftMin` 个），
     这 top 个单规则**轮番作为第一条规则**（每个建立一个搜索分支）；
  2. **第二条及以后**：对当前已锁定组合，评估每个候选规则的「增益效果」（组合效果提升，
     且必须提高召回率），按增益降序取前 `branchPct`（至少 `branchMin` 个）的规则**遍历组合**，
     每个再递归扩展下一层；
  3. **停止条件**：**召回率无法提高**（或达到 `maxRules`）。
- 收集的搜索树节点 = 全部评估组合（集合内完全冗余的规则自动移除）。
- **正常现象**：第一条规则 Lift 区分度最好，累加后续规则后组合累积 **Lift 会逐渐下降、命中率会逐渐提升**。

### 效果判断（精准率与召回率的平衡，默认 f1）

- **精准率 Precision** = 命中样本中坏样本占比（命中坏浓度）；
- **召回率 Recall** = 命中样本中坏样本 / 全部坏样本；
- **命中率 HitRate** = 命中样本占比（= 通过率减少）；
- **Lift** = 精准率 / 全局坏率；
- **F1 = 2·P·R/(P+R)**：精准率与召回率的最平衡点。

**判定标准（默认 f1）**：在全部评估组合中，以**精准率与召回率最平衡且都大（F1 最大）**的组合为最优；
并列时取 Lift 更大、命中率更小。**展示**（组合评估表、命中率×Lift 点位图、PR 曲线）使用全部评估组合
（按 F1 降序）。`top_lift` / `composite` / `max_lift` / `min_hit` 为备选目标。

> 说明：Titanic 上 `Sex == "female"` 单规则 P=74.2%、R=68.1% 是真实的（规则同时覆盖大比例坏样本且坏浓度高，P/R 并不必然此消彼长）；在其上叠加 `Age <= 4`、`Fare >= 249.01` 后 F1 进一步升至 0.732（R 升到 73.1%、P 略降），正是逐层增益累积的价值。

### 目标函数（objective）

| 取值 | 含义 |
|---|---|
| `f1`（默认） | 精准率与召回率最平衡且都大（F1 最大） |
| `top_lift` | 组合按 Lift 降序取前 topLiftPct（≥topLiftMin 个）内命中率最小者 |
| `composite` | 最大化 `lift × (1 − 命中率)` |
| `max_lift` | 在命中率预算内最大化 Lift |
| `min_hit` | 在 Lift 达标下最小化命中率 |

### 主要参数（rrd_mining）

| 参数 | 默认 | 说明 |
|---|---|---|
| `objective` | f1 | 组合评估目标（见上表） |
| `topLiftPct` | 0.05 | 第一条规则：取单规则 Lift 前百分之几作种子 |
| `topLiftMin` | 5 | 第一条规则：种子数下限 |
| `branchPct` | 0.05 | 逐层扩展：对当前组合增益前百分之几的规则遍历组合 |
| `branchMin` | 3 | 逐层扩展：每层遍历的候选规则数下限 |
| `minSupport` | 0.01 | 单规则最小命中占比 |
| `minLift` | 1.05 | 单规则最小 Lift |
| `cutQuantiles` | [1,3,5,95,97,99] | 连续变量切分阈值（分位数 %，0~100），每个阈值遍历选小/选大两个方向 |
| `hitRateBudget` | 0.5 | 组合命中率（通过率减少）预算上限 |
| `minBadCoverage` | 0（不启用） | 召回率下限，仅 legacy 目标（composite/max_lift/min_hit）生效 |
| `maxCandidates` | 14 | 候选规则池上限 |
| `maxRulesPerFeature` | 5 | 每特征候选规则数 |
| `maxRules` | 8 | 组合条数上限 |
| `generateReport` | true | 是否生成 HTML 报告 |
| `reportDir` | 数据集目录 | 报告与快照输出目录 |

## HTML 报告结构

1. **一、数据集与质量检查**：样本/字段/坏率概览、字段清单与剔除决策、质量检查问题、y 分布；
2. **二、单变量效果分析**：每个特征的候选规则（命中率、命中坏率、Lift、IV）与可视化条形图；
3. **三、组合规则效果分析**：
   - 最优组合总览卡片（精准率、召回率、F1、命中率、Lift、拒绝样本数）；
   - 最优组合内所有规则 + 累积命中率 / Lift / 召回率 / 边际增益明细；
   - **全部组合评估表**（按 F1 降序）：排名、组合规则、精准率、召回率、F1、命中率、Lift，
     最优高亮（top_lift 目标时 ⭐ 标注 top5%）；
   - **命中率 × Lift 点位图**：全部组合散点，最优高亮（可见累加规则后沿「命中率↑、Lift↓」移动）；
   - **精准率-召回率曲线**：全部组合曲线，标注 **F1 最高点（即最优组合对应的点）**，而非拐点；
   - 候选规则池与入选情况；
4. **附录**：分析配置与约束说明。

报告为**自包含 HTML**（内联 CSS/SVG，无外部资源），可直接用浏览器打开。

## 演示

```sh
# 1) 生成演示数据（8000 行，含已知潜在规则结构）
node demo/make_demo_data.mjs demo/demo_credit_data.csv 8000

# 2) 引擎 + 报告冒烟测试
node test/smoke.mjs

# 3) 插件加载测试 + 工具端到端测试（输出与 schema 一致性校验）
node test/load_plugin.mjs
node test/run_tools.mjs
```

演示数据 8000 行：14 列（含 id、serialno 两个无用字段），目标 `default_flag`（全局坏率约 20%）。
按默认 f1 标准（逐层遍历树 + F1 最大）挖掘，预期最优为多规则组合（F1 显著优于最优单规则）；
报告中展示全部组合评估表（按 F1 降序）、命中率-Lift 点位图与 PR 曲线（标注 F1 最高点）。
样例报告见 `demo/report/smoke_report.html`。

## 注意事项

- **文件访问**：插件直接使用 Node 文件系统读写用户指定路径（读取数据集、写出报告与快照），
  不受 DSH 文件沙箱约束——请仅对可信数据路径使用本插件；
- **性能**：大样本（>5 万行）组合搜索会自动抽样加速，最终指标在全体数据上精确重算并在报告中注明；
  默认参数下完整流程通常数秒至数十秒内完成；
- **y 要求**：必须为二分类（0/1、true/false、good/bad、正常/违约 等写法均可）；目标列缺失的行会被
  自动剔除（"target 为空不纳入统计"）；
- **数据泄漏提醒**：若出现 F1≈1.0 或"完美规则"，通常是 `status`/`result`/到期日等**结果态字段**
  泄漏了目标信息，请用 `exclude` 剔除后重跑；
- **目标不平衡**：坏率极低（如 <1%）时 F1 天然偏小，判断规则优劣请重点看 Lift 与拒绝成本。

## 发布到 GitHub / npm / 社区

本项目为 DeepSeek Harness 第三方插件（非官方），纯 JS 零依赖，发布前无需构建。

### GitHub 分享

```sh
git init
git add .
git commit -m "feat: risk_rule_design - 风控规则挖掘插件（F1 平衡 + 逐层遍历树）"
git branch -M main
git remote add origin https://github.com/<你的用户名>/risk-rule-design.git
git push -u origin main
```

（GitHub 网页端先创建同名空仓库；或安装 [GitHub CLI](https://cli.github.com) 后
`gh repo create risk-rule-design --public --source=. --push` 一步完成。）

### npm 发布（DSH 生态标准形态）

1. 修改 `package.json` 的 `name` 为全网唯一名称（建议 scope 化：`@<用户名>/dsh-risk-rule-design`）；
2. `npm publish`（需 npm 账号，且包名未被占用）；
3. 用户安装：`dsh plugin --profile web install dsh-plugin-risk-rule-design`，重启后生效。

> 包内 `cordis.patch.yml` 使用包名解析（loader 以 profile 目录为锚），与根目录
> `cordis.yml`（绝对路径版）二选一使用。

### 社区渠道

- **DeepSeek Harness 官方仓库** `github.com/deepseek-ai/deepseek-harness` 的 Discussions 发帖自荐，
  附 GitHub 链接与报告截图；
- 技术社区（CSDN/掘金/知乎）写方法论文章（"风控规则挖掘：逐层遍历树 + F1 平衡"），文末挂仓库链接。

