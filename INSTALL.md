# 安装与验收（dsh-memory4）

> 适用：本机 DSH `0.2.1-rc.2`。**Desktop 应用使用 `desktop` profile**；`dsh web` 命令行使用 `web` profile。两个 profile 各自独立，需要分别安装。

## 1. 安装

```powershell
# Desktop 应用（当前 GUI 使用）
D:\DSH\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add link:D:\Projects\dsh-memory4

# dsh web 命令（如使用 web profile）
D:\DSH\resources\runtime\cli\bin\dsh.cmd plugin --profile web add link:D:\Projects\dsh-memory4
```

`dsh plugin` 会：
1. 在 profile 目录执行 pnpm，写入依赖 `dsh-memory4 -> D:\Projects\dsh-memory4`；
2. 识别 `dsh.bundle.patch`，自动把 `dsh-memory4` 追加到 `dsh.profile.bundles`；
3. 宿主检测到 bundles 列表变化后重组；若未生效，重启对应宿主。插件已实测可在运行中的 Desktop 宿主内热加载（memory 工具与 memory-context 注入即时出现）。

## 2. 组合校验

```powershell
# web profile 可用 dump-config 校验
D:\DSH\resources\runtime\cli\bin\dsh.cmd --profile web --dump-config | Select-String -Context 2,6 'id: memory4'
```

`desktop` 是 Electron 保留的 profile，CLI 会拒绝它的 `--dump-config`/启动请求；desktop 侧以运行期验收为准（重启后在会话中调用 memory 工具或 `/memory status`）。

期望看到：

```yaml
- id: memory4
  name: dsh-memory4
  config:
    enabled: true
```

> 注意：本机 web profile 的 `--dump-config-schema` 目前会因既有第三方插件（dsh-verbosity 源目录缺失、`@linxin666` 插件与 rc.2 的 `dsh-settings` 导出不匹配）报错，属安装前已有问题，不是 dsh-memory4 引入；dsh-memory4 自身在 `memory4test` 临时 profile 中 schema dump 为 `"complete": true`。

## 3. Settings「记忆」页（client UI，0.2.0 新增）

插件 0.2.0 起带 client 半：在 **Desktop / Web 的 Settings 左侧导航**新增「记忆」页，用于浏览/搜索/钉住/删除记忆、审批技能草稿、查看自动活动与导出 JSON。**不需要另起 web 页面或端口**；它渲染在 Desktop 自身的 React 客户端里。

### 显示步骤

1. **重启 DSH Desktop**：client 元数据与 `lib/client.js` 在宿主启动时扫描并缓存，本次新增 client 半必须重启一次（当前会话会中断）。
2. 打开 **Settings**（左下角齿轮）→ 左侧导航出现 **「记忆」**。
3. 验收页面：
   - 顶部统计（记忆/归档/pins/技能草稿）；
   - 搜索框 + 类型过滤 + 刷新；
   - 记忆卡片上的「钉住（用户级）」「删除」；
   - 技能草稿「批准」「拒绝」；
   - 「导出 JSON」下载；
   - 底部数据目录与 recall 配置。
4. 若看不到页面：
   - Settings → Plugins 页查看 client 模块加载失败信息；
   - 确认 `desktop`/`web` profile 的 `dsh.profile.bundles` 含 `dsh-memory4`；
   - 打开 DevTools Console 查看 `window.__ModuleLoader__` 报错；
   - 确认 `lib/client.js` 存在且格式为 `window.__ModuleLoader__.load({ id, factory })`。

### 数据接口（仅本机回环）

