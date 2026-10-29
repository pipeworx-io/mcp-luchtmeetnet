# mcp-luchtmeetnet

Luchtmeetnet MCP — official Netherlands air quality (RIVM Luchtmeetnet, api.luchtmeetnet.nl)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | Description |
|------|-------------|
| `luchtmeetnet_stations` | List and search official Netherlands air quality measuring stations (RIVM Luchtmeetnet). Filter by place or station name (Amsterdam, Rotterdam, Utrecht, Den Haag...), or pass latitude/longitude to get the nearest stations with distance. Returns station number (e.g. "NL49012"), location, and coordinates — the station number feeds luchtmeetnet_measurements and luchtmeetnet_air_quality_index. Example: luchtmeetnet_stations({ search: "Amsterdam" }) |
| `luchtmeetnet_measurements` | Get recent air pollution measurements from a Netherlands (RIVM Luchtmeetnet) measuring station: NO2, PM10, PM2.5 (PM25), ozone (O3), SO2, CO and more, hourly values in µg/m³. Station can be an NL number ("NL49012") or a Dutch place name ("Amsterdam", "Rotterdam") — the first matching station is used. Example: luchtmeetnet_measurements({ station: "Amsterdam", pollutant: "NO2", hours: 6 }) |
| `luchtmeetnet_air_quality_index` | Get the official Dutch air quality index (LKI, Luchtkwaliteitsindex) for a Netherlands station or place — a 1-11 scale computed by RIVM from PM10, ozone and NO2: 1-3 good (goed), 4-6 moderate (matig), 7-8 poor (onvoldoende), 9-10 bad (slecht), 11 very bad (zeer slecht). Answers "how is the air quality in Amsterdam right now". Example: luchtmeetnet_air_quality_index({ station: "Rotterdam" }) |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "luchtmeetnet": {
      "url": "https://gateway.pipeworx.io/luchtmeetnet/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/luchtmeetnet/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/luchtmeetnet_stations \
  -H 'Content-Type: application/json' \
  -d '{"search":"Amsterdam"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/luchtmeetnet_stations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-luchtmeetnet` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/luchtmeetnet/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "luchtmeetnet": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-luchtmeetnet"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Luchtmeetnet data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
