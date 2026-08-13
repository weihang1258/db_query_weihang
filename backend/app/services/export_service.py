"""Data export service for formatting query results as CSV or JSON."""

import csv
import io
import json
from typing import Any, Dict, List


def _column_name(col) -> str:
    """Extract column name from dict or object."""
    if isinstance(col, dict):
        return col["name"]
    return col.name


def format_csv(columns: List[Dict[str, str]], rows: List[Dict[str, Any]]) -> str:
    """Format query results as CSV string.

    Args:
        columns: List of column definitions (dicts or QueryColumn objects)
        rows: List of row dictionaries

    Returns:
        CSV-formatted string
    """
    headers = [_column_name(col) for col in columns]
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(headers)
    for row in rows:
        writer.writerow([_csv_value(row.get(h)) for h in headers])
    return output.getvalue()


def _csv_value(value: Any) -> str:
    """Convert a value to a CSV-safe string.

    Args:
        value: Raw value from query result

    Returns:
        String representation, empty for None
    """
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def format_json(rows: List[Dict[str, Any]]) -> str:
    """Format query results as JSON string.

    Args:
        rows: List of row dictionaries

    Returns:
        Pretty-printed JSON string
    """
    return json.dumps(rows, indent=2, ensure_ascii=False)
