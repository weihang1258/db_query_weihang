---
description: Execute a SQL query against a connected database and export the results to CSV or JSON in one step
argument-hint: "[database_name] [csv|json] [SQL query or natural language description]"
allowed-tools: Bash
---

执行下面这条命令，$ARGUMENTS 原样传给脚本，不要做任何解析、修改或其他操作：

```bash
bash scripts/export_query.sh $ARGUMENTS
```

脚本会自动处理：参数解析（format 缺省为 csv）、后端健康检查与启动、自然语言转 SQL（非 SELECT 语句自动调用 /query/natural）、调用 /query/export 导出、以 <database_name>_<时间戳>.<format> 命名保存到项目根目录并报告行数。

直接将脚本的输出原样报告给用户即可。
