# @oibus/oledb

A Windows-only npm package: a small .NET console app running SQL queries through OLE DB
(`System.Data.OleDb`), plus the TypeScript driver (`src/index.ts`) that spawns and talks to it. A
standalone driver for querying OLE DB data sources from Node.js on Windows — no dependency on any
other project. It replaces the OLE DB part of the former OIBus Agent Windows service.

Instead of installing a separate, long-running Windows Service, the calling process spawns this
package's helper itself as a local child process on demand, talks to it over a small stdio JSON
protocol, and stops it once its last connection is closed.

## License & third-party notices

This repository's own source (`Program.cs`, `src/`) is licensed under the EUPL-1.2 — see
[LICENSE](LICENSE). The published Windows binary additionally embeds, unmodified and not covered by
the EUPL, `System.Data.OleDb` (with its dependencies) and the .NET runtime (self-contained publish),
licensed under the **MIT License** (Copyright (c) .NET Foundation and Contributors), with the .NET
runtime's own third-party notices. The full license texts are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and the `runtimes/win-x64/` folder ships them next
to the executable.

**No OLE DB provider is included.** The provider named by the `Provider` keyword of a connection
string (Microsoft OLE DB Driver for SQL Server, Oracle Provider for OLE DB, a historian's own
provider...) must be installed on the machine by its owner, under its own license, and is loaded by
Windows at runtime.

## Install

```bash
npm install @oibus/oledb
```

Windows only (`os: ["win32"]` in `package.json` — npm will refuse to install it on any other
platform), x64 only. The helper is a 64-bit process: it can only load **64-bit** OLE DB providers
(for instance, `Microsoft.Jet.OLEDB.4.0` only exists in 32 bits: use `Microsoft.ACE.OLEDB.12.0` or
`16.0` 64-bit instead).

```ts
import { OleDbConnection } from '@oibus/oledb';

const connection = await OleDbConnection.connect('Provider=MSOLEDBSQL;Data Source=localhost;Initial Catalog=oibus;Integrated Security=SSPI', {
  connectionTimeout: 15_000
});
const { columns, records } = await connection.query('SELECT timestamp, reference, value FROM logs', { timeout: 30_000 });
// columns: [{ name: 'timestamp', type: 'datetime', dataTypeName: 'DBTYPE_DBTIMESTAMP' }, ...]
// records: [{ timestamp: '2026-01-01T10:00:00.000', reference: 'a', value: 12.5 }, ...]
await connection.disconnect();
```

## Values

`query()` returns the first result set of the SQL text: its `columns` (name, type category and the
provider's own type name) and its `records`, one object per row keyed by column name (when several
columns share a name, the last one wins; unnamed columns, like `COUNT(*)` with some providers, are
named `Column<position>`). A statement returning no result set gives no column and no record.

| Column type      | JSON value                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `string`         | string                                                                                                |
| `number`         | number; a 64-bit integer beyond `Number.MAX_SAFE_INTEGER` or a non-finite float is given as a string |
| `boolean`        | boolean                                                                                               |
| `datetime`       | ISO 8601 string with milliseconds and **no offset** (`2026-01-01T10:00:00.000`)                       |
| `datetimeoffset` | ISO 8601 string with its offset (`2026-01-01T10:00:00.000+01:00`)                                     |
| `binary`         | base64 string                                                                                         |
| `other`          | invariant-culture string (GUID, time span...)                                                         |

`NULL` gives `null`. OLE DB timestamps carry no time zone: a `datetime` value is the source's own
local date and time, and interpreting it (in UTC, or in the time zone of the database) is the
caller's job. A value the provider fails to convert gives `null` instead of failing the query.

## Timeouts

- `connectionTimeout` (ms): enforced by the helper itself, since `OleDbConnection.ConnectionTimeout`
  is read-only and provider-specific. On expiry, `connect()` rejects right away, and the pending
  connection is disposed whenever the provider gives up.
- `timeout` (ms) of `query()`: applied twice — as `OleDbCommand.CommandTimeout` (in seconds, rounded
  up, for the providers supporting it), and as a cancellation of the command (`OleDbCommand.Cancel()`)
  after `timeout` ms, also checked between rows while a large result set is read. The query then
  rejects with `Query timed out after <timeout> ms`.

Not set (or 0): no timeout.

## Architecture

A single .NET helper process, spawned lazily on the first `connect()` call and stopped once the
last open connection disconnects, multiplexes any number of concurrent logical connections over one
stdio JSON protocol: each connection is tracked by a UUID `id`, and every request/response carries a
`requestId` so responses (which can arrive out of order across connections) get matched back to the
right caller. Commands on the same connection id run in strict arrival order (an OLE DB connection
runs one command at a time), while commands on different connection ids run concurrently. When
stdin closes, the process drains all in-flight work before exiting.

Each connection gets its own `OleDbConnection` on the .NET side, so different connections can target
different providers and databases. **Connect is idempotent and self-healing**: an open connection is
kept as is, a connection that is no longer open is dropped and opened again, and a connection that
fails to open is never kept. **No auto-connect on query** — `query` returns `"Not connected"` if the
id is unknown: a caller connects explicitly first and owns its reconnection policy. A connection
whose query failed because the database link was lost stays unusable: disconnect it and open a new
one.

