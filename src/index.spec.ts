import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OleDbBridge,
  OleDbColumn,
  OleDbConnection,
  __resetSharedBridgeForTesting,
  extractFromPkgSnapshotIfNeeded,
  resolveOleDbBinaryPath,
  toRecords
} from './index';

/** A fake child process good enough to drive readline + event listeners the same way a real one would. */
class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = { write: mock.fn((_chunk: string) => true) };
  kill = mock.fn(() => true);

  respond(response: unknown): void {
    this.stdout.write(`${JSON.stringify(response)}\n`);
  }

  request(index: number): Record<string, unknown> {
    return JSON.parse((this.stdin.write.mock.calls[index].arguments[0] as string).trim());
  }

  lastRequest(): Record<string, unknown> {
    return this.request(this.stdin.write.mock.calls.length - 1);
  }
}

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

const setPkg = (enabled: boolean) => {
  if (enabled) {
    (process as unknown as { pkg?: unknown }).pkg = {};
  } else {
    delete (process as unknown as { pkg?: unknown }).pkg;
  }
};

describe('resolveOleDbBinaryPath', () => {
  afterEach(() => {
    delete process.env.OIBUS_OLEDB_WINDOWS_BINARY;
  });

  it('returns the OIBUS_OLEDB_WINDOWS_BINARY override when set', () => {
    process.env.OIBUS_OLEDB_WINDOWS_BINARY = 'C:\\custom\\OIBusOleDbWindows.exe';
    assert.strictEqual(resolveOleDbBinaryPath(), 'C:\\custom\\OIBusOleDbWindows.exe');
  });

  it('resolves the bundled x64 helper', () => {
    const originalArch = process.arch;
    Object.defineProperty(process, 'arch', { value: 'x64' });
    try {
      assert.strictEqual(resolveOleDbBinaryPath(), path.join(__dirname, '..', 'runtimes', 'win-x64', 'OIBusOleDbWindows.exe'));
    } finally {
      Object.defineProperty(process, 'arch', { value: originalArch });
    }
  });

  it('throws for an unsupported architecture', () => {
    const originalArch = process.arch;
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    try {
      assert.throws(() => resolveOleDbBinaryPath(), /Unsupported architecture/);
    } finally {
      Object.defineProperty(process, 'arch', { value: originalArch });
    }
  });
});

// Exercised against throwaway scratch folders (not the package's own `runtimes/` folder or the real temp folder).
describe('extractFromPkgSnapshotIfNeeded', () => {
  let scratchDir: string;
  let tmpDir: string;
  let bundledPath: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oledb-pkg-test-'));
    tmpDir = path.join(scratchDir, 'tmp');
    bundledPath = path.join(scratchDir, 'OIBusOleDbWindows.exe');
    fs.writeFileSync(bundledPath, 'fake binary contents');
  });

  afterEach(() => {
    setPkg(false);
    mock.restoreAll();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('returns the bundled path unchanged outside of a pkg bundle', () => {
    assert.strictEqual(extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir), bundledPath);
    assert.strictEqual(fs.existsSync(tmpDir), false);
  });

  it('copies the binary to a folder named after its content when running under pkg', () => {
    setPkg(true);
    const resolved = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    assert.strictEqual(path.dirname(path.dirname(resolved)), path.join(tmpDir, 'oibus-oledb'));
    assert.match(path.basename(path.dirname(resolved)), /^[0-9a-f]{16}$/);
    assert.strictEqual(path.basename(resolved), 'OIBusOleDbWindows.exe');
    assert.strictEqual(fs.readFileSync(resolved, 'utf8'), 'fake binary contents');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(resolved)), ['OIBusOleDbWindows.exe'], 'no temporary file left');
  });

  it('reuses an already extracted copy, which may be running', () => {
    setPkg(true);
    const first = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    const renameSync = mock.method(fs, 'renameSync');
    assert.strictEqual(extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir), first);
    assert.strictEqual(renameSync.mock.calls.length, 0);
  });

  it('extracts another version of the binary to another folder', () => {
    setPkg(true);
    const first = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    fs.writeFileSync(bundledPath, 'new fake binary contents');
    const second = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    assert.notStrictEqual(second, first);
    assert.strictEqual(fs.readFileSync(second, 'utf8'), 'new fake binary contents');
    assert.strictEqual(fs.readFileSync(first, 'utf8'), 'fake binary contents');
  });

  it('uses the copy of another process that won the extraction race', () => {
    setPkg(true);
    mock.method(fs, 'renameSync', (_from: fs.PathLike, to: fs.PathLike) => {
      fs.writeFileSync(to, 'fake binary contents');
      throw new Error('EPERM: operation not permitted, rename');
    });
    const resolved = extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir);
    assert.strictEqual(fs.readFileSync(resolved, 'utf8'), 'fake binary contents');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(resolved)), ['OIBusOleDbWindows.exe'], 'temporary file removed');
  });

  it('throws when the copy cannot be renamed into place', () => {
    setPkg(true);
    mock.method(fs, 'renameSync', () => {
      throw new Error('EACCES: permission denied, rename');
    });
    assert.throws(() => extractFromPkgSnapshotIfNeeded(bundledPath, tmpDir), /EACCES/);
  });
});

