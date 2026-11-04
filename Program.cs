using System.Collections.Concurrent;
using System.Data;
using System.Data.OleDb;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json.Nodes;

// A single process shared by every caller of this package's OleDbBridge/OleDbConnection. Each logical
// connection gets its own OleDbConnection, keyed by a UUID `id` — different connections can target
// different providers and databases.
//
// Commands on the same connection id run in the order they arrived (an OleDbConnection runs one
// command at a time), while commands on different ids run concurrently. Every request/response
// carries a `requestId` for out-of-order correlation.
//
// stdin/stdout are read and written as UTF-8 explicitly: the console code page (often an OEM one on
// Windows) would otherwise garble non-ASCII characters of SQL queries and connection strings.
const long MaxSafeInteger = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER on the JavaScript side

var connections = new ConcurrentDictionary<string, OleDbConnection>();
var lastOperationByConnection = new ConcurrentDictionary<string, Task>();
var stdoutLock = new object();
var utf8 = new UTF8Encoding(false);
using var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
using var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8);

string? line;
while ((line = stdin.ReadLine()) != null)
{
    if (line.Length == 0)
    {
        continue;
    }
    ScheduleLine(line);
}

// Drain everything currently chained per connection before actually exiting — a short-lived piped
// run could otherwise hit stdin EOF and return before its own dispatched work executed.
await Task.WhenAll(lastOperationByConnection.Values.ToArray());
foreach (var connection in connections.Values)
{
    connection.Dispose();
}
return 0;

void ScheduleLine(string rawLine)
{
    JsonObject request;
    string? requestId;
    string id;
    try
    {
        request = JsonNode.Parse(rawLine)!.AsObject();
        requestId = request["requestId"]?.GetValue<string>();
        id = request["id"]?.GetValue<string>() ?? "";
    }
    catch (Exception ex)
    {
        WriteResponse(Failure(ex), null);
        return;
    }

    lastOperationByConnection.AddOrUpdate(
        id,
        _ => Task.Run(() => ProcessRequest(request, requestId)),
        (_, previous) => previous.ContinueWith(_ => ProcessRequest(request, requestId), TaskScheduler.Default)
    );
}

void ProcessRequest(JsonObject request, string? requestId)
{
    JsonObject response;
    try
    {
        var command = request["command"]?.GetValue<string>();
        var id = request["id"]?.GetValue<string>() ?? "";
        response = command switch
        {
            "connect" => HandleConnect(id, request),
            "query" => HandleQuery(id, request),
            "disconnect" => HandleDisconnect(id),
            _ => new JsonObject { ["error"] = $"Unknown command '{command}'" }
        };
    }
    catch (Exception ex)
    {
        response = Failure(ex);
    }
    WriteResponse(response, requestId);
}

void WriteResponse(JsonObject response, string? requestId)
{
    if (requestId != null)
    {
        response["requestId"] = requestId;
    }
    // The default encoder escapes every non-ASCII character, so each response stays on one ASCII line.
    var json = response.ToJsonString();
    lock (stdoutLock)
    {
        stdout.WriteLine(json);
        stdout.Flush();
    }
}

// OLE DB and timeout errors carry a meaningful message on their own (the provider's error text);
// anything else is prefixed with its type, which usually tells more than its message alone.
JsonObject Failure(Exception ex)
{
    var message = ex is OleDbException or TimeoutException ? ex.Message : $"{ex.GetType().Name}: {ex.Message}";
    return new JsonObject { ["error"] = message };
}

// Idempotent: an open connection is kept as is. A connection that is no longer open (a network
// failure closed it) is dropped and opened again from the new connection string. A connection that
// fails to open is never kept, so the next attempt starts from scratch.
JsonObject HandleConnect(string id, JsonObject request)
{
    var connectionString = request["connectionString"]!.GetValue<string>();
    var connectionTimeout = GetOptionalMilliseconds(request, "connectionTimeout");

    if (connections.TryGetValue(id, out var existing))
    {
        if (existing.State == ConnectionState.Open)
        {
            return Connected(existing);
        }
        connections.TryRemove(id, out _);
        existing.Dispose();
    }

    var connection = OpenConnection(connectionString, connectionTimeout);
    connections[id] = connection;
    return Connected(connection);
}