client 页通过同源 `/api/memory4/*` 访问宿主持久层：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/memory4/status` | 统计 + 配置摘要 + 数据路径 |
| GET | `/api/memory4/records?query=&kind=&limit=` | 跨 scope 管理列表/搜索 |
| GET | `/api/memory4/skills` | 技能草稿/已批准列表 |
| GET | `/api/memory4/log?limit=` | 最近审计 |
| GET | `/api/memory4/export` | 全量 JSON 导出 |
| POST | `/api/memory4/forget` | `{ id }` 删除 |
| POST | `/api/memory4/pin` | `{ text, scope?, cwd? }` 钉住 |
| POST | `/api/memory4/skills/approve` / `reject` | `{ name, cwd? }` |

路由仅接受回环 socket + 回环 Host；未认证请求会被宿主连接层以 401 拒绝。

### 开发循环

修改 `lib/client.js` 后同样需要**重启 Desktop**（打包版没有 `pnpm run dev:web` 热构建 watcher）；host 侧 `lib/*.js` 变更可被 HMR 重组捕获，但 client 元数据以启动时为准。

## 4. 重启后验收清单

### A1 跨会话召回

1. 会话 A 输入：`记住：本项目的发布窗口是每周三。`
2. 确认模型调用了 `memory_write`（或直接回复已保存）。
3. 新开一个会话 B（同一 workspace），输入：`发布窗口是哪天？`
4. 期望：无需复制上下文即可回答“每周三”。

### A2 压缩联动

1. 在一个长会话中持续工作，直到接近上下文上限（或手动 `/compact`）。
2. 运行 `/memory status`，应看到 `records` 中包含 `working`（handoff）与 `episodic`（压缩摘要）。
3. 压缩后继续提问，工作约束（pin/handoff）仍应被注入。

### A3 程序性记忆

1. 重复执行同一类任务（同一工具序列）至少 3 次且都成功。
2. `/memory skills` 应出现一个 `draft`。
3. `/memory skills approve <name>` 后，文件出现在 `C:\Users\Admin\.dsh\skills\<name>\SKILL.md`。
4. 新会话的 `<available_skills>` 中应能看到该技能，模型可调用 `skill` 加载。

### A4 写入质量

1. 重复说同一事实两次 → `/memory search <关键词>` 仍只有 1 条（按内容去重）。
2. 输入形如 `token=...` 的敏感内容 → 保存结果应为 `[REDACTED]`。
3. 两个不同 workspace 的会话互不可见对方 workspace 记忆（user 级全局记忆除外）。

### A5 预算与去重

1. 连续两轮不改变记忆时，模型上下文中不应重复出现同一 memory block。
2. `/memory status` 的 `recall: maxTokens=800` 与配置一致；长记忆只按预算截断注入。

## 5. 禁用 / 卸载

```powershell
# 方式一：profile patch 禁用（保留安装）
# 在 C:\Users\Admin\.dsh\profiles\web\cordis.patch.yml 追加：
- id: memory4
  disabled: true

# 方式二：卸载
D:\DSH\resources\runtime\cli\bin\dsh.cmd plugin --profile web remove dsh-memory4
```

## 6. 数据与清理

| 内容 | 路径 |
|---|---|
| 记忆库 | `C:\Users\Admin\.dsh\memory4\memory.db` |
| 技能草稿 | `C:\Users\Admin\.dsh\memory4\skills-drafts\` |
| 已批准技能 | `C:\Users\Admin\.dsh\skills\` |
| 导出 | `C:\Users\Admin\.dsh\memory4\exports\` |

卸载插件不会自动删除记忆库；需要清空时停止宿主后删除 `C:\Users\Admin\.dsh\memory4` 与已批准的技能目录。

## 7. 开发与回归

```powershell
cd D:\Projects\dsh-memory4
node --test          # 22+ 离线用例
```

修改源码后：`link:` 安装会跟随源码；重启宿主（或等待 profile 重组）即可加载新代码。

## 8. 本机安装记录（2026-10-20）

- 已安装 profile：`desktop`（当前 GUI 宿主）与 `web`；两者 `package.json` 均含 `dsh-memory4: link:D:/Projects/dsh-memory4`，`dsh.profile.bundles` 均含 `dsh-memory4`。
- 运行期实测（Desktop 宿主，无需重启即热加载）：
  1. 会话工具列表出现 `memory_write/search/read/forget/pin`；
  2. `memory_write` → `14c02bd44391f0c280f3ad31`（semantic/workspace）；
  3. `memory_search` 命中并返回该记录；
  4. 下一轮请求出现 `<memory-context source="dsh-memory4">` 注入块；
  5. `memory_read` 返回完整记录与来源 session；`memory_forget` 删除成功，最终 `records=0`。
- 安装时处理的既有问题（均非 dsh-memory4 引入）：
  - `web` profile 的 `dsh-verbosity` 依赖 `file:D:/tmp/dsh-verbosity` 源目录缺失，已从 `profiles/web/node_modules/dsh-verbosity` 还原该目录；该插件版本与 rc.2 不兼容，安装后仍被宿主跳过（安装前即已如此）。
  - `desktop` profile 的 `chat-tree: link:D:/Projects/chatTree` 是悬空软链（目标不存在且不在 bundles 中），已从 desktop profile 依赖中移除；备份见 `D:\tmp\dsh-memory-research\desktop-profile-backup-20261020-180318`。
  - web profile 安装前备份：`D:\tmp\dsh-memory-research\web-profile-backup-20261020-180211`。
  - 临时验证 profile `memory4test` / `memory4web` 已于 2026-10-21 按用户要求删除；`desktop` 与 `web` 两个正式 profile 保持安装。
  - **0.3.1 修复**：Settings「反思」曾报 `cannot get property 'llm' without inject`。原因是 host 插件未声明 LLM 服务 inject；现改为 `ctx.get('llm', false)` 获取服务，并在无会话的 UI 场景下复用最新活跃会话的路由模型。修复后点「反思」如仍报旧错，重启一次 Desktop 让 host 插件重新加载。
  - **0.3.2 修复**：点「反思」报 `model output was not a lessons array`。原因是模型可能输出解释文字、Markdown 代码块、数组或 `items` 等不同信封；现在解析器会扫描平衡 JSON、容忍多种信封、在失败时自动发起一次"修复为 JSON"的模型调用，并支持从编号/子弹行兜底提取结论；仍失败时审计保存原始输出并显示可读错误。
  - **0.3.3 修复**：继续报同样错误。审计（`select * from audit where action='memory/reflection-parse-failed'`）显示原始输出只有 514 字符且在一个 `"text"` 字符串中间被截断——`reflect.maxTokens=700` 被推理 token 吃掉，JSON 不完整，旧解析无法抢救。现在：默认预算提升到 1600；`finish=max-tokens` 时自动加倍重试一次；从截断 JSON 中抢救已完整的 `"text"` 条目；失败审计记录 `finish=` 与最多 8000 字符原文。本机 desktop profile 已加 HMR `root` 监视，保存源码即热重载，无需重启（详见 §10）。

## 9. P2 功能（0.3.x，默认关闭）

三项能力默认不启用；在对应 profile 的 `cordis.patch.yml` 中按 `id: memory4` 覆盖配置，然后重启/等待 profile 重组。**UI 的「反思」「导出 Markdown」按钮需要重启 Desktop 才会出现**（client 半变更）。

### 9.1 LLM 蒸馏（写入策略）

```yaml
- id: memory4
  config:
    write:
      mode: hybrid            # rules | llm | hybrid
      distillProvider: deepseek-official
      distillModel: deepseek-flash
      distillMaxTokens: 512
```

`llm` 模式只写模型提炼结果；`hybrid` 合并规则 + 模型结果（按文本去重）。模型不可用、无可用 provider/model 或输出不可解析时自动降级为规则抽取，不会中断 turn/end。

### 9.2 反思聚合

```yaml
- id: memory4
  config:
    reflect:
      enabled: true
      auto: true              # turn/end 按 intervalHours 自动触发
      days: 7
      intervalHours: 24
      minEpisodes: 3
      maxItems: 5
```

- 手动：`/memory reflect [days]`，或 Settings 页「反思」按钮（UI 无会话路由可复用，需至少配置 `write.distillProvider/distillModel`）。
- 结果写为 `semantic` 记录（tags 含 `reflection`），并写审计；重复内容按内容 id 去重。

### 9.3 向量检索（可选）

```yaml
- id: memory4
  config:
    vector:
      enabled: true
      baseUrl: https://api.openai.com/v1   # 兼容 /embeddings 的端点
      apiKeyEnv: DSH_MEMORY4_EMBEDDING_KEY # 或直接填 apiKey
      model: text-embedding-3-small
      dimensions: 1536
      weight: 0.35
```

- 写入（工具/命令/自动写入/反思/导入）时增量生成向量；未配置或调用失败时自动回退 FTS5/BM25。
- 历史记录补索引：`/memory reindex`（每次最多 200 条，可重复执行）。
- `vector` 分与 BM25 分按 `weight` 融合；`/memory status` 可见 `vectors` 数量与向量开关。

### 9.4 Markdown 导入 / 导出

- 导出：`/memory export md` 或 Settings「导出 Markdown」→ `$DSH_HOME/memory4/exports/*.md`。
- 导入：`/memory import <绝对路径>`，支持本插件 JSON 导出（`records[].body`）与 Markdown 记录条目；导入按内容去重、落库前脱敏；单文件上限 2 MB。

## 10. 开发期热重载（无需重启 Electron）

DSH 的 HMR 默认只监视 profile 配置（`root: []`），所以**只改插件源码不会自动触发重载**；client 半由 `client-hmr` 轮询 bundle 自动热替换。本机已在 `desktop` profile 的 `cordis.patch.yml` 末尾加入：

```yaml
- id: hmr
  disabled: false
  config:
    root: ["D:/Projects/dsh-memory4"]
```

效果与边界：

- 保存 `D:/Projects/dsh-memory4/lib/*.js` / `test/**` 后，HMR 在文件稳定窗口（约 2s）后自动重载 host 插件；无需重启 Desktop。
- `lib/client.js`（client 半）由 `client-hmr` 每 500ms 轮询 mtime/size，变化后经 `/plugins/events` SSE 热替换页面模块；保存后刷新当前 Settings 页即见新 UI。
- **必须重启**的变更：`package.json` 的 `main`/`exports`/`dsh.client`/`dsh.bundle` 等元数据、新增/删除 client 入口、profile manifest 或依赖安装变化。
- 插件级热插拔：Settings → 插件 中禁用再启用 `memory4` 会卸载/重挂插件（等价于一次 reload），无需重启应用。
- 诊断：每次 apply 写 `memory4/start` 审计（version/pid）；`/memory log` 或数据库 `audit` 表可查重载历史；失败日志见 `memory/reflection-parse-failed`（含 `finish=` 与原始输出）。
- 若不想再监视源码，删除该 `hmr` 条目或把 `root` 改回 `[]` 后重启。
