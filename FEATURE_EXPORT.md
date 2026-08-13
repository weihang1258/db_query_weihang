# FEATURE_EXPORT — 数据导出功能设计文档

> 智能数据库查询工具（db_query）新增"数据导出"功能的设计思路与实现说明。
> 对应作业：为"数据库查询工具"添加数据导出功能。

---

## 1. 功能概述

在原有"数据库查询工具"（FastAPI 后端 + React 前端）基础上，新增**数据导出**功能：

| 需求 | 实现 |
|------|------|
| 导出格式支持 | CSV、JSON 两种格式 |
| 自动化流程 | Claude Code 自定义命令 `/export-db-query`，一键"查询 + 导出" |
| 用户交互 | 查询后弹窗询问是否导出；界面按钮一键导出 |
| 数据完整性 | 服务端导出，突破原有 1000 行限制，支持完整数据集 |

---

## 2. 设计思路

### 2.1 为什么需要服务端导出？

原有前端已有客户端导出（EXPORT CSV / EXPORT JSON），但**只能导出当前已加载的结果**：

- 后端 SQL 校验器自动给查询加 `LIMIT 1000`（`sql_validator.py:add_limit_if_missing`）
- 前端表格最多展示 1000 行，客户端导出只能导出这 1000 行
- 项目文档 `PHASE3_IMPLEMENTATION.md` 明确将"服务端导出（更大数据集）"列为 **Future Enhancement**

因此本功能的核心是**新增服务端导出接口**，导出时使用更大的行数上限，保证导出完整数据。

### 2.2 架构设计

```
┌─────────────┐      ┌──────────────────┐      ┌──────────────────────┐
│  前端 React  │      │  FastAPI 后端      │      │  MySQL / PostgreSQL   │
│  (Home.tsx)  │ ───► │  /query/export    │ ───► │  数据库               │
│              │      │  └ export_service │      │                      │
│  按钮/弹窗    │ ◄─── │  └ query_wrapper  │ ◄─── │                      │
└─────────────┘      └──────────────────┘      └──────────────────────┘
```

**后端新增 3 个组件：**

| 文件 | 职责 |
|------|------|
| `app/services/export_service.py` | 数据格式化：CSV（RFC 4180 转义）、JSON（pretty print） |
| `app/api/v1/queries.py` → `POST /{name}/query/export` | 导出接口：执行查询 + 返回文件下载 |
| `app/models/query.py` → `QuerySource.EXPORT` | 查询来源标记（历史记录区分导出查询） |

**关键设计点：**

1. **突破 1000 行限制**：`query_wrapper.py:execute_query_with_service` 新增 `limit` 参数，导出时传 `limit=100000`（可配置），复用 `database_service.execute_query` 的 SQL 校验，但不再受默认 1000 行约束。
2. **安全**：仍只允许 SELECT（复用 `sql_validator.validate_sql`），非法 SQL 返回 400。
3. **流式响应**：使用 FastAPI `StreamingResponse`，配合 `Content-Disposition: attachment` 触发浏览器下载。
4. **格式校验**：`format` 参数只接受 `csv` / `json`，其余返回 400。
5. **导出记录**：通过 `QuerySource.EXPORT` 将导出查询写入历史，便于审计。

### 2.3 接口规范

```
POST /api/v1/dbs/{name}/query/export
Content-Type: application/json

请求体：
{
  "sql": "SELECT * FROM users",      // 必填，仅允许 SELECT
  "format": "csv",                   // 必填，csv | json
  "limit": 100000                    // 可选，最大导出行数（1~1000000）
}

响应：
- 200：文件内容（Content-Type: text/csv 或 application/json）
  + Content-Disposition: attachment; filename="{name}_{timestamp}.{format}"
- 400：SQL 校验失败 / 格式不支持
- 404：数据库连接不存在
- 500：执行失败
```

---

## 3. 自动化流程（Claude Code 自定义命令）

### 3.1 命令定义

新增 `.claude/commands/export-db-query.md`，注册自定义命令 `/export-db-query`：

```
/export-db-query dpi_policy3 csv "SELECT * FROM area_info"
/export-db-query dpi_policy3 json "查询所有用户"   # 支持自然语言
```

### 3.2 命令执行流程（AI Agent 任务分解）

命令触发后，Claude Code 自动分解为以下子任务并协调执行：

1. **解析请求**：从 `$ARGUMENTS` 提取数据库名、格式、查询文本
2. **执行查询 + 导出**：调用后端 `/query/export` 接口（单次请求完成）
3. **自然语言处理**：若查询是自然语言，先调用 `/query/natural` 转 SQL，再导出
4. **校验与报告**：确认文件生成，报告路径和行数；失败时返回错误信息