// OleDbConnection.ConnectionTimeout is read-only and provider-specific (a `Connect Timeout` keyword
// that not every provider honours), so the timeout is enforced here: on expiry the caller gets an
// error right away, and the connection is disposed whenever the provider gives up on its own.
OleDbConnection OpenConnection(string connectionString, int timeoutMs)
{
    var connection = new OleDbConnection(connectionString);
    var open = Task.Run(connection.Open);
    try
    {
        if (timeoutMs > 0 && !open.Wait(timeoutMs))
        {
            open.ContinueWith(_ => connection.Dispose(), TaskScheduler.Default);
            throw new TimeoutException($"Connection timed out after {timeoutMs} ms");
        }
        open.Wait();
        return connection;
    }
    catch (AggregateException ex)
    {
        connection.Dispose();
        ExceptionDispatchInfo.Capture(ex.InnerException ?? ex).Throw();
        throw; // unreachable
    }
}

// Provider, data source, database and server version of an open connection, for a connection test.
// The server version is not available from every provider.
JsonObject Connected(OleDbConnection connection)
{
    string serverVersion;
    try
    {
        serverVersion = connection.ServerVersion;
    }
    catch (Exception)
    {
        serverVersion = "";
    }
    return new JsonObject
    {
        ["ok"] = true,
        ["info"] = new JsonObject
        {
            ["provider"] = connection.Provider,
            ["dataSource"] = connection.DataSource,
            ["database"] = connection.Database,
            ["serverVersion"] = serverVersion
        }
    };
}

// Runs the SQL text and returns the first result set: its columns (name, type category, provider
// type name) and its rows as arrays of JSON values, in column order. A statement returning no result
// set gives no column and no row.
//
// The timeout is enforced twice: OleDbCommand.CommandTimeout (in seconds, applied by the provider
// when it supports it) and a cancellation of the command after `timeout` ms, also checked between
// rows while reading a large result set.
JsonObject HandleQuery(string id, JsonObject request)
{
    if (!connections.TryGetValue(id, out var connection))
    {
        return new JsonObject { ["error"] = "Not connected" };
    }
    var sql = request["sql"]!.GetValue<string>();
    var timeoutMs = GetOptionalMilliseconds(request, "timeout");

    using var command = new OleDbCommand(sql, connection);
    using var cancellation = new CancellationTokenSource();
    if (timeoutMs > 0)
    {
        command.CommandTimeout = (int)Math.Ceiling(timeoutMs / 1000.0);
        cancellation.CancelAfter(timeoutMs);
    }
    using var registration = cancellation.Token.Register(() =>
    {
        try
        {
            command.Cancel();
        }
        catch (Exception)
        {
            // Best-effort: the provider may not support cancellation
        }
    });

    try
    {
        using var reader = command.ExecuteReader();
        var columns = new JsonArray();
        for (var ordinal = 0; ordinal < reader.FieldCount; ordinal++)
        {
            var name = reader.GetName(ordinal);
            columns.Add(new JsonObject
            {
                // Unnamed columns (`SELECT COUNT(*)` with some providers) are named by their position
                ["name"] = string.IsNullOrEmpty(name) ? $"Column{ordinal + 1}" : name,
                ["type"] = ColumnType(reader.GetFieldType(ordinal)),
                ["dataTypeName"] = reader.GetDataTypeName(ordinal)
            });
        }

        var rows = new JsonArray();
        while (reader.Read())
        {
            cancellation.Token.ThrowIfCancellationRequested();
            var row = new JsonArray();
            for (var ordinal = 0; ordinal < reader.FieldCount; ordinal++)
            {
                row.Add(ReadValue(reader, ordinal));
            }
            rows.Add(row);
        }
        return new JsonObject { ["columns"] = columns, ["rows"] = rows };
    }
    catch (Exception) when (cancellation.IsCancellationRequested)
    {
        throw new TimeoutException($"Query timed out after {timeoutMs} ms");
    }
}

