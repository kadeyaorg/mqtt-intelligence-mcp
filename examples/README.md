# Examples

```bash
npm install && npm run build
docker compose -f examples/industrial-machine/docker-compose.yml up -d --wait
node packages/mcp-server/dist/cli/bin.js check --config examples/industrial-machine/mqtt-intelligence.yaml
```

That is a broker, a fictional production line publishing to it, and a check that the server
can read it. Three minutes, and nothing touches a real plant.

| Directory                                 | What is in it                                                    |
| ----------------------------------------- | ---------------------------------------------------------------- |
| [industrial-machine](industrial-machine/) | Docker Compose: Mosquitto and a simulated line, with an incident |
| [configs](configs/)                       | Five configurations: one broker, several, TLS, AWS, Azure        |
| [mcp-clients](mcp-clients/)               | Claude Desktop, Claude Code, Cursor, VS Code                     |

Start with [industrial-machine](industrial-machine/README.md): it has four things to try that
show what this server does differently, including a topic the configuration forbids and a
credential it redacts.
