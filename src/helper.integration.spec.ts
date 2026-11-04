import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { OleDbConnection, __resetSharedBridgeForTesting } from './index';

/**
 * End-to-end tests of the real helper (`runtimes/win-x64/`, built with `npm run build:runtimes`, or the
 * OIBUS_OLEDB_WINDOWS_BINARY override) against a real OLE DB provider. Windows only, and only when
 * OIBUS_OLEDB_INTEGRATION_CONNECTION_STRING is set — the CI sets it to a SQL Server LocalDB instance through the
 * Microsoft OLE DB Driver for SQL Server, both installed on GitHub's Windows runners:
 *   Provider=MSOLEDBSQL;Data Source=(localdb)\MSSQLLocalDB;Integrated Security=SSPI
 */
const connectionString = process.env.OIBUS_OLEDB_INTEGRATION_CONNECTION_STRING;
const skip = process.platform !== 'win32' || !connectionString ? 'Windows and OIBUS_OLEDB_INTEGRATION_CONNECTION_STRING only' : false;
// A LocalDB instance starts on its first connection, which can take a while
const CONNECTION_TIMEOUT = 120_000;

describe('OIBusOleDbWindows helper', { skip }, () => {
  after(() => {
    __resetSharedBridgeForTesting();
  });

  it('reports a provider that is not installed', async () => {
    await assert.rejects(OleDbConnection.connect('Provider=OIBus.Missing.Provider;Data Source=nowhere'), /not registered/);
  });

  it('connects and returns the connection info', async () => {
    const connection = await OleDbConnection.connect(connectionString!, { connectionTimeout: CONNECTION_TIMEOUT });
    try {
      assert.match(connection.info.provider, /MSOLEDBSQL/i);
      assert.ok(connection.info.serverVersion.length > 0);
    } finally {
      await connection.disconnect();
    }
  });

  it('returns typed values', async () => {
    const connection = await OleDbConnection.connect(connectionString!, { connectionTimeout: CONNECTION_TIMEOUT });
    try {
      const result = await connection.query(
        `SELECT CAST('2026-01-01T10:00:00.123' AS datetime2(3)) AS ts,
                CAST(1.5 AS float) AS f,
                CAST(12.34 AS decimal(10, 2)) AS d,
                CAST(42 AS int) AS i,
                CAST(9007199254740993 AS bigint) AS big,
                CAST(1 AS bit) AS b,
                N'é€ 中文' AS s,
                CAST(NULL AS int) AS n,
                0x0102 AS bin,
                (SELECT COUNT(*) FROM (VALUES (1), (2)) AS v(x))`,
        { timeout: 30_000 }
      );
      assert.deepStrictEqual(
        result.columns.map(column => [column.name, column.type]),
        [
          ['ts', 'datetime'],
          ['f', 'number'],
          ['d', 'number'],
          ['i', 'number'],
          ['big', 'number'],
          ['b', 'boolean'],
          ['s', 'string'],
          ['n', 'number'],
          ['bin', 'binary'],
          ['Column10', 'number']
        ]
      );
      assert.deepStrictEqual(result.records, [
        {
          ts: '2026-01-01T10:00:00.123',
          f: 1.5,
          d: 12.34,
          i: 42,
          big: '9007199254740993',
          b: true,
          s: 'é€ 中文',
          n: null,
          bin: 'AQI=',
          Column10: 2
        }
      ]);
    } finally {
      await connection.disconnect();
    }
  });

  it('returns no column and no record for a statement without result set', async () => {
    const connection = await OleDbConnection.connect(connectionString!, { connectionTimeout: CONNECTION_TIMEOUT });
    try {
      assert.deepStrictEqual(await connection.query('DECLARE @x int'), { columns: [], records: [] });
    } finally {
      await connection.disconnect();
    }
  });

  it('reports a query error', async () => {
    const connection = await OleDbConnection.connect(connectionString!, { connectionTimeout: CONNECTION_TIMEOUT });
    try {
      await assert.rejects(connection.query('SELECT * FROM oibus_missing_table'), /oibus_missing_table/);
    } finally {
      await connection.disconnect();
    }
  });

  it('stops a query running longer than its timeout', async () => {
    const connection = await OleDbConnection.connect(connectionString!, { connectionTimeout: CONNECTION_TIMEOUT });
    try {
      const start = Date.now();
      await assert.rejects(connection.query("WAITFOR DELAY '00:00:10'", { timeout: 1000 }), { message: 'Query timed out after 1000 ms' });
      assert.ok(Date.now() - start < 8000, 'the query was cancelled');
    } finally {
      await connection.disconnect();
    }
  });
});