stdin and stdout are read and written as UTF-8 explicitly, whatever the console code page, so
non-ASCII SQL text and values go through unchanged. If the helper exits unexpectedly, every pending
request is rejected with its exit code and the end of what it wrote to stderr (where the .NET
runtime reports crashes).

## Works inside a `pkg`-bundled application too

Inside a [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) bundle, paths resolved relative to
`__dirname` point into pkg's virtual snapshot filesystem: `fs` reads them, but
`child_process.spawn()` needs a real file. So when `process.pkg` is set, `resolveOleDbBinaryPath()`
extracts the embedded helper to `<tmpdir>/oibus-oledb/<content hash>/OIBusOleDbWindows.exe` and
spawns it from there.

The folder is named after the helper's content: several applications on the same machine (two
OIBus services, for instance) share one extracted copy per helper version, an already extracted copy
is reused as is (Windows forbids replacing an executable while it runs), and a new version goes to
its own folder. A copy is written under a per-process temporary name and renamed into place
(atomic on the same volume), so that no process ever spawns a partially written file.

The consuming application still needs to tell `pkg` to embed the helper. Add the `runtimes/win-x64`
folder to its `pkg.assets`:

```json
"pkg": {
  "assets": ["node_modules/@oibus/oledb/runtimes/win-x64/**/*"]
}
```

## Protocol

Newline-delimited JSON on stdin/stdout, requests/responses correlated by `requestId`. `ok` only ever
appears on `connect`/`disconnect`; `query` responses carry no `ok` at all — `error`'s presence is the
only failure signal. Rows are sent as arrays in column order (the TypeScript side builds the
records). Timeouts are in milliseconds and optional.

```jsonc
{"requestId":"1","command":"connect","id":"<connection-uuid>","connectionString":"Provider=MSOLEDBSQL;Data Source=localhost;Integrated Security=SSPI","connectionTimeout":15000}
{"requestId":"2","command":"query","id":"<connection-uuid>","sql":"SELECT timestamp, value FROM logs","timeout":30000}
{"requestId":"3","command":"disconnect","id":"<connection-uuid>"}
```

Responses:

```jsonc
{"requestId":"1","ok":true,"info":{"provider":"MSOLEDBSQL","dataSource":"localhost","database":"master","serverVersion":"16.00.1000"}}
{"requestId":"2","columns":[{"name":"timestamp","type":"datetime","dataTypeName":"DBTYPE_DBTIMESTAMP"},{"name":"value","type":"number","dataTypeName":"DBTYPE_R8"}],"rows":[["2026-01-01T10:00:00.000",12.5]]}
{"requestId":"3","ok":true}
{"requestId":"4","error":"Query timed out after 30000 ms"}
```

## Development

The TypeScript side builds and its unit tests run on any platform (against a fake child process).
The helper builds on any platform with the .NET 10 SDK (`EnableWindowsTargeting`), but only runs on
Windows; Node/npm versions are pinned in `package.json`'s `engines` field (on Linux/macOS, install
with `npm install --force`, since the package declares `os: ["win32"]`).

```bash
npm install             # dev dependencies (typescript, tsx, @types/node)
npm run build           # tsc -> dist/index.js + dist/index.d.ts
npm test                # src/**/*.spec.ts: unit tests, plus the integration tests on Windows (see below)
dotnet build            # compiles the .NET helper for quick local testing (bin/Debug/net10.0-windows/...)
npm run build:runtimes  # the self-contained single-file helper, into runtimes/win-x64/ (what gets published)
```

To use a `dotnet build` output instead of `runtimes/win-x64/`:

```powershell
$env:OIBUS_OLEDB_WINDOWS_BINARY = "$(pwd)\bin\Debug\net10.0-windows\OIBusOleDbWindows.exe"
```

`src/helper.integration.spec.ts` runs the real helper against a real provider, on Windows only and
when `OIBUS_OLEDB_INTEGRATION_CONNECTION_STRING` is set. The CI points it at the SQL Server LocalDB
instance of GitHub's Windows runners, through the Microsoft OLE DB Driver for SQL Server, both
installed there:

```powershell
sqllocaldb start MSSQLLocalDB
$env:OIBUS_OLEDB_INTEGRATION_CONNECTION_STRING = 'Provider=MSOLEDBSQL;Data Source=(localdb)\MSSQLLocalDB;Integrated Security=SSPI'
npm test
```

To exercise the helper directly without the TypeScript layer, pipe newline-delimited JSON commands
at the built exe (see [Protocol](#protocol)).

## Release

Releases are cut by pushing a `v*` tag (e.g. `v0.1.0`) — see `.github/workflows/publish.yml`. That
workflow, on a Windows runner:

1. `npm run build:runtimes` — runs `build:win-x64` (a plain `dotnet publish -r win-x64
   --self-contained -p:PublishSingleFile=true -o runtimes/win-x64`), so the same command can be run
   locally to reproduce exactly what CI ships.
2. `npm run build` (the TypeScript side), then the unit and integration tests.
3. `npm publish` (scoped public package — `publishConfig.access` in `package.json` is already set
   to `"public"`), through npm Trusted Publishing (OIDC): configure it for this package on
   npmjs.com before the first release.

Bump `version` in `package.json` before tagging — npm will reject a publish that reuses an existing
version. `dist/` and `runtimes/` are gitignored (built fresh by CI at publish time, never committed).
