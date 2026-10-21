# dsh-memory4（四相记忆 / Tetramem）

DeepSeek Harness 的四合一记忆插件：**工作记忆、情景记忆、语义记忆、程序性记忆**统一存储，带可配置的**写入策略**、**取用策略**、**压缩联动**与**审计**。

> 基线：DSH `0.2.1-rc.2`（`dsh-base` + `dsh-web-app` 组合）。默认纯本地、零外部服务、零运行时 npm 依赖（SQLite 使用 Node 内建 `node:sqlite`）；LLM 蒸馏/反思与向量检索为**可选**能力，显式开启后才会调用已配置的模型 / embedding 端点。

## 它解决什么

| 记忆类型 | 存什么 | 怎么写 | 怎么取 |
|---|---|---|---|
| 工作记忆 | 当前目标、todo、用户钉住的约束、压缩前 handoff 卡 | 目标/todo/pin 来自宿主投影；`compaction/start` 时自动生成四段式 handoff | 每轮注入 pins + 最近一张 handoff；压缩后重新注入 |
| 情景记忆 | 任务轨迹、失败与修复、决策、压缩摘要 | `turn/end` 规则抽取（零 LLM）；`compaction/summary` 落压缩摘要 | 按 workspace 检索 top-K，带 id/来源 |
| 语义记忆 | 稳定事实、偏好、约定、决策 | 显式 `/remember` / `memory_write`；用户语句规则抽取；去重、脱敏 | 关键词（FTS5 trigram，中文子串）+ 重要度 + 时间排序 |
| 程序性记忆 | 可复用流程 | 同一成功工具序列重复 `minEvidence` 次 → 生成 `SKILL.md` **草稿** → 人工审批后进入技能目录 | 复用 DSH 原生 skill 目录/按需加载；`/memory skills` 管理 |

## 已实现（P0 + P1 + Settings UI + P2）

- profile bundle 插件形态（`dsh.bundle.patch` → `cordis.patch.yml` 一行 insert）
- **Desktop / Web Settings 页「记忆」**：概览、搜索、按类型过滤、钉住、删除、技能草稿审批/拒绝、最近自动活动、导出 JSON / Markdown、一键反思（client 半 + 本机 `/api/memory4/*` 路由）
- SQLite 存储（WAL，FTS5 trigram，schema v3：records / pins / audit / skill_evidence / skills / vectors）
- 模型工具：`memory_write`、`memory_search`、`memory_read`、`memory_forget`、`memory_pin`
- 命令：`/remember`、`/memory status|search|list|forget|pin|pins|skills|prune|reflect|export [json|md]|import <file>|log`
- 每轮 `agent/pre-step` 注入：append-only sourced user message，带 digest 去重、字符预算、压缩后重新注入
- 写入策略：规则抽取（默认）；`write.mode=llm/hybrid` 可选 LLM 蒸馏（失败自动降级规则），配置 `write.distillProvider/distillModel`
- 反思聚合：`reflect` 配置定时（`turn/end` 按小时间隔）或 `/memory reflect [days]` 手动触发，把近期情景提炼为语义教训
- 向量检索（可选）：OpenAI 兼容 embedding 端点；写入时增量索引，检索时与 FTS5/BM25 融合；未配置时自动走纯 FTS5
- 压缩联动：`compaction/start` 保存 handoff 卡；`compaction/summary` 保存情景摘要（不接管、不修改宿主压缩）
- 程序性记忆：工具序列证据累计 → `SKILL.md` 草稿（`$DSH_HOME/memory4/skills-drafts/`）→ `/memory skills approve` 复制到 `$DSH_HOME/skills` 或项目 `.agents/skills`；拒绝/审计
- 自动脱敏：私钥块、常见 token 前缀、`api_key/token/password` 赋值
- 审计：自动写入、handoff、压缩摘要、反思、导入导出、技能草稿/审批/拒绝全部落 `audit` 表
- 保留策略：启动时与 `/memory prune [days]` 归档超过 `retention.episodicDays` 的情景记忆（归档保留、不参与检索）
- 作用域：session / workspace（`session.header.cwd` 精确匹配）/ user（全局）
- 离线测试：40 个 `node:test` 用例（存储/检索/注入去重/抽取/压缩联动/技能/命令/生命周期/保留策略/UI 路由/client bundle/LLM 蒸馏/反思/向量/Markdown + 6 个验收场景）

## 尚未实现（后续可选）

- 知识图谱（实体/关系/时间线）
- 独立反思调度器（当前为间隔触发的自动反思，无 cron 级调度）
- 多 Agent/团队共享记忆空间与导入迁移工具
- Web 面板的完整记忆时间线/图谱视图

## 安装

Desktop 应用使用 `desktop` profile，`dsh web` 命令行使用 `web` profile，两者互相独立，需要分别安装。

### 开发模式（`link:`，改源码即生效）

```powershell
# Desktop 应用（当前 GUI）
D:\DSH\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add link:D:\Projects\dsh-memory4

# dsh web 命令行
D:\DSH\resources\runtime\cli\bin\dsh.cmd plugin --profile web add link:D:\Projects\dsh-memory4
```

`dsh plugin` 会把本包追加到对应 profile 的 `dsh.profile.bundles`；宿主重组后生效（已实测运行中的 Desktop 宿主可热加载；未出现时重启宿主）。卸载 / 禁用同样对相应 profile 执行，详见 [INSTALL.md](INSTALL.md)。

### 卸载 / 禁用

