# Third-Party Notices

This package's original source code (`Program.cs`, `src/`, build scripts) is licensed under the
EUPL-1.2 — see [LICENSE](LICENSE). The built Windows binary it publishes
(`OIBusOleDbWindows.exe`, for Windows x64, under `runtimes/win-x64/`) additionally embeds the
third-party components listed below. They are **not** covered by the EUPL-1.2 and remain under
their own licenses, reproduced here.

## OLE DB providers: not included

No OLE DB provider is included in this package or in its binary. The helper only uses the OLE DB
service components that ship with Windows, which load the provider named by the `Provider` keyword
of each connection string (Microsoft OLE DB Driver for SQL Server, Oracle Provider for OLE DB, a
historian's own provider...). Providers are installed separately on the machine, by its owner, and
remain under their own licenses.

## System.Data.OleDb

The helper uses the `System.Data.OleDb` NuGet package (see `OleDbWindows.csproj` for the exact
version) and its dependencies `System.Configuration.ConfigurationManager` and
`System.Diagnostics.PerformanceCounter` (with theirs), all built from the
[dotnet/runtime](https://github.com/dotnet/runtime) repository and licensed under the MIT License
reproduced below, with the third-party notices of the .NET runtime. Because the helper is published
self-contained with `PublishSingleFile=true` (see `package.json`'s `build:win-x64` script), these
managed assemblies are embedded in `OIBusOleDbWindows.exe`. They are used unmodified.

## .NET runtime

The helper is published self-contained, so `OIBusOleDbWindows.exe` embeds the .NET
runtime (`Microsoft.NETCore.App`, .NET 10), licensed under the MIT License:

```text
The MIT License (MIT)

Copyright (c) .NET Foundation and Contributors

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The .NET runtime itself includes third-party components under their own licenses. Their notices
are shipped next to the executable as `runtimes/win-x64/dotnet-runtime-THIRD-PARTY-NOTICES.txt`
(with the license as `dotnet-runtime-LICENSE.txt`), copied at build time from the exact
`Microsoft.NETCore.App` runtime pack embedded in that executable. They are also published at
https://github.com/dotnet/runtime/blob/main/THIRD-PARTY-NOTICES.TXT.
