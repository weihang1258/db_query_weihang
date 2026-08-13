/** Main page with integrated database management and query interface. */

import React, { useState, useEffect } from "react";
import {
  Card,
  Spin,
  Button,
  Input,
  Space,
  Table,
  message,
  Row,
  Col,
  Typography,
  Empty,
  Tabs,
  Modal,
} from "antd";
import {
  PlayCircleOutlined,
  SearchOutlined,
  DatabaseOutlined,
  ReloadOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { apiClient } from "../services/api";
import { DatabaseMetadata, TableMetadata } from "../types/metadata";
import { MetadataTree } from "../components/MetadataTree";
import { SqlEditor } from "../components/SqlEditor";
import { DatabaseSidebar } from "../components/DatabaseSidebar";
import { NaturalLanguageInput } from "../components/NaturalLanguageInput";

const { Title, Text } = Typography;

interface QueryResult {
  columns: Array<{ name: string; dataType: string }>;
  rows: Array<Record<string, any>>;
  rowCount: number;
  executionTimeMs: number;
  sql: string;
}

export const Home: React.FC = () => {
  const [selectedDatabase, setSelectedDatabase] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<DatabaseMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [sql, setSql] = useState("SELECT * FROM ");
  const [executing, setExecuting] = useState(false);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [activeTab, setActiveTab] = useState<"manual" | "natural">("manual");
  const [generatingSql, setGeneratingSql] = useState(false);
  const [nlError, setNlError] = useState<string | null>(null);
  const [execExporting, setExecExporting] = useState<"csv" | "json" | null>(null);

  useEffect(() => {
    if (selectedDatabase) {
      loadMetadata();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload metadata when db changes
  }, [selectedDatabase]);

  const loadMetadata = async () => {
    if (!selectedDatabase) return;

    setLoading(true);
    try {
      const response = await apiClient.get<DatabaseMetadata>(
        `/api/v1/dbs/${selectedDatabase}`
      );
      setMetadata(response.data);
    } catch (error: any) {
      console.error("Failed to load metadata:", error?.message || error);
      message.error("Failed to load database metadata");
    } finally {
      setLoading(false);
    }
  };

  const handleExecuteQuery = async () => {
    if (!selectedDatabase || !sql.trim()) {
      message.warning("Please enter a SQL query");
      return;
    }

    setExecuting(true);
    try {
      const response = await apiClient.post<QueryResult>(
        `/api/v1/dbs/${selectedDatabase}/query`,
        { sql: sql.trim() }
      );
      setQueryResult(response.data);
      message.success(
        `Query executed - ${response.data.rowCount} rows in ${response.data.executionTimeMs}ms`
      );
    } catch (error: any) {
      message.error(error.response?.data?.detail || "Query execution failed");
      setQueryResult(null);
    } finally {
      setExecuting(false);
    }
  };

  const handleExecuteAndExport = async (format: "csv" | "json") => {
    if (!selectedDatabase || !sql.trim()) {
      message.warning("Please enter a SQL query");
      return;
    }

    setExecExporting(format);
    try {
      const response = await apiClient.post<QueryResult>(
        `/api/v1/dbs/${selectedDatabase}/query`,
        { sql: sql.trim() }
      );
      setQueryResult(response.data);
      message.success(
        `Query executed - ${response.data.rowCount} rows in ${response.data.executionTimeMs}ms`
      );
      // Server-side export with the executed SQL (supports full dataset)
      await serverExport(format, undefined, sql.trim());
    } catch (error: any) {
      message.error(error.response?.data?.detail || "Query execution failed");
      setQueryResult(null);
    } finally {
      setExecExporting(null);
    }
  };

  const handleTableClick = (table: TableMetadata) => {
    setSql(`SELECT * FROM ${table.schemaName}.${table.name} LIMIT 100`);
  };

  const handleRefreshMetadata = async () => {
    if (!selectedDatabase) return;
    try {
      await apiClient.post(`/api/v1/dbs/${selectedDatabase}/refresh`);
      message.success("Metadata refreshed");
      loadMetadata();
    } catch {
      message.error("Failed to refresh metadata");
    }
  };

  const handleGenerateSQL = async (prompt: string) => {
    if (!selectedDatabase) return;

    setGeneratingSql(true);
    setNlError(null);
    try {
      const response = await apiClient.post<{ sql: string; explanation: string }>(
        `/api/v1/dbs/${selectedDatabase}/query/natural`,
        { prompt }
      );
      setSql(response.data.sql);
      setActiveTab("manual"); // Switch to manual tab to show generated SQL
      message.success("SQL generated successfully! You can now edit and execute it.");
    } catch (error: any) {
      const errorMsg = error.response?.data?.detail || "Failed to generate SQL";
      setNlError(errorMsg);
      message.error(errorMsg);
    } finally {
      setGeneratingSql(false);
    }
  };

  const serverExport = async (format: "csv" | "json", limit?: number, sqlOverride?: string) => {
    const sqlToExport = sqlOverride || queryResult?.sql;
    if (!selectedDatabase || !sqlToExport) {
      message.warning("No query result to export");
      return;
    }

    try {
      const response = await apiClient.post(
        `/api/v1/dbs/${selectedDatabase}/query/export`,
        { sql: sqlToExport, format, limit: limit ?? 100000 },
        { responseType: "blob" }
      );
      // Trigger browser download from the blob
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
      link.href = url;
      link.download = `${selectedDatabase}_${timestamp}.${format}`;
      link.click();
      window.URL.revokeObjectURL(url);
      message.success(`Exported query results to ${format.toUpperCase()}`);
    } catch (error: any) {
      const errorMsg = error.response?.data?.detail || `Export to ${format.toUpperCase()} failed`;
      message.error(errorMsg);
    }
  };

  const handleExportCSV = () => {
    if (!queryResult || queryResult.rows.length === 0) {
      message.warning("No data to export");
      return;
    }

    // Warn if result is large
    if (queryResult.rows.length > 10000) {
      Modal.confirm({
        title: "Large Dataset Warning",
        icon: <ExclamationCircleOutlined />,
        content: `You are about to export ${queryResult.rowCount.toLocaleString()} rows. This may take a while and consume memory. Continue?`,
        onOk: () => serverExport("csv"),
      });
    } else {
      serverExport("csv");
    }
  };

  const handleExportJSON = () => {
    if (!queryResult || queryResult.rows.length === 0) {
      message.warning("No data to export");
      return;
    }

    // Warn if result is large
    if (queryResult.rows.length > 10000) {
      Modal.confirm({
        title: "Large Dataset Warning",
        icon: <ExclamationCircleOutlined />,
        content: `You are about to export ${queryResult.rowCount.toLocaleString()} rows. This may take a while and consume memory. Continue?`,
        onOk: () => serverExport("json"),
      });
    } else {
      serverExport("json");
    }
  };

  const tableColumns =
    queryResult?.columns.map((col) => ({
      title: col.name,
      dataIndex: col.name,
      key: col.name,
      ellipsis: true,
    })) || [];

  // No database selected state
  if (!selectedDatabase) {
    return (
      <div style={{ display: "flex", height: "100vh" }}>
        <DatabaseSidebar
          selectedDatabase={selectedDatabase}
          onSelectDatabase={setSelectedDatabase}
        />
        <div
          style={{
            marginLeft: 280,
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#F4EFEA",
          }}
        >
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={16}>
                <Title level={3} style={{ textTransform: "uppercase" }}>
                  NO DATABASE SELECTED
                </Title>
                <Text type="secondary" style={{ fontSize: 15 }}>
                  Add a database from the sidebar to get started
                </Text>
              </Space>
            }
          />
        </div>
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div style={{ display: "flex", height: "100vh" }}>
        <DatabaseSidebar
          selectedDatabase={selectedDatabase}
          onSelectDatabase={setSelectedDatabase}
        />
        <div
          style={{
            marginLeft: 280,
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#F4EFEA",
          }}
        >
          <Spin size="large" />
        </div>
      </div>
    );
  }

  if (!metadata) {
    return null;
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "#F4EFEA" }}>
      {/* Database List Sidebar */}
      <DatabaseSidebar
        selectedDatabase={selectedDatabase}
        onSelectDatabase={setSelectedDatabase}
      />

      {/* Schema Sidebar - Full Height */}
      <div
        style={{
          width: 340,
          height: "100vh",
          background: "#FFFFFF",
          borderTop: "3px solid #000000",
          borderRight: "2px solid #000000",
          display: "flex",
          flexDirection: "column",
          position: "fixed",
          left: 280,
          top: 0,
        }}
      >
        {/* Database Name Top Bar - Sunbeam Yellow */}
        <div
          style={{
            padding: "16px 20px",
            background: "#FFDE00",
            borderBottom: "2px solid #000000",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            minHeight: 60,
          }}
        >
          <Space>
            <DatabaseOutlined style={{ fontSize: 20, fontWeight: 700 }} />
            <Title
              level={4}
              style={{
                margin: 0,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                fontSize: 18,
                fontWeight: 700,
              }}
            >
              {selectedDatabase}
            </Title>
          </Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={handleRefreshMetadata}
            style={{ borderWidth: 2, fontWeight: 700 }}
          >
            REFRESH
          </Button>
        </div>

        {/* Search Bar */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #E4D6C3" }}>
          <Input
            placeholder="Search tables, columns..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            size="middle"
          />
        </div>

        {/* Schema Tree - Fills Remaining Height */}
        <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
          <MetadataTree
            metadata={metadata}
            searchText={searchText}
            onTableClick={handleTableClick}
          />
        </div>
      </div>

      {/* Main Content Area */}
      <div
        style={{
          marginLeft: 620,
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "24px",
          height: "100vh",
        }}
      >
        {/* Compact Metrics Row */}
        <Row gutter={12} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <div
              style={{
                padding: "12px",
                textAlign: "center",
                border: "2px solid #000000",
                borderRadius: 2,
                background: "#FFFFFF",
              }}
            >
              <Text
                type="secondary"
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                TABLES
              </Text>
              <Text style={{ fontSize: 24, fontWeight: 700 }}>
                {metadata.tables.length}
              </Text>
            </div>
          </Col>
          <Col span={6}>
            <div
              style={{
                padding: "12px",
                textAlign: "center",
                border: "2px solid #000000",
                borderRadius: 2,
                background: "#FFFFFF",
              }}
            >
              <Text
                type="secondary"
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                VIEWS
              </Text>
              <Text style={{ fontSize: 24, fontWeight: 700 }}>
                {metadata.views.length}
              </Text>
            </div>
          </Col>
          <Col span={6}>
            <div
              style={{
                padding: "12px",
                textAlign: "center",
                border: "2px solid #000000",
                borderRadius: 2,
                background: "#FFFFFF",
              }}
            >
              <Text
                type="secondary"
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                ROWS
              </Text>
              <Text
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  color: queryResult ? "#16AA98" : "#A1A1A1",
                }}
              >
                {queryResult?.rowCount || 0}
              </Text>
            </div>
          </Col>
          <Col span={6}>
            <div
              style={{
                padding: "12px",
                textAlign: "center",
                border: "2px solid #000000",
                borderRadius: 2,
                background: "#FFFFFF",
              }}
            >
              <Text
                type="secondary"
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                TIME
              </Text>
              <Text
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  color: queryResult ? "#16AA98" : "#A1A1A1",
                }}
              >
                {queryResult ? `${queryResult.executionTimeMs}ms` : "-"}
              </Text>
            </div>
          </Col>
        </Row>

        {/* Query Editor with Tabs */}
        <Card
          title={
            <Text
              strong
              style={{
                fontSize: 13,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              QUERY EDITOR
            </Text>
          }
          extra={
            activeTab === "manual" ? (
              <Space size={8}>
                <Button
                  icon={<FileTextOutlined />}
                  onClick={() => handleExecuteAndExport("csv")}
                  loading={execExporting === "csv"}
                  disabled={executing || execExporting === "json"}
                  size="large"
                  style={{
                    height: 40,
                    paddingLeft: 16,
                    paddingRight: 16,
                    fontWeight: 700,
                  }}
                >
                  EXEC2CSV
                </Button>
                <Button
                  icon={<TableOutlined />}
                  onClick={() => handleExecuteAndExport("json")}
                  loading={execExporting === "json"}
                  disabled={executing || execExporting === "csv"}
                  size="large"
                  style={{
                    height: 40,
                    paddingLeft: 16,
                    paddingRight: 16,
                    fontWeight: 700,
                  }}
                >
                  EXEC2JSON
                </Button>
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={handleExecuteQuery}
                  loading={executing}
                  disabled={execExporting !== null}
                  size="large"
                  style={{
                    height: 40,
                    paddingLeft: 20,
                    paddingRight: 20,
                    fontWeight: 700,
                  }}
                >
                  EXECUTE
                </Button>
              </Space>
            ) : null
          }
          style={{ borderWidth: 2, borderColor: "#000000", marginBottom: 16 }}
        >
          <Tabs
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as "manual" | "natural")}
            items={[
              {
                key: "manual",
                label: (
                  <Text
                    strong
                    style={{
                      fontSize: 12,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    MANUAL SQL
                  </Text>
                ),
                children: (
                  <SqlEditor
                    value={sql}
                    onChange={(value) => setSql(value || "")}
                    height="180px"
                  />
                ),
              },
              {
                key: "natural",
                label: (
                  <Text
                    strong
                    style={{
                      fontSize: 12,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    NATURAL LANGUAGE
                  </Text>
                ),
                children: (
                  <div style={{ padding: "12px 0" }}>
                    <NaturalLanguageInput
                      onGenerateSQL={handleGenerateSQL}
                      loading={generatingSql}
                      error={nlError}
                    />
                  </div>
                ),
              },
            ]}
            style={{
              marginTop: -16,
            }}
          />
        </Card>

        {/* Query Results */}
        {queryResult && (
          <Card
            title={
              <Space>
                <Text
                  strong
                  style={{
                    fontSize: 13,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  RESULTS
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  • {queryResult.rowCount} rows •{" "}
                  {queryResult.executionTimeMs}ms
                </Text>
              </Space>
            }
            extra={
              <Space size={8}>
                <Button
                  size="small"
                  onClick={handleExportCSV}
                  style={{ fontSize: 12, fontWeight: 700 }}
                >
                  EXPORT CSV
                </Button>
                <Button
                  size="small"
                  onClick={handleExportJSON}
                  style={{ fontSize: 12, fontWeight: 700 }}
                >
                  EXPORT JSON
                </Button>
              </Space>
            }
            style={{ borderWidth: 2, borderColor: "#000000" }}
          >
            <Table
              columns={tableColumns}
              dataSource={queryResult.rows}
              rowKey={(_record, index) => index?.toString() || "0"}
              pagination={{
                pageSize: 50,
                showSizeChanger: true,
                showTotal: (total) => `Total ${total} rows`,
                pageSizeOptions: [10, 20, 50, 100],
              }}
              scroll={{ x: "max-content", y: "calc(100vh - 520px)" }}
              size="middle"
              bordered
            />
          </Card>
        )}
      </div>
    </div>
  );
};
