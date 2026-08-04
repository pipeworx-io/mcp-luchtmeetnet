# mcp-luchtmeetnet

Luchtmeetnet MCP — official Netherlands air quality (RIVM Luchtmeetnet, api.luchtmeetnet.nl)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Luchtmeetnet data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
