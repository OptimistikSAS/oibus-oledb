import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const BINARY_NAME = 'OIBusOleDbWindows.exe';
const BINARY_ENV_OVERRIDE = 'OIBUS_OLEDB_WINDOWS_BINARY';
const EXTRACT_DIR_ENV = 'OIBUS_OLEDB_EXTRACT_DIR';
// Kept in the error raised when the helper exits unexpectedly (the .NET runtime reports crashes there)
const MAX_STDERR_LENGTH = 4096;

/** Information on an open connection, from the OLE DB provider. `serverVersion` is empty when the provider does not report one. */
export interface OleDbConnectionInfo {
  provider: string;
  dataSource: string;
  database: string;
  serverVersion: string;
}

/**
 * Category of the .NET type of a column:
 * - `string`, `number` and `boolean` columns give JSON values of that type (except 64-bit integers beyond
 *   `Number.MAX_SAFE_INTEGER` and non-finite floating-point numbers, given as strings so that no digit is lost);
 * - `datetime` columns give ISO 8601 strings with milliseconds and **without offset** (`2026-01-01T10:00:00.000`): OLE DB
 *   timestamps carry no time zone, interpreting them is the caller's job;
 * - `datetimeoffset` columns give ISO 8601 strings with their offset (`2026-01-01T10:00:00.000+01:00`);
 * - `binary` columns give base64 strings; `other` columns (GUID, time span...) give their invariant-culture string.
 */
export type OleDbColumnType = 'string' | 'number' | 'boolean' | 'datetime' | 'datetimeoffset' | 'binary' | 'other';

export interface OleDbColumn {
  name: string;
  type: OleDbColumnType;
  /** The provider's own name of the column type (`DBTYPE_I4`, `DBTYPE_DBTIMESTAMP`...) */
  dataTypeName: string;
}

export type OleDbValue = string | number | boolean | null;

/** One row, keyed by column name. When several columns share a name, the last one wins. */
export type OleDbRecord = Record<string, OleDbValue>;

export interface OleDbQueryResult {
  columns: Array<OleDbColumn>;
  records: Array<OleDbRecord>;
}

export interface OleDbConnectOptions {
  /** Time to open the connection, in ms. Not set or 0: no timeout. */
  connectionTimeout?: number;
}

export interface OleDbQueryOptions {
  /** Time to run the query and read its result, in ms. Not set or 0: no timeout. */
  timeout?: number;
}

/**
 * `ok` only ever appears on `connect`/`disconnect` responses. `query` responses carry no `ok` at all — `error`'s presence
 * is the only failure signal.
 */
interface OleDbResponse {
  requestId?: string;
  ok?: boolean;
  error?: string;
  info?: OleDbConnectionInfo;
  columns?: Array<OleDbColumn>;
  rows?: Array<Array<OleDbValue>>;
}

// Only an x64 helper is shipped: Node.js has no 32-bit Windows release since v23, and Windows on ARM (arm64) is
// not supported.
const ARCH_FOLDERS: Partial<Record<NodeJS.Architecture, string>> = {
  x64: 'win-x64'
};

/**
 * Resolves the bundled OIBusOleDbWindows helper binary for the current architecture. Overridable via
 * OIBUS_OLEDB_WINDOWS_BINARY (used to run a custom build during development).
 *
 * When the calling application is itself bundled with `pkg` (or `@yao-pkg/pkg`), `__dirname`-relative paths resolve
 * inside pkg's virtual snapshot filesystem: `fs` reads work there, but `child_process.spawn()` needs a real file. The
 * binary is then extracted first (see `extractFromPkgSnapshotIfNeeded`), into the folder named by OIBUS_OLEDB_EXTRACT_DIR,
 * or else the temporary folder of the operating system.
 */