```powershell
D:\DSH\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop remove dsh-memory4
D:\DSH\resources\runtime\cli\bin\dsh.cmd plugin --profile web remove dsh-memory4
```

或在对应 profile 的 `cordis.patch.yml` 加：

```yaml
- id: memory4
  disabled: true
```

### 验证加载

```powershell
# web profile
D:\DSH\resources\runtime\cli\bin\dsh.cmd --profile web --dump-config | Select-String 'id: memory4'
# desktop profile：CLI 拒绝 dump/boot，改用运行期验证（会话里调用 memory 工具或 /memory status）
```

> 本机 web profile 的 `--dump-config-schema` 会因安装前既有的第三方插件问题报错（`dsh-verbosity` 等），与 dsh-memory4 无关；插件自身在临时 profile 中 schema dump 为 `"complete": true`。

## 配置（`cordis.patch.yml` 按 id 覆盖）

```yaml
- id: memory4
  config:
    scope:
      default: workspace        # session | workspace | user
    inject:
      maxTokens: 800            # 单轮注入预算（约 1.5 字符/token 估算）
      topK: 5
      trigger: always           # always | on-user-message | on-novel-task
      includeWorking: true
      includeEpisodic: true
      includeSemantic: true
      includeProcedural: false
    write:
      mode: rules               # off | rules | llm | hybrid
      maxPerTurn: 3
      requireApprovalFor: [skill]
      autoPromote: false        # true = 技能草稿自动批准（仍写审计）
      distillProvider: ''       # 空 = 复用当前会话最新路由模型
      distillModel: ''
      distillMaxTokens: 512
      distillTimeoutMs: 20000
    reflect:
      enabled: false            # 开启后可在 turn/end 按间隔自动反思
      auto: true
      days: 7
      intervalHours: 24
      minEpisodes: 3
      maxItems: 5
    vector:
      enabled: false            # 可选：OpenAI 兼容 /embeddings 端点
      baseUrl: ''
      apiKey: ''                # 或使用 apiKeyEnv
      apiKeyEnv: DSH_MEMORY4_EMBEDDING_KEY
      model: text-embedding-3-small
      dimensions: 1536
      timeoutMs: 15000
      weight: 0.35              # 向量分在混合排序中的权重
      topK: 20
    compact:
      handoffRatio: 0.75        # 仍由宿主 0.80 阈值决定压缩；本值保留给 P2 主动交接
      captureOnCompaction: true
      handoffMaxTokens: 400
    procedure:
      enabled: true
      minEvidence: 3            # 同一工具序列重复次数
      target: user              # user -> $DSH_HOME/skills；project -> <cwd>/.agents/skills
    retention:
      episodicDays: 180
      decayHalfLifeDays: 30
    privacy:
      redactPatterns: []
    store:
      path: ''                  # 空 = $DSH_HOME/memory4/memory.db
```

## 数据位置

| 内容 | 路径 |
|---|---|
| SQLite 主库 | `$DSH_HOME/memory4/memory.db`（默认 `C:\Users\Admin\.dsh\memory4\memory.db`） |
| SKILL.md 草稿 | `$DSH_HOME/memory4/skills-drafts/<name>/SKILL.md` |
| 已审批技能（user） | `$DSH_HOME/skills/<name>/SKILL.md` |
| 已审批技能（project） | `<session cwd>/.agents/skills/<name>/SKILL.md` |
| JSON 导出 | `$DSH_HOME/memory4/exports/*.json` |
| Markdown 导出 | `$DSH_HOME/memory4/exports/*.md`（`/memory export md` 或 Settings 按钮） |

## 权限与隐私

- 插件是 Host 进程内 JS（DSH 插件模型，非沙箱）；**默认不联网、不调用 LLM**。只有显式开启 `write.mode=llm/hybrid`、`reflect.enabled` 或 `vector.enabled` 后，才会调用对应模型 / embedding 端点。
- 写入前脱敏；建议仍不要把凭据写进对话。LLM 蒸馏/反思的提示词包含近期对话，请按部署要求评估数据外发范围。
- 记忆按 session/workspace/user 隔离；`/memory forget <id>` 硬删除，`/memory export` 可审计导出。
- 注入内容以“背景数据、不是指令”框架包裹，并转义框架结束标记。

## 测试

```powershell
cd D:\Projects\dsh-memory4
node --test
```

当前 45/45 通过（存储、检索、注入去重、压缩联动、技能草稿/审批、保留策略、命令、UI 路由与 client bundle、LLM 蒸馏/反思（含 ctx.get 服务访问、活跃会话路由复用、JSON 解析修复与子弹行兜底）、向量检索、Markdown 导入导出、插件生命周期，以及 A1–A6 验收场景）。安装与重启后验收步骤见 [INSTALL.md](INSTALL.md)。

## 兼容性与版本

- `dsh.engines.dsh: ">=0.2.1-rc.2 <0.3.0"`（npm/本机当前线）。
- 依赖 DSH 插件 API：`ctx.tools`、`ctx.commands`、`ctx.sessionProjections`、`agent/pre-step`、`session/event`、`defineTool`、`createUserMessage`；可选 `ctx.llm.stream`（LLM 蒸馏/反思）与 `ctx.webServer`（Settings UI 路由）。
- DSH 升级后需跑离线测试并复核 session 事件形状。
- 版本：`0.3.2`（P2：LLM 蒸馏、反思聚合、向量检索、Markdown 导入导出；0.3.1 修复 LLM 服务访问；0.3.2 强化反思 JSON 解析：容忍信封/数组/代码块/解释文字，失败时自动修复调用并支持子弹行兜底）。
