---
'@kadeya/mqtt-intel-core': patch
'@kadeya/mqtt-intel-mcp': patch
---

Node.js 26 is now a supported runtime, tested as a blocking CI job on Linux, Windows and macOS.

It entered Active LTS on 2026-10-28, which is the moment ADR-0001 promotes a line. Node 22 and
24 remain supported in maintenance LTS until April 2027 and April 2028.

The `engines` ranges already admitted 26 and are unchanged, so nothing about installing either
package changes; what changed is that 26 is now tested and advertised rather than merely
permitted.
