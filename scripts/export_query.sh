#!/usr/bin/env bash
# Export a query against a database connection to CSV or JSON in one step.
#
# Usage:
#   export_query.sh <database_name> [csv|json] <query>
#   export_query.sh <database_name> <query>              (format defaults to csv)
#
# The query may be a SQL SELECT statement or a natural language description
# (e.g. "查询 area_info 表的前5行"). Natural language is converted to SQL via
# the backend's NL2SQL endpoint before export.
set -u

# Windows Python defaults to GBK for stdin/stdout; force UTF-8 so Chinese
# prompts survive json_escape without mangling.
export PYTHONUTF8=1

API="http://localhost:8000/api/v1/dbs"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
PY="$BACKEND_DIR/.venv/Scripts/python.exe"
PORT=8000
MAX_SQL_LEN=512

info()  { printf '%s\n' "$*"; }
fail()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

json_escape() {
  # Minimal JSON string escaping for the curl payloads below.
  python -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()[:-1]))' <<<"$1"
}

backend_up() {
  curl -s --max-time 2 "http://localhost:$PORT/health" >/dev/null 2>&1
}

# ---------- 1. Parse arguments ----------
[ $# -lt 2 ] && fail "Usage: $0 <database_name> [csv|json] <query>"

DB="$1"
QUERY=""
FORMAT="csv"

if [ $# -eq 2 ]; then
  QUERY="$2"
else
  case "$2" in
    csv|json) FORMAT="$2"; shift 2 ;;
    *)        FORMAT="csv";   shift 1 ;;
  esac
  # Join all remaining arguments with spaces so natural language
  # descriptions (which lose their quoting after $ARGUMENTS word-splitting)
  # keep their spaces intact.
  QUERY="$*"
fi
[ -z "$QUERY" ] && fail "Query is empty"
[ ${#QUERY} -gt $MAX_SQL_LEN ] && fail "Query too long (max $MAX_SQL_LEN chars)"

# ---------- 2. Ensure backend is running ----------
if ! backend_up; then
  info "Backend not running, starting it on port $PORT ..."
  [ -x "$PY" ] || fail "Backend venv python not found: $PY"
  (cd "$BACKEND_DIR" && nohup "$PY" -m uvicorn app.main:app \
      --host 127.0.0.1 --port $PORT > /tmp/db_query_uvicorn.log 2>&1 &)
  for i in $(seq 1 15); do
    backend_up && break
    sleep 1
    [ "$i" -eq 15 ] && { tail -20 /tmp/db_query_uvicorn.log >&2 || true; \
                          fail "Backend failed to start (see log above)"; }
  done
fi

# ---------- 3. Convert natural language to SQL when needed ----------
case "$QUERY" in
  *[Ss][Ee][Ll][Ee][Cc][Tt]*|*[Ww][Ii][Tt][Hh]*|*[Ss][Hh][Oo][Ww]*)
    SQL="$QUERY"
    ;;
  *)
    info "Detected natural language input, converting to SQL ..."
    ESC_PROMPT="$(json_escape "$QUERY")"
    NL_RESP="$(curl -s -X POST "$API/$DB/query/natural" \
        -H "Content-Type: application/json" \
        -d "{\"prompt\": $ESC_PROMPT}")"
    SQL="$(printf '%s' "$NL_RESP" | python -c \
        'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(1)
if "detail" in d: print("__ERROR__"); print(d["detail"]); sys.exit(0)
print(d.get("sql",""))')"
    if [ "$(printf '%s\n' "$SQL" | head -1)" = "__ERROR__" ]; then
      fail "NL2SQL failed: $(printf '%s\n' "$SQL" | tail -n +2)"
    fi
    [ -z "$SQL" ] && fail "NL2SQL returned no SQL; check backend log /tmp/db_query_uvicorn.log"
    info "Generated SQL: $SQL"
    ;;
esac

# ---------- 4. Execute query and export ----------
TS="$(date +%Y%m%d_%H%M%S)"
OUT="$PROJECT_DIR/${DB}_${TS}.${FORMAT}"
ESC_SQL="$(json_escape "$SQL")"

BODY="{\"sql\": $ESC_SQL, \"format\": \"$FORMAT\"}"
HTTP_CODE="$(curl -s -X POST "$API/$DB/query/export" \
    -H "Content-Type: application/json" \
    -d "$BODY" \
    -o "$OUT" -w "%{http_code}")"

if [ "$HTTP_CODE" != "200" ]; then
  DETAIL="$(python -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    d={}
print(d.get("detail", "unknown error"))' < "$OUT" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')"
  rm -f "$OUT"
  fail "Export failed (HTTP $HTTP_CODE): $DETAIL"
fi

# ---------- 5. Report ----------
case "$FORMAT" in
  csv)  ROWS=$(( $(wc -l < "$OUT") - 1 )) ;;
  json) ROWS="$(python -c 'import json,sys
try:
    d=json.load(open(sys.argv[1], encoding="utf-8"))
    print(len(d) if isinstance(d, list) else "?")
except Exception:
    print("?")' "$OUT")" ;;
esac
SIZE="$(du -h "$OUT" | cut -f1)"

info "OK: exported $ROWS row(s) to $OUT ($SIZE)"
