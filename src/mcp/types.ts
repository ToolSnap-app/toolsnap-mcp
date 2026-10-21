// Minimal JSON-RPC 2.0 + MCP types

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// MCP tool definition
export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    default?: unknown;
    minimum?: number;
    maximum?: number;
  }>;
  required?: string[];
}

// MCP tool annotations — untrusted hints for clients (not security boundaries).
// See https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  /** Short human-readable display name (MCP 2025-06-18 `title`). Filled from annotations.ts. */
  title?: string;
  description: string;
  inputSchema: McpToolInputSchema;
  annotations?: McpToolAnnotations;
  run(args: Record<string, unknown>): string | Promise<string>;
  /**
   * Optional env-aware execution path. Tools that need bindings/secrets
   * (R2, D1, provider API keys) implement this; the dispatcher passes `env`
   * through `callTool`. When present, `callTool` uses this instead of `run`.
   * `run` should throw, since it has no access to env.
   */
  runWithEnv?(args: Record<string, unknown>, env: unknown): Promise<string>;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: McpToolInputSchema;
  annotations?: McpToolAnnotations;
}

// MCP initialize params
export interface InitializeParams {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; version?: string };
}

// MCP tools/call params
export interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
