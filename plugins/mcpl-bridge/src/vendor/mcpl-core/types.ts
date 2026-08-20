/**
 * JSON-RPC 2.0 message types for MCPL transport.
 * Port of mcpl-core/src/types.rs
 */

// ── JSON-RPC 2.0 Core ──

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── Constructors ──

export function makeRequest(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) };
}

export function makeResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function makeErrorResponse(id: JsonRpcId, error: JsonRpcError): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error };
}

export function makeNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, ...(params !== undefined && { params }) };
}

// ── Content Blocks (Appendix B.1 of MCPL spec) ──

export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export type ImageContent = {
  type: 'image';
  data: string;
  mimeType?: string;
  uri?: never;
} | {
  type: 'image';
  uri: string;
  mimeType?: string;
  data?: never;
};

export type AudioContent = {
  type: 'audio';
  data: string;
  mimeType?: string;
  uri?: never;
} | {
  type: 'audio';
  uri: string;
  mimeType?: string;
  data?: never;
};

export interface ResourceContent {
  type: 'resource';
  uri: string;
}

export function textContent(text: string): TextContent {
  return { type: 'text', text };
}

// ── MCPL Error Codes ──

export const ERR_FEATURE_SET_NOT_ENABLED = -32001;
/** Method requires a capability not in the effective grant; `data: { capability }` (SPEC §14.6). */
export const ERR_CAPABILITY_DENIED = -32002;
export const ERR_UNKNOWN_FEATURE_SET = -32003;
export const ERR_CHECKPOINT_NOT_FOUND = -32005;
export const ERR_CHANNEL_NOT_PERMITTED = -32017;
export const ERR_UNKNOWN_CHANNEL = -32023;
export const ERR_CHANNEL_OPEN_FAILED = -32024;