export function resolveOleDbBinaryPath(): string {
  const override = process.env[BINARY_ENV_OVERRIDE];
  if (override) {
    return override;
  }
  const archFolder = ARCH_FOLDERS[process.arch];
  if (!archFolder) {
    throw new Error(`Unsupported architecture for the OLE DB Windows helper: ${process.arch}`);
  }
  const bundledPath = path.join(__dirname, '..', 'runtimes', archFolder, BINARY_NAME);
  return extractFromPkgSnapshotIfNeeded(bundledPath, process.env[EXTRACT_DIR_ENV] || os.tmpdir());
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Whether the file exists with exactly this SHA-256 */
function hasHash(filePath: string, hash: string): boolean {
  try {
    return sha256(fs.readFileSync(filePath)) === hash;
  } catch {
    return false;
  }
}

/**
 * Outside of a pkg bundle, returns the bundled path unchanged. Inside one (`process.pkg` is set), copies the binary
 * out of the snapshot to `<extractDir>/oibus-oledb/<content hash>/` and returns that path.
 *
 * The folder is named after the binary's content, so that several applications on the same machine (two OIBus
 * services, for instance) share one extracted copy per helper version: Windows forbids replacing an executable while
 * it runs, so an already extracted copy is reused, and a new version goes to its own folder. A copy is written to a
 * per-process temporary name first and then renamed into place (atomic on the same volume), so that no process ever
 * spawns a partially written file; when another process won the race, its copy is used.
 *
 * An extracted copy is only ever spawned after its SHA-256 was checked against the bundled binary: a copy that was
 * altered in the extraction folder (which may be writable by other users, as the temporary folder is) is replaced, and
 * when it cannot be replaced (another process runs it), an error is thrown instead of running it.
 *
 * Exported for this package's own tests — not part of the public API.
 */
export function extractFromPkgSnapshotIfNeeded(bundledPath: string, extractDir: string = os.tmpdir()): string {
  if (!('pkg' in process)) {
    return bundledPath;
  }
  const content = fs.readFileSync(bundledPath);
  const hash = sha256(content);
  const extractedPath = path.join(extractDir, 'oibus-oledb', hash.slice(0, 16), path.basename(bundledPath));
  if (hasHash(extractedPath, hash)) {
    return extractedPath;
  }
  fs.mkdirSync(path.dirname(extractedPath), { recursive: true });
  const tempPath = `${extractedPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, content);
  try {
    fs.renameSync(tempPath, extractedPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    // Another process extracted (and may already run) the same binary in the meantime: its copy is used, once checked
    if (!fs.existsSync(extractedPath)) {
      throw error;
    }
  }
  if (!hasHash(extractedPath, hash)) {
    throw new Error(`The extracted OLE DB helper ${extractedPath} does not match the bundled one (SHA-256 mismatch): it was not run`);
  }
  return extractedPath;
}

interface PendingRequest {
  resolve: (response: OleDbResponse) => void;
  reject: (error: Error) => void;
}

/**
 * Manages exactly one OIBusOleDbWindows child process and multiplexes any number of concurrent logical connections
 * over it via a per-connection `id` and a per-request `requestId` for response correlation — responses can arrive out
 * of order across connections. `spawnFn` is injectable so tests can supply a fake child process.
 */
export class OleDbBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private startupError: Error | null = null;
  private stderr = '';

  constructor(
    private readonly binaryPath: string = resolveOleDbBinaryPath(),
    private readonly spawnFn: typeof spawn = spawn
  ) {}

  get isRunning(): boolean {
    return this.child !== null;
  }

  send(command: Record<string, unknown>): Promise<OleDbResponse> {
    this.ensureStarted();
    if (this.startupError) {
      return Promise.reject(this.startupError);
    }
    const child = this.child!;
    const requestId = String(this.nextRequestId++);
    return new Promise<OleDbResponse>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ ...command, requestId })}\n`);
    });
  }

  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.failAll(new Error('OLE DB helper process was stopped'));
  }

  private ensureStarted(): void {
    if (this.child) {
      return;
    }
    this.startupError = null;
    this.stderr = '';
    const child = this.spawnFn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;

    createInterface({ input: child.stdout }).on('line', line => this.handleLine(line));
    // Always consumed, so that the helper never blocks on a full stderr pipe
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR_LENGTH);
    });
    // Events of a process already stopped (and maybe replaced by a new one) are ignored: stop() already failed its
    // pending requests, and the ones pending now belong to the new process.
    child.on('error', error => {
      if (this.child !== child) {
        return;
      }
      this.startupError = error;
      this.failAll(error);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      const details = this.stderr.trim();
      this.failAll(new Error(`OLE DB helper exited unexpectedly (code ${code}, signal ${signal})${details ? `: ${details}` : ''}`));
    });
  }

  private handleLine(line: string): void {
    let response: OleDbResponse;
    try {
      response = JSON.parse(line) as OleDbResponse;
    } catch {
      return;
    }
    const requestId = response.requestId;
    if (!requestId) {
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    pending.resolve(response);
  }

  private failAll(error: Error): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }
}

