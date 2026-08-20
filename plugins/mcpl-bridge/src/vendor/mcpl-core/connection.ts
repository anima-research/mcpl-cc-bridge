/**
 * Bidirectional async JSON-RPC 2.0 connection for MCPL.
 * Port of mcpl-core/src/connection.rs
 *
 * Transport-agnostic: works over TCP, stdio, or any Node.js Readable/Writable pair.
 * Messages are framed as newline-delimited JSON (one JSON object per line).
 *
 * Dual API:
 *   - Pull-based: `nextMessage()` returns the next incoming request/notification
 *   - Event-based: `.on('request', ...)` and `.on('notification', ...)`
 *
 * Responses to pending `sendRequest()` calls are routed internally and never
 * surfaced through either API.
 */

import { EventEmitter } from 'node:events';
import type { EventEmitter as EventEmitterType } from 'node:events';
import * as net from 'node:net';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';
import type { Readable, Writable } from 'node:stream';

import type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from './types.js';
import { makeRequest, makeResponse, makeErrorResponse, makeNotification } from './types.js';
import { ConnectionClosedError, RpcError } from './errors.js';

// ── Public Types ──

export type IncomingMessage =
  | { type: 'request'; request: JsonRpcRequest }
  | { type: 'notification'; notification: JsonRpcNotification };

export interface McplConnectionEvents {
  request: [request: JsonRpcRequest];
  notification: [notification: JsonRpcNotification];
  close: [];
  error: [error: Error];
}

// Typed EventEmitter — provides compile-time event name/argument checking
type TypedEmitter = {
  on<K extends keyof McplConnectionEvents>(event: K, listener: (...args: McplConnectionEvents[K]) => void): TypedEmitter;
  emit<K extends keyof McplConnectionEvents>(event: K, ...args: McplConnectionEvents[K]): boolean;
  once<K extends keyof McplConnectionEvents>(event: K, listener: (...args: McplConnectionEvents[K]) => void): TypedEmitter;
  removeListener<K extends keyof McplConnectionEvents>(event: K, listener: (...args: McplConnectionEvents[K]) => void): TypedEmitter;
} & EventEmitterType;

// ── Pending Request Tracking ──

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// ── Connection ──