```
用户输入：/export-db-query dpi_policy3 csv "查询 area_info 前5行"
    │
    ├─► 解析参数：db=dpi_policy3, format=csv, query="查询 area_info 前5行"
    ├─► 判断为自然语言 → 调 /query/natural 转 SQL
    │        └─► 生成: SELECT * FROM area_info LIMIT 5
    ├─► 调 /query/export (sql, format=csv)
    │        └─► 返回 CSV 文件内容
    └─► 保存为 dpi_policy3_20260813_101607.csv 并报告
```

### 3.3 与 Cursor 的互补（作业练习点）

- **Cursor**：擅长快速迭代 UI 和代码生成——本功能的前端按钮、表格渲染用 Cursor 风格实现
- **Claude Code**：擅长多步骤自动化流程——`/export-db-query` 命令把"查询+导出"封装为单一触发点，配合 Agent 拆解子任务

---

## 4. 用户交互设计

### 4.1 AI 主动询问（作业要求的交互）

执行查询成功后，前端自动弹窗询问：

> **Export Query Results?**
> Query returned 3214 rows. Would you like to export the results to a file?
> [Export as CSV] [Export as JSON]

- 点击 **Export as CSV** → 调后端导出接口 → 浏览器下载 CSV 文件
- 点击 **Export as JSON** → 同理下载 JSON 文件
- 关闭弹窗则跳过，不打扰用户

### 4.2 一键按钮（EXEC2CSV / EXEC2JSON）

在 QUERY EDITOR 卡片 EXECUTE 按钮旁新增两个按钮：

| 按钮 | 功能 |
|------|------|
| **EXEC2CSV** | 执行当前 SQL → 自动导出完整结果为 CSV |
| **EXEC2JSON** | 执行当前 SQL → 自动导出完整结果为 JSON |

实现：`handleExecuteAndExport(format)` 先调 `/query` 执行（结果展示在表格），再用 `/query/export` 导出完整数据（突破 1000 行）。

### 4.3 结果卡片导出按钮

原有 EXPORT CSV / EXPORT JSON 按钮**升级为服务端导出**：调用 `/query/export` 接口，导出完整数据集而非仅当前页。

---

## 5. 文件变更清单

### 后端

| 文件 | 变更 |
|------|------|
| `backend/app/services/export_service.py` | **新增**：CSV/JSON 格式化服务 |
| `backend/app/api/v1/queries.py` | 新增 `ExportInput` schema、`POST /{name}/query/export` 端点 |
| `backend/app/services/query_wrapper.py` | `execute_query_with_service` 新增 `limit` 参数 |
| `backend/app/models/query.py` | `QuerySource` 新增 `EXPORT` 枚举 |
| `backend/tests/unit/test_api_queries.py` | 新增 `TestExportQueryResult`（5 个测试用例） |

### 前端

| 文件 | 变更 |
|------|------|
| `frontend/src/pages/Home.tsx` | 新增 `serverExport`、`promptExport`、`handleExecuteAndExport`；升级 EXPORT 按钮为服务端导出；新增 EXEC2CSV/EXEC2JSON 按钮 |

### 自动化

| 文件 | 变更 |
|------|------|
| `.claude/commands/export-db-query.md` | **新增**：Claude Code 自定义命令 |

---

## 6. 测试与验证

### 后端测试（新增 5 个，全部通过）

| 测试 | 验证点 |
|------|--------|
| `test_export_csv_success` | CSV 导出 200、Content-Type、内容正确、limit 默认 100000 |
| `test_export_json_success` | JSON 导出 200、内容格式正确 |
| `test_export_invalid_format` | 非法格式返回 400 |
| `test_export_database_not_found` | 数据库不存在返回 404 |
| `test_export_custom_limit` | 自定义 limit 正确传递 |

### 实测验证

- ✅ 导出 `area_info` 表 3214 行（突破 1000 行限制）
- ✅ 中文数据（`芦淞区`）CSV/JSON 编码正确
- ✅ 非法 SQL（`DROP TABLE`）被拒绝
- ✅ 前端弹窗询问 → 选择格式 → 文件下载完整流程
- ✅ `/export-db-query` 命令模拟执行成功

> 注：项目原有部分测试（如 `TestExecuteSqlQuery`）失败，原因是测试 mock 旧版函数名 `app.api.v1.queries.execute_query`，而代码已重构为 `execute_query_with_service`——**这是项目原有的测试-代码不匹配问题，与本次功能无关**。

---

## 7. 后续可扩展方向

1. **导出进度反馈**：大数据量导出时显示进度条/百分比
2. **异步导出任务**：超大结果集（>100 万行）转异步任务，完成后通知下载
3. **更多格式**：Excel（xlsx）、SQL 转储
4. **定时导出**：配合查询历史，支持周期性导出报表
5. **导出配置持久化**：记住用户偏好的格式和行数