let sharedBridge: OleDbBridge | null = null;
let refCount = 0;
let bridgeFactory: () => OleDbBridge = () => new OleDbBridge();

function acquireBridge(): OleDbBridge {
  if (!sharedBridge) {
    sharedBridge = bridgeFactory();
  }
  refCount++;
  return sharedBridge;
}

function releaseBridge(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && sharedBridge) {
    sharedBridge.stop();
    sharedBridge = null;
  }
}

/**
 * Test-only seam: swaps the factory used to create the shared bridge singleton and resets reference counting. Not part
 * of the package's public API.
 */
export function __resetSharedBridgeForTesting(factory?: () => OleDbBridge): void {
  if (sharedBridge) {
    sharedBridge.stop();
  }
  sharedBridge = null;
  refCount = 0;
  bridgeFactory = factory ?? (() => new OleDbBridge());
}

/**
 * Builds the records of a result set, keyed by column name, from the rows the helper sends as arrays in column order.
 * Exported for this package's own tests — not part of the public API.
 */
export function toRecords(columns: Array<OleDbColumn>, rows: Array<Array<OleDbValue>>): Array<OleDbRecord> {
  return rows.map(row => {
    const record: OleDbRecord = {};
    columns.forEach((column, index) => {
      record[column.name] = row[index] ?? null;
    });
    return record;
  });
}

/**
 * One logical OLE DB connection. Any number of `OleDbConnection`s — against the same or different providers and
 * databases — share a single OIBusOleDbWindows child process, spawned lazily on the first `connect()` and stopped once
 * the last connection is closed. Each connection has its own `OleDbConnection` on the .NET side, which runs its queries
 * one at a time, in call order; queries on different connections run concurrently.
 *
 * The OLE DB provider named in the connection string (`Provider=...`) must be installed on the machine, in its 64-bit
 * version: this package bundles no provider.
 */
export class OleDbConnection {
  private closed = false;

  private constructor(
    private readonly id: string,
    private readonly bridge: OleDbBridge,
    readonly info: OleDbConnectionInfo
  ) {}

  static async connect(connectionString: string, options: OleDbConnectOptions = {}): Promise<OleDbConnection> {
    if (process.platform !== 'win32') {
      throw new Error('OLE DB requires Windows');
    }
    const bridge = acquireBridge();
    const id = crypto.randomUUID();
    try {
      const response = await bridge.send({ command: 'connect', id, connectionString, connectionTimeout: options.connectionTimeout });
      if (!response.ok) {
        throw new Error(response.error ?? 'Unknown error while connecting');
      }
      return new OleDbConnection(id, bridge, response.info!);
    } catch (error) {
      releaseBridge();
      throw error;
    }
  }

  /**
   * Runs the SQL text and returns the columns and the records of its first result set (none for a statement returning
   * no result set). On failure (provider error, timeout, connection lost...), rejects with the provider's message;
   * logging it is left to the caller. A connection whose query failed because the connection was lost stays unusable:
   * disconnect it and open a new one.
   */
  async query(sql: string, options: OleDbQueryOptions = {}): Promise<OleDbQueryResult> {
    if (this.closed) {
      throw new Error('Connection is closed');
    }
    const response = await this.bridge.send({ command: 'query', id: this.id, sql, timeout: options.timeout });
    if (response.error) {
      throw new Error(response.error);
    }
    const columns = response.columns ?? [];
    return { columns, records: toRecords(columns, response.rows ?? []) };
  }

  async disconnect(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.bridge.send({ command: 'disconnect', id: this.id });
    } catch {
      // Best-effort: the helper may already be gone (crash, prior stop). Either way this connection's slot on the
      // shared bridge is released below.
    } finally {
      releaseBridge();
    }
  }
}