export class McplConnection extends (EventEmitter as new () => TypedEmitter) {
  private writer: Writable;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private incomingQueue: IncomingMessage[] = [];
  private incomingWaiters: Array<{
    resolve: (msg: IncomingMessage) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;

  private constructor(readable: Readable, writable: Writable) {
    super();
    this.writer = writable;

    this.rl = readline.createInterface({ input: readable, crlfDelay: Infinity });

    this.rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg: Record<string, unknown> = JSON.parse(trimmed);
        this.handleParsedMessage(msg);
      } catch (e) {
        this.emit('error', new Error(`Malformed JSON-RPC message: ${(e as Error).message}`));
      }
    });

    this.rl.on('close', () => {
      this.handleClose();
    });

    readable.on('error', (err: Error) => {
      this.emit('error', err);
    });

    writable.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  // ── Factories ──

  /** Create from a TCP socket. */
  static fromTcp(socket: net.Socket): McplConnection {
    socket.setEncoding('utf-8');
    return new McplConnection(socket, socket);
  }

  /** Create from arbitrary readable/writable streams (e.g., stdin/stdout, child process). */
  static fromStreams(readable: Readable, writable: Writable): McplConnection {
    return new McplConnection(readable, writable);
  }

  /** Accept a single TCP connection from a server and return an McplConnection. */
  static acceptTcp(server: net.Server): Promise<McplConnection> {
    return new Promise((resolve, reject) => {
      server.once('connection', (socket: net.Socket) => {
        resolve(McplConnection.fromTcp(socket));
      });
      server.once('error', reject);
    });
  }

  /**
   * Create from a WebSocket.
   * Bridges WS message frames to the readline-based parser.
   * Works with any WebSocket implementation that has `on('message')`, `send()`, and `on('close')`.
   */
  static fromWebSocket(ws: {
    on(event: 'message', cb: (data: unknown) => void): void;
    on(event: 'close', cb: () => void): void;
    on(event: 'error', cb: (err: Error) => void): void;
    send(data: string): void;
    close(): void;
    readyState?: number;
  }): McplConnection {
    const readable = new PassThrough();
    const writable = new PassThrough();

    // WS message → readable stream (add newline for readline)
    ws.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : String(data);
      readable.push(text + '\n');
    });

    ws.on('close', () => {
      readable.push(null); // EOF
    });

    ws.on('error', (err: Error) => {
      readable.destroy(err);
    });

    // Writable stream → WS message (strip trailing newline)
    writable.on('data', (chunk: Buffer) => {
      const text = chunk.toString().replace(/\n$/, '');
      if (text && ws.readyState === 1) { // OPEN
        ws.send(text);
      }
    });

    const conn = new McplConnection(readable, writable);

    // Override close to also close the WebSocket
    const originalClose = conn.close.bind(conn);
    conn.close = () => {
      originalClose();
      ws.close();
    };

    return conn;
  }

  // ── Public API ──

  get isClosed(): boolean {
    return this.closed;
  }

  /** Default timeout for sendRequest (ms). 0 = no timeout. */
  requestTimeout = 30_000;

  /**
   * Send a JSON-RPC request and wait for the response.
   * Responses are matched by ID; incoming requests/notifications that arrive
   * while waiting are queued for `nextMessage()` / event listeners.
   *
   * @param timeout Override the default request timeout (ms). 0 = no timeout.
   */
  async sendRequest(method: string, params?: unknown, timeout?: number): Promise<unknown> {
    if (this.closed) throw new ConnectionClosedError();

    const id = this.nextId++;
    const request = makeRequest(id, method, params);

    const timeoutMs = timeout ?? this.requestTimeout;

    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.pending.delete(String(id));
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const pending = this.pending.get(String(id));
          if (pending) {
            this.pending.delete(String(id));
            reject(new RpcError(-32000, `Request timed out after ${timeoutMs}ms: ${method}`));
          }
        }, timeoutMs);
      }

      this.pending.set(String(id), {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (err) => { cleanup(); reject(err); },
        timer,
      });

      this.writeLine(JSON.stringify(request));
    });
  }

  /** Send a JSON-RPC notification (fire-and-forget, no response expected). */
  sendNotification(method: string, params?: unknown): void {
    if (this.closed) return;
    const notification = makeNotification(method, params);
    this.writeLine(JSON.stringify(notification));
  }

  /** Send a JSON-RPC success response (answering an incoming request). */
  sendResponse(id: JsonRpcId, result: unknown): void {
    if (this.closed) return;
    const response = makeResponse(id, result);
    this.writeLine(JSON.stringify(response));
  }

  /**
   * Send a JSON-RPC error response.
   *
   * `data` is the optional JSON-RPC `error.data` member — SPEC §6.6 documents
   * concrete shapes for it, e.g. `data: { capability }` on capability-denied
   * errors and `data: { featureSet }` on feature-set errors. Omitted entirely
   * from the wire when not provided.
   */
  sendError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    if (this.closed) return;
    const response = makeErrorResponse(id, data === undefined ? { code, message } : { code, message, data });
    this.writeLine(JSON.stringify(response));
  }

  /**
   * Pull-based API: get the next incoming request or notification.
   * Responses to our pending requests are routed internally (never returned here).
   * Resolves when the next message arrives, or rejects on close.
   */
  async nextMessage(): Promise<IncomingMessage> {
    // Drain queued messages first
    const queued = this.incomingQueue.shift();
    if (queued) return queued;

    if (this.closed) throw new ConnectionClosedError();

    // Wait for the next one
    return new Promise<IncomingMessage>((resolve, reject) => {
      this.incomingWaiters.push({ resolve, reject });
    });
  }

  /** Close the connection. */
  close(): void {
    if (this.closed) return;
    this.handleClose();
    this.rl.close();
    if ('destroy' in this.writer && typeof this.writer.destroy === 'function') {
      this.writer.destroy();
    }
  }

  // ── Internal ──

  private writeLine(json: string): void {
    this.writer.write(json + '\n');
  }

  private handleParsedMessage(msg: Record<string, unknown>): void {
    if (msg.jsonrpc !== '2.0') return; // Not a valid JSON-RPC 2.0 message

    const hasId = msg.id != null;
    const hasMethod = typeof msg.method === 'string';
    const hasResult = 'result' in msg;
    const hasError = 'error' in msg;

    if (hasId && (hasResult || hasError)) {
      // Response to one of our pending requests
      this.routeResponse(msg as unknown as JsonRpcResponse);
    } else if (hasId && hasMethod) {
      // Incoming request
      this.routeIncoming({
        type: 'request',
        request: msg as unknown as JsonRpcRequest,
      });
    } else if (hasMethod && !hasId) {
      // Notification
      this.routeIncoming({
        type: 'notification',
        notification: msg as unknown as JsonRpcNotification,
      });
    }
  }

  private routeResponse(resp: JsonRpcResponse): void {
    const key = String(resp.id);
    const pending = this.pending.get(key);
    if (!pending) return;

    this.pending.delete(key);
    if (resp.error) {
      pending.reject(new RpcError(resp.error.code, resp.error.message, resp.error.data));
    } else {
      pending.resolve(resp.result);
    }
  }

  private routeIncoming(msg: IncomingMessage): void {
    // Emit events for EventEmitter consumers
    if (msg.type === 'request') {
      this.emit('request', msg.request);
    } else {
      this.emit('notification', msg.notification);
    }

    // Feed pull-based consumers
    const waiter = this.incomingWaiters.shift();
    if (waiter) {
      waiter.resolve(msg);
    } else {
      this.incomingQueue.push(msg);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;

    // Reject all pending requests and clear their timers
    const closedErr = new ConnectionClosedError();
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(closedErr);
    }
    this.pending.clear();

    // Reject all pull-based waiters
    for (const waiter of this.incomingWaiters) {
      waiter.reject(closedErr);
    }
    this.incomingWaiters = [];

    this.emit('close');
  }
}
