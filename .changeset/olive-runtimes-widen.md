---
'@kadeya/mqtt-intel-core': patch
'@kadeya/mqtt-intel-mcp': patch
---

Node.js 26 is now a supported runtime, tested as a blocking CI job on Linux, Windows and macOS.

It enters Active LTS on 2026-10-28, five days after this release. ADR-0001 promotes a line
when it enters LTS; promoting it a few days early is deliberate, so that the first published
version advertises the runtime support that holds for the whole of its life rather than a
window that closes the week after. Node 22 and 24 remain supported in maintenance LTS until
April 2027 and April 2028.

The `engines` ranges already admitted 26 and are unchanged, so nothing about installing either
package changes; what changed is that 26 is now tested and advertised rather than merely
permitted.
