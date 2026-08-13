---
description: Execute a SQL query against a connected database and export the results to CSV or JSON in one step
argument-hint: "[database_name] [csv|json] [SQL query or natural language description]"
---

# Export Database Query Results

Execute a query against a database and export the results to a file in a single step.

## Arguments

- **database_name**: The name of the configured database connection (e.g. `dpi_policy3`)
- **format**: Export format — `csv` or `json`
- **query**: A SQL SELECT statement, or a natural language description of the data you want

## Steps

### 1. Understand the request

Parse `$ARGUMENTS` into database name, export format, and query text. If the database
name is not provided, list the available databases via `GET http://localhost:8000/api/v1/dbs`
and ask the user which one to use. Default format is `csv`.

### 2. Execute the query and export (single request)

Use the export endpoint, which runs the query and returns a downloadable file in one call:

```bash
curl -s -X POST "http://localhost:8000/api/v1/dbs/{database_name}/query/export" \
  -H "Content-Type: application/json" \
  -d '{"sql": "<SQL>", "format": "<csv|json>"}'
```

- Save the response body to a file: `<database_name>_<timestamp>.<format>`
- The endpoint validates SQL (only SELECT allowed) and supports large exports
  (default limit 100,000 rows; pass `"limit": <n>` to change it).

### 3. Verify and report

- Confirm the file was created and report its path and row count
- If the query is invalid or the database is not found, report the error message
  from the API response and suggest a fix

## Notes

- Only SELECT queries are allowed (enforced by the backend validator)
- For natural language queries, first use the NL2SQL endpoint to convert:
  `POST /api/v1/dbs/{name}/query/natural` with `{"prompt": "<description>"}`,
  then export the returned SQL
- The export endpoint streams results and is suitable for large datasets
