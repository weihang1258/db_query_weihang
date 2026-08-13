"""Query execution API endpoints."""

import json
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from typing import List
from app.database import get_session
from app.models.database import DatabaseConnection
from app.models.query import QuerySource
from app.models.schemas import (
    QueryInput,
    QueryResult,
    QueryHistoryEntry,
    NaturalLanguageInput,
    GeneratedSqlResponse,
)
from app.services.query_wrapper import execute_query_with_service
from app.services.query import get_query_history
from app.services.sql_validator import SqlValidationError
from app.services.nl2sql import nl2sql_service
from app.services.metadata import get_cached_metadata
from app.services.export_service import format_csv, format_json

router = APIRouter(prefix="/api/v1/dbs", tags=["queries"])


class ExportInput(BaseModel):
    """Input schema for exporting query results."""

    sql: str = Field(..., min_length=1, description="SQL SELECT query to execute")
    format: str = Field(default="csv", description="Export format: csv or json")
    limit: int = Field(default=100000, ge=1, le=1000000, description="Maximum rows to export")


def _export_filename(name: str, export_format: str) -> str:
    """Build a timestamped export filename."""
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"{name}_{timestamp}.{export_format}"


def to_history_entry(history) -> QueryHistoryEntry:
    """Convert QueryHistory to QueryHistoryEntry schema."""
    return QueryHistoryEntry(
        id=history.id,
        databaseName=history.database_name,
        sqlText=history.sql_text,
        executedAt=history.executed_at,
        executionTimeMs=history.execution_time_ms,
        rowCount=history.row_count,
        success=history.success,
        errorMessage=history.error_message,
        querySource=history.query_source.value,
    )


@router.post("/{name}/query", response_model=QueryResult)
async def execute_sql_query(
    name: str,
    input_data: QueryInput,
    session: Session = Depends(get_session),
) -> QueryResult:
    """
    Execute SQL query against a database.

    Args:
        name: Database connection name
        input_data: Query input with SQL
        session: Database session

    Returns:
        Query result with columns and rows
    """
    # Get connection
    statement = select(DatabaseConnection).where(
        DatabaseConnection.name == name
    )
    connection = session.exec(statement).first()

    if not connection:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Database connection '{name}' not found",
        )

    # Execute query
    try:
        result = await execute_query_with_service(
            session,
            name,
            connection.db_type,
            connection.url,
            input_data.sql,
            QuerySource.MANUAL,
        )
        return result
    except SqlValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Query execution failed: {str(e)}",
        )


@router.post("/{name}/query/export")
async def export_query_result(
    name: str,
    input_data: ExportInput,
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """
    Execute a SQL query and return results as a downloadable CSV or JSON file.

    Args:
        name: Database connection name
        input_data: Export input with SQL, format, and optional row limit
        session: Database session

    Returns:
        StreamingResponse with file content and download headers

    Raises:
        HTTPException: If connection not found, SQL invalid, or execution fails
    """
    # Get connection
    statement = select(DatabaseConnection).where(
        DatabaseConnection.name == name
    )
    connection = session.exec(statement).first()

    if not connection:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Database connection '{name}' not found",
        )

    export_format = input_data.format.lower()
    if export_format not in ("csv", "json"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported format '{input_data.format}'. Use 'csv' or 'json'.",
        )

    # Execute query with a larger row limit for export
    try:
        result = await execute_query_with_service(
            session,
            name,
            connection.db_type,
            connection.url,
            input_data.sql,
            QuerySource.EXPORT,
            limit=input_data.limit,
        )
    except SqlValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Query execution failed: {str(e)}",
        )

    # Format content
    if export_format == "csv":
        content = format_csv(result.columns, result.rows)
        media_type = "text/csv; charset=utf-8"
    else:
        content = format_json(result.rows)
        media_type = "application/json; charset=utf-8"

    filename = _export_filename(name, export_format)

    return StreamingResponse(
        iter([content]),
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@router.get("/{name}/history", response_model=List[QueryHistoryEntry])
async def get_query_history_for_database(
    name: str,
    limit: int = 50,
    session: Session = Depends(get_session),
) -> List[QueryHistoryEntry]:
    """
    Get query history for a database.

    Args:
        name: Database connection name
        limit: Maximum number of queries to return
        session: Database session

    Returns:
        List of query history entries
    """
    # Verify connection exists
    statement = select(DatabaseConnection).where(
        DatabaseConnection.name == name
    )
    connection = session.exec(statement).first()

    if not connection:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Database connection '{name}' not found",
        )

    # Get history
    history_list = await get_query_history(session, name, limit)
    return [to_history_entry(h) for h in history_list]


@router.post("/{name}/query/natural", response_model=GeneratedSqlResponse)
async def natural_language_to_sql(
    name: str,
    input_data: NaturalLanguageInput,
    session: Session = Depends(get_session),
) -> GeneratedSqlResponse:
    """
    Convert natural language to SQL query using OpenAI.

    Args:
        name: Database connection name
        input_data: Natural language prompt
        session: Database session

    Returns:
        Generated SQL query with explanation
    """
    # Get connection
    statement = select(DatabaseConnection).where(DatabaseConnection.name == name)
    connection = session.exec(statement).first()

    if not connection:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Database connection '{name}' not found",
        )

    # Get metadata for context
    try:
        metadata_obj = await get_cached_metadata(session, connection.name)
        if not metadata_obj:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Metadata not found for database '{name}'. Please refresh metadata first.",
            )
        metadata = json.loads(metadata_obj.metadata_json)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to load metadata: {str(e)}",
        )

    # Generate SQL
    try:
        result = await nl2sql_service.generate_sql(input_data.prompt, metadata, connection.db_type)
        return GeneratedSqlResponse(
            sql=result["sql"],
            explanation=result["explanation"],
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate SQL: {str(e)}",
        )