describe('toRecords', () => {
  const columns: Array<OleDbColumn> = [
    { name: 'timestamp', type: 'datetime', dataTypeName: 'DBTYPE_DBTIMESTAMP' },
    { name: 'value', type: 'number', dataTypeName: 'DBTYPE_R8' },
    { name: 'label', type: 'string', dataTypeName: 'DBTYPE_WVARCHAR' }
  ];

  it('keys each row by column name', () => {
    assert.deepStrictEqual(
      toRecords(columns, [
        ['2026-01-01T10:00:00.000', 1.5, 'a'],
        ['2026-01-01T11:00:00.000', null, 'b']
      ]),
      [
        { timestamp: '2026-01-01T10:00:00.000', value: 1.5, label: 'a' },
        { timestamp: '2026-01-01T11:00:00.000', value: null, label: 'b' }
      ]
    );
  });

  it('gives null to a missing value', () => {
    assert.deepStrictEqual(toRecords(columns, [['2026-01-01T10:00:00.000']]), [
      { timestamp: '2026-01-01T10:00:00.000', value: null, label: null }
    ]);
  });

  it('keeps the last of several columns sharing a name', () => {
    const duplicated: Array<OleDbColumn> = [
      { name: 'value', type: 'number', dataTypeName: 'DBTYPE_I4' },
      { name: 'value', type: 'string', dataTypeName: 'DBTYPE_WVARCHAR' }
    ];
    assert.deepStrictEqual(toRecords(duplicated, [[1, 'one']]), [{ value: 'one' }]);
  });
});

