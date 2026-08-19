# risk_rule_design：DeepSeek Harness 第一个风控规则挖掘插件

## 一、插件介绍

一个面向 DeepSeek Harness 的第三方插件：蒸馏《[100天风控专家](https://bzavt.xetlk.com/s/2Y1t7x)》的思想和方法论，对指定数据集（X/y）进行
**数据质检 → 单规则挖掘 → 并行规则集最优组合 → HTML分析报告** 的完整流程，解决风控策略人员手动调策略的过程，提高工作效率。

插件注册 **3 个工具** + **1 个专家技能**：

| 能力 | 名称 | 说明 |
|---|---|---|
| 工具 | `rrd_profiling` | 第 1 步：X/y 确认与数据质量检查（自动剔除 ID/serialno/常量/近似唯一/高缺失列） |
| 工具 | `rrd_mining` | 第 2 步：单规则评估 + 并行规则集最优组合（遍历规则先后顺序）+ 默认生成 HTML 报告 |
| 工具 | `rrd_report` | 第 3 步：基于挖掘快照重新生成/调整 HTML 报告 |
| 技能 | `risk-rule-design` | 专家方法论（角色、流程、评判标准、报告结构），可被模型/用户加载 |

---

## 二、目录结构

```
risk_rule_design/
├── cordis.yml            # 插件补丁覆盖层（绝对路径版，源码直挂用 --patch 或合并进 profile）
├── cordis.patch.yml      # 插件补丁（npm 包形态，发布后由 dsh plugin 安装）
├── package.json          # npm 发布清单（零依赖）
├── LICENSE               # MIT
├── src/
│   ├── index.js          # 插件入口：注册工具与技能（零外部依赖）
│   ├── engine.js         # 挖掘引擎：CSV 解析、质检、单规则、组合规则搜索（纯逻辑）
│   └── report.js         # 自包含 HTML 报告生成（内联 CSS/SVG，无外部资源）
├── demo/
│   ├── make_demo_data.mjs    # 演示数据集生成器（含已知潜在规则结构）
│   └── report/smoke_report.html  # 演示输出样例（生成物，不入库）
└── test/
    ├── smoke.mjs         # 引擎 + 报告冒烟测试
    ├── load_plugin.mjs   # 插件模块加载测试（桩 ctx）
    └── run_tools.mjs     # 3 个工具端到端执行 + schema 一致性校验
```

## 三、安装

插件是**纯 JavaScript（ESM）**，零构建、零外部依赖。

### 方式一：从Github安装

```bash
dsh plugin --profile web add "github:pypcfx-glitch/risk-rule-design"
```

### 方式二：从npm安装

待补充

## 四、使用流程

如何使用这个插件？

为了解决风控策略/数据分析人员的双手，你只需要准备分析样本即可（样本中需包括特征X和目标变量y）。

下面提供一个简单的对话命令模版。

敲入`/`调用插件risk-rule-design（安装成功后敲入risk应该会自动显示出来），然后将分析样本的绝对文件路径copy过来，并说明y的字段名。

最后执行就可以了。

```
/risk-rule-design
D:\...\model_data_v1.0.xlsx
分析这个数据集，剔除y_label_30和y_label_7，其中y_label_15是y，X请自行判断。
```

插件`risk-rule-design`会按照规则挖掘的分析流程自动执行，并生成报告，执行流转步骤如下：

rrd_profiling(dataset, target)
   ↓ 确认 X 清单
rrd_mining(dataset, target, features, [objective, hitRateBudget, minBadCoverage, ...])
   ↓ 输出最优组合 + HTML 报告 + 快照
rrd_report(snapshot, [title, note])   # 可选

## 五、HTML报告结构及展示

1. **一、数据集与质量检查**：样本/字段/坏率概览、字段清单与剔除决策、质量检查问题、y 分布；
![alt text](pic1.png)
2. **二、单变量效果分析**：每个特征的候选规则（命中率、命中坏率、Lift、IV）与可视化条形图；
![alt text](pic2.png)
3. **三、组合规则效果分析**：
   - 最优组合总览卡片（精准率、召回率、F1、命中率、Lift、拒绝样本数）；
   - 最优组合内所有规则 + 累积命中率 / Lift / 召回率 / 边际增益明细；
   ![alt text](pic3.png)
   ![alt text](pic4.png)
   - **全部组合评估表**（按 F1 降序）：排名、组合规则、精准率、召回率、F1、命中率、Lift，
     最优高亮（top_lift 目标时 ⭐ 标注 top5%）；
     ![alt text](pic5.png)
   - **命中率 × Lift 点位图**：全部组合散点，最优高亮（可见累加规则后沿「命中率↑、Lift↓」移动）；
   ![alt text](pic6.png) 
   - **精准率-召回率曲线**：全部组合曲线，标注 **F1 最高点（即最优组合对应的点）**，而非拐点；
   ![alt text](pic7.png)
   - 候选规则池与入选情况；
4. **附录**：分析配置与约束说明。

报告为**自包含 HTML**（内联 CSS/SVG，无外部资源），可直接用浏览器打开。

---

**这个插件是东哥的第一个dsh插件，正在慢慢熟悉中，如使用中有不妥支持，欢迎指正。**