// A value the provider cannot convert to a .NET type is returned as null rather than failing the
// whole query, as the OIBus Agent did.
JsonNode? ReadValue(OleDbDataReader reader, int ordinal)
{
    try
    {
        return reader.IsDBNull(ordinal) ? null : ToJson(reader.GetValue(ordinal));
    }
    catch (Exception ex) when (ex is InvalidCastException or OverflowException or FormatException or NotSupportedException)
    {
        return null;
    }
}

JsonObject HandleDisconnect(string id)
{
    if (connections.TryRemove(id, out var connection))
    {
        connection.Dispose();
    }
    return new JsonObject { ["ok"] = true };
}

static int GetOptionalMilliseconds(JsonObject request, string key)
{
    var node = request[key];
    return node == null ? 0 : (int)Math.Max(0, Math.Min(int.MaxValue, node.GetValue<double>()));
}

static string ColumnType(Type type)
{
    if (type == typeof(DateTimeOffset))
    {
        return "datetimeoffset";
    }
    if (type == typeof(byte[]))
    {
        return "binary";
    }
    return Type.GetTypeCode(type) switch
    {
        TypeCode.String or TypeCode.Char => "string",
        TypeCode.Boolean => "boolean",
        TypeCode.SByte or TypeCode.Byte or TypeCode.Int16 or TypeCode.UInt16 or TypeCode.Int32 or TypeCode.UInt32
            or TypeCode.Int64 or TypeCode.UInt64 or TypeCode.Single or TypeCode.Double or TypeCode.Decimal => "number",
        TypeCode.DateTime => "datetime",
        _ => "other"
    };
}

// JSON representation of a column value:
// - numbers as JSON numbers, except 64-bit integers beyond JavaScript's safe range and non-finite
//   floating-point values, sent as strings so that no digit is silently lost;
// - DateTime as an ISO 8601 string with milliseconds, without offset (OLE DB timestamps carry no
//   time zone: interpreting them is the caller's job), DateTimeOffset with its offset;
// - binary data in base64, anything else as its invariant-culture string.
static JsonNode? ToJson(object? value)
{
    var invariant = CultureInfo.InvariantCulture;
    return value switch
    {
        null or DBNull => null,
        string text => JsonValue.Create(text),
        bool boolean => JsonValue.Create(boolean),
        sbyte or byte or short or ushort or int or uint => JsonValue.Create(Convert.ToInt64(value, invariant)),
        long number => number >= -MaxSafeInteger && number <= MaxSafeInteger
            ? JsonValue.Create(number)
            : JsonValue.Create(number.ToString(invariant)),
        ulong number => number <= MaxSafeInteger ? JsonValue.Create(number) : JsonValue.Create(number.ToString(invariant)),
        float number => float.IsFinite(number) ? JsonValue.Create(number) : JsonValue.Create(number.ToString(invariant)),
        double number => double.IsFinite(number) ? JsonValue.Create(number) : JsonValue.Create(number.ToString(invariant)),
        decimal number => JsonValue.Create(number),
        DateTime dateTime => JsonValue.Create(dateTime.ToString(
            dateTime.Kind switch
            {
                DateTimeKind.Utc => "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                DateTimeKind.Local => "yyyy-MM-dd'T'HH:mm:ss.fffzzz",
                _ => "yyyy-MM-dd'T'HH:mm:ss.fff"
            },
            invariant
        )),
        DateTimeOffset dateTimeOffset => JsonValue.Create(dateTimeOffset.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", invariant)),
        TimeSpan timeSpan => JsonValue.Create(timeSpan.ToString("c", invariant)),
        byte[] bytes => JsonValue.Create(Convert.ToBase64String(bytes)),
        _ => JsonValue.Create(Convert.ToString(value, invariant))
    };
}