describe('OleDbBridge', () => {
  let lastChild: FakeChildProcess;
  let spawnMock: ReturnType<typeof createSpawnMock>;
  const createSpawnMock = () =>
    mock.fn((_binary: string, _args: Array<string>, _options: unknown) => {
      lastChild = new FakeChildProcess();
      return lastChild as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createBridge = () => new OleDbBridge('binary.exe', spawnMock as any);

  beforeEach(() => {
    spawnMock = createSpawnMock();
  });

  it('spawns the helper lazily, once, with a hidden window', async () => {
    const bridge = createBridge();
    assert.strictEqual(bridge.isRunning, false);
    const first = bridge.send({ command: 'query', id: 'a' });
    const second = bridge.send({ command: 'query', id: 'b' });
    assert.strictEqual(bridge.isRunning, true);
    assert.strictEqual(spawnMock.mock.calls.length, 1);
    assert.strictEqual(spawnMock.mock.calls[0].arguments[0], 'binary.exe');
    assert.deepStrictEqual(spawnMock.mock.calls[0].arguments[2], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    bridge.stop();
    await assert.rejects(first);
    await assert.rejects(second);
  });

  it('tags every outgoing command with a distinct requestId and resolves by matching it back', async () => {
    const bridge = createBridge();
    const first = bridge.send({ command: 'query', id: 'a' });
    const second = bridge.send({ command: 'query', id: 'b' });

    const req1 = lastChild.request(0);
    const req2 = lastChild.request(1);
    assert.notStrictEqual(req1.requestId, req2.requestId);

    // Answer out of order — the second request's response arrives first.
    lastChild.respond({ requestId: req2.requestId, columns: [], rows: [] });
    lastChild.respond({ requestId: req1.requestId, columns: [], rows: [] });

    assert.deepStrictEqual(await second, { requestId: req2.requestId, columns: [], rows: [] });
    assert.deepStrictEqual(await first, { requestId: req1.requestId, columns: [], rows: [] });
  });

  it('ignores lines that are not JSON, have no requestId or answer no pending request', async () => {
    const bridge = createBridge();
    const pending = bridge.send({ command: 'query', id: 'a' });
    const { requestId } = lastChild.lastRequest();
    lastChild.stdout.write('not json\n');
    lastChild.respond({ error: 'no request id' });
    lastChild.respond({ requestId: 'unknown', ok: true });
    lastChild.respond({ requestId, ok: true });
    assert.deepStrictEqual(await pending, { requestId, ok: true });
  });

  it('fails every pending request when the process exits unexpectedly, with what it wrote to stderr', async () => {
    const bridge = createBridge();
    const pending = bridge.send({ command: 'query', id: 'a' });
    lastChild.stderr.write('Unhandled exception. System.OutOfMemoryException\n');
    await new Promise(resolve => setImmediate(resolve));
    lastChild.emit('exit', 1, null);
    await assert.rejects(pending, {
      message: 'OLE DB helper exited unexpectedly (code 1, signal null): Unhandled exception. System.OutOfMemoryException'
    });
    assert.strictEqual(bridge.isRunning, false);
  });

  it('spawns a new process for the next command after an unexpected exit', async () => {
    const bridge = createBridge();
    const pending = bridge.send({ command: 'query', id: 'a' });
    lastChild.emit('exit', null, 'SIGTERM');
    await assert.rejects(pending, { message: 'OLE DB helper exited unexpectedly (code null, signal SIGTERM)' });

    const next = bridge.send({ command: 'query', id: 'a' });
    assert.strictEqual(spawnMock.mock.calls.length, 2);
    lastChild.respond({ requestId: lastChild.lastRequest().requestId, columns: [], rows: [] });
    await next;
  });

  it('fails a send() issued while spawning failed', async () => {
    const bridge = createBridge();
    const pending = bridge.send({ command: 'connect', id: 'a' });
    lastChild.emit('error', new Error('spawn ENOENT'));
    await assert.rejects(pending, { message: 'spawn ENOENT' });
    await assert.rejects(bridge.send({ command: 'connect', id: 'a' }), { message: 'spawn ENOENT' });
  });

  it('stop() kills the process and rejects anything still pending', async () => {
    const bridge = createBridge();
    const pending = bridge.send({ command: 'query', id: 'a' });
    bridge.stop();
    await assert.rejects(pending, { message: 'OLE DB helper process was stopped' });
    assert.strictEqual(lastChild.kill.mock.calls.length, 1);
    assert.strictEqual(bridge.isRunning, false);
  });

  it('ignores the late exit and error events of a stopped process', async () => {
    const bridge = createBridge();
    bridge.send({ command: 'query', id: 'a' }).catch(() => undefined);
    const stoppedChild = lastChild;
    bridge.stop();

    const pending = bridge.send({ command: 'query', id: 'a' });
    stoppedChild.emit('exit', null, 'SIGTERM');
    stoppedChild.emit('error', new Error('kill EPERM'));
    assert.strictEqual(bridge.isRunning, true);
    lastChild.respond({ requestId: lastChild.lastRequest().requestId, columns: [], rows: [] });
    await pending;
  });
});

describe('OleDbConnection', () => {
  let lastChild: FakeChildProcess;
  let spawnMock: ReturnType<typeof mock.fn>;
  const info = { provider: 'MSOLEDBSQL', dataSource: 'localhost', database: 'oibus', serverVersion: '16.00.1000' };
  const connectionString = 'Provider=MSOLEDBSQL;Data Source=localhost;Initial Catalog=oibus;Integrated Security=SSPI';

  const connect = async (options?: { connectionTimeout?: number }) => {
    const connectPromise = OleDbConnection.connect(connectionString, options);
    lastChild.respond({ ...lastChild.lastRequest(), ok: true, info });
    return connectPromise;
  };
  const disconnect = async (connection: OleDbConnection) => {
    const disconnectPromise = connection.disconnect();
    lastChild.respond({ ...lastChild.lastRequest(), ok: true });
    await disconnectPromise;
  };

  beforeEach(() => {
    spawnMock = mock.fn((_binary: string, _args: Array<string>, _options: unknown) => {
      lastChild = new FakeChildProcess();
      return lastChild;
    });
    setPlatform('win32');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __resetSharedBridgeForTesting(() => new OleDbBridge('binary.exe', spawnMock as any));
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    __resetSharedBridgeForTesting();
  });

  it('rejects immediately on a non-Windows platform without touching the shared bridge', async () => {
    setPlatform('linux');
    await assert.rejects(OleDbConnection.connect(connectionString), { message: 'OLE DB requires Windows' });
    assert.strictEqual(spawnMock.mock.calls.length, 0);
  });

  it('connects with the connection string and timeout and exposes the connection info', async () => {
    const connectPromise = OleDbConnection.connect(connectionString, { connectionTimeout: 5000 });
    const request = lastChild.lastRequest();
    assert.deepStrictEqual(
      { command: request.command, connectionString: request.connectionString, connectionTimeout: request.connectionTimeout },
      { command: 'connect', connectionString, connectionTimeout: 5000 }
    );
    assert.match(request.id as string, /^[0-9a-f-]{36}$/);
    lastChild.respond({ ...request, ok: true, info });
    const connection = await connectPromise;
    assert.deepStrictEqual(connection.info, info);
  });

  it('sends no connection timeout when none is given', async () => {
    await connect();
    assert.strictEqual(lastChild.request(0).connectionTimeout, undefined);
  });

  it('releases the shared process reference when connect() itself fails', async () => {
    const failingPromise = OleDbConnection.connect(connectionString);
    lastChild.respond({ ...lastChild.lastRequest(), error: "The 'MSOLEDBSQL' provider is not registered on the local machine." });
    await assert.rejects(failingPromise, { message: "The 'MSOLEDBSQL' provider is not registered on the local machine." });
    assert.strictEqual(lastChild.kill.mock.calls.length, 1, 'nothing else was using the process, so it is torn down');

    await connect();
    assert.strictEqual(spawnMock.mock.calls.length, 2, 'a fresh process is spawned for the next attempt');
  });

  it('rejects with a generic message when connect() fails without error', async () => {
    const failingPromise = OleDbConnection.connect(connectionString);
    lastChild.respond({ requestId: lastChild.lastRequest().requestId });
    await assert.rejects(failingPromise, { message: 'Unknown error while connecting' });
  });

  it('query() sends the SQL and timeout and returns the columns and records', async () => {
    const connection = await connect();
    const queryPromise = connection.query('SELECT timestamp, value FROM logs', { timeout: 15000 });
    const request = lastChild.lastRequest();
    assert.deepStrictEqual(
      { command: request.command, id: request.id, sql: request.sql, timeout: request.timeout },
      { command: 'query', id: lastChild.request(0).id, sql: 'SELECT timestamp, value FROM logs', timeout: 15000 }
    );
    const columns = [
      { name: 'timestamp', type: 'datetime', dataTypeName: 'DBTYPE_DBTIMESTAMP' },
      { name: 'value', type: 'number', dataTypeName: 'DBTYPE_R8' }
    ];
    lastChild.respond({ requestId: request.requestId, columns, rows: [['2026-01-01T10:00:00.000', 12.5]] });
    assert.deepStrictEqual(await queryPromise, { columns, records: [{ timestamp: '2026-01-01T10:00:00.000', value: 12.5 }] });
  });

  it('query() returns no column and no record for a statement without result set', async () => {
    const connection = await connect();
    const queryPromise = connection.query('UPDATE logs SET value = 0');
    const request = lastChild.lastRequest();
    assert.strictEqual(request.timeout, undefined);
    lastChild.respond({ requestId: request.requestId });
    assert.deepStrictEqual(await queryPromise, { columns: [], records: [] });
  });

  it('query() rejects when the helper reports a failure', async () => {
    const connection = await connect();
    const queryPromise = connection.query('SELECT * FROM missing');
    lastChild.respond({ requestId: lastChild.lastRequest().requestId, error: "Invalid object name 'missing'." });
    await assert.rejects(queryPromise, { message: "Invalid object name 'missing'." });
  });

  it('query() rejects once the connection is closed', async () => {
    const connection = await connect();
    await disconnect(connection);
    await assert.rejects(connection.query('SELECT 1'), { message: 'Connection is closed' });
  });

  it('shares one process across two concurrent connections and answers both independently', async () => {
    const first = await connect();
    const second = await connect();
    assert.strictEqual(spawnMock.mock.calls.length, 1, 'only one helper process for both connections');

    const queryA = first.query('SELECT a FROM t');
    const queryB = second.query('SELECT b FROM t');
    const reqA = lastChild.request(2);
    const reqB = lastChild.request(3);
    assert.notStrictEqual(reqA.id, reqB.id, 'each connection keeps its own id');

    // Answer B first, then A — order must not matter.
    lastChild.respond({ requestId: reqB.requestId, columns: [{ name: 'b', type: 'number', dataTypeName: 'DBTYPE_I4' }], rows: [[2]] });
    lastChild.respond({ requestId: reqA.requestId, columns: [{ name: 'a', type: 'number', dataTypeName: 'DBTYPE_I4' }], rows: [[1]] });
    assert.deepStrictEqual((await queryB).records, [{ b: 2 }]);
    assert.deepStrictEqual((await queryA).records, [{ a: 1 }]);
  });

  it('keeps the shared process alive until the last connection disconnects', async () => {
    const first = await connect();
    const second = await connect();

    await disconnect(first);
    assert.strictEqual(lastChild.kill.mock.calls.length, 0, 'still one connection using the shared process');

    await disconnect(second);
    assert.strictEqual(lastChild.kill.mock.calls.length, 1, 'process stopped once the last connection left');
  });

  it('disconnect() is idempotent', async () => {
    const connection = await connect();
    await disconnect(connection);
    await assert.doesNotReject(connection.disconnect());
    assert.strictEqual(lastChild.kill.mock.calls.length, 1);
  });

  it('disconnect() releases the shared process even when the helper is gone', async () => {
    const connection = await connect();
    const disconnectPromise = connection.disconnect();
    lastChild.emit('exit', 1, null);
    await assert.doesNotReject(disconnectPromise);

    await connect();
    assert.strictEqual(spawnMock.mock.calls.length, 2, 'a fresh process is spawned for the next connection');
  });
});
