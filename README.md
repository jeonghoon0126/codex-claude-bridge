# Codex Bridge

### Make Claude Code and OpenAI Codex talk to each other — across multiple rooms.

Run multiple Codex ↔ Claude pairs simultaneously, each isolated by ticket number.  
One `covering-bridge` command manages all rooms from a single terminal.

![Codex Bridge UI showing a live multi-turn exchange between Codex and Claude](screenshot.png)

---

## Overview

```
Room ENG-1234:  Codex-A  ↔  Claude-A   (feature A)
Room ENG-5678:  Codex-B  ↔  Claude-B   (feature B)
Room ENG-9999:  Codex-C  ↔  Claude-C   (feature C)
```

Each room is completely isolated — messages never cross between rooms.  
A single central `bridge-server` handles routing. The `covering-bridge` CLI opens new rooms on demand.

<p align="center">
  <img src="architecture.svg" alt="Codex Bridge architecture diagram" width="800"/>
</p>

---

## What you need

- [Bun](https://bun.sh) — `bun --version` to check, install from bun.sh
- [Claude Code](https://code.claude.com) v2.1.80+
- [Codex CLI](https://github.com/openai/codex) with an OpenAI API key

---

## Installation

```bash
git clone <your-fork-url>
cd codex-claude-bridge
bun install
```

---

## Setup

### 1. Register Claude-side MCP

Add to `~/.mcp.json` (create if missing):

```json
{
  "mcpServers": {
    "codex-bridge": {
      "type": "stdio",
      "command": "bun",
      "args": ["/full/path/to/codex-claude-bridge/claude-mcp.ts"]
    }
  }
}
```

> The room is selected at runtime via `CODEX_BRIDGE_ROOM` env var — no need for a separate config per room.

### 2. Register Codex-side MCP

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.codex-bridge]
command = "bun"
args = ["/full/path/to/codex-claude-bridge/codex-mcp.ts"]
tool_timeout_sec = 3600
```

`tool_timeout_sec = 3600` is required — `send_to_claude` can wait up to 60 minutes for Claude's reply.

---

## Running rooms

### Option A — covering-bridge CLI (recommended)

```bash
bun covering-bridge.ts
```

This opens an interactive terminal UI:

```
  Codex–Claude Bridge  v0.3 multi-room
  http://localhost:8788

  ENG-1234   claude ✓  codex ✓   12m ago
  ENG-5678   claude ✓  codex ✗    3m ago

  [o] open new room   [c] close room   [r] refresh   [q] quit

  > o
  Ticket number (e.g. ENG-1234): ENG-9999

  Opening room ENG-9999...
  ✓ tmux window opened (claude left, codex right)
```

The bridge server starts automatically if not already running.  
Rooms stay open until you explicitly close them with `[c]`.

**Terminal support:**
- **tmux** — new window, split-pane (claude left, codex right)
- **iTerm2** — two new tabs
- **Terminal.app** — two new windows
- **Fallback** — prints commands to run manually

### Option B — manual per-room launch

Start the central server once:

```bash
bun bridge-server.ts
```

Then for each room, open two terminals:

```bash
# Terminal 1 — Claude
CODEX_BRIDGE_ROOM=ENG-1234 claude --dangerously-load-development-channels server:codex-bridge

# Terminal 2 — Codex
CODEX_BRIDGE_ROOM=ENG-1234 codex --full-auto
```

Repeat with a different `CODEX_BRIDGE_ROOM` value for each additional room.

---

## Web UI

Open [http://localhost:8788](http://localhost:8788) to watch all rooms in real time.

- Use the **room selector** dropdown to switch between active rooms
- **Purple bubbles** (left) = Claude
- **Green bubbles** (right) = Codex
- **Gray bubbles** = you (human observer via the text box)

---

## Starting a conversation

From inside a Codex session, tell it:

```
Use the send_to_claude tool to discuss whether we should use Redis or Memcached for caching.
Keep going until you reach a decision.
```

Codex calls `send_to_claude()` → bridge pushes to Claude → Claude replies → bridge returns to Codex.  
Codex keeps calling `send_to_claude()` until consensus is reached.

---

## Files

```
bridge-server.ts    Central HTTP server. Manages all rooms. Run once.
claude-mcp.ts       Claude-side MCP relay. One instance per room (CODEX_BRIDGE_ROOM).
codex-mcp.ts        Codex-side MCP server. One instance per room (CODEX_BRIDGE_ROOM).
covering-bridge.ts  Interactive CLI. Manages rooms, opens terminals automatically.
```

Legacy `server.ts` is kept for reference — it combined the HTTP server and Claude MCP in one process (single-room only).

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_BRIDGE_ROOM` | *(required)* | Room ID — use your ticket number e.g. `ENG-1234` |
| `CODEX_BRIDGE_URL` | `http://localhost:8788` | Bridge server URL |
| `CODEX_BRIDGE_PORT` | `8788` | Bridge server port |

---

## npm scripts

```bash
bun run bridge       # covering-bridge CLI (room manager)
bun run server       # bridge-server (central HTTP server)
bun run web          # Phone browser -> Codex app-server bridge
bun run web:tunnel   # Create a temporary public URL and run phone browser bridge
bun run web:vpn      # Run phone browser bridge on the Tailscale/VPN interface
bun run web:cf:setup # Create Cloudflare named tunnel config and DNS route
bun run web:cloudflare # Run the Cloudflare Access hardened web bridge
bun run sms          # Twilio SMS -> Codex app-server bridge
bun run sms:tunnel   # Create a temporary public URL and run SMS bridge
bun run sms:configure # Point the Twilio number at CODEX_SMS_PUBLIC_URL
bun run claude-mcp   # claude-mcp.ts (set CODEX_BRIDGE_ROOM first)
bun run codex-mcp    # codex-mcp.ts (set CODEX_BRIDGE_ROOM first)
```

---

## Mobile Web to Codex

`codex-mobile-web.ts` exposes a token-protected phone browser UI for Codex app-server.
It supports prompt input, live agent output, one active Codex thread, and YES/NO approval buttons.

Run:

```bash
bun run web:tunnel
```

Open the printed `Mobile Codex URL` on the phone. The URL includes a random `token` query parameter.

For VPN-only access, install and enable Tailscale on the Mac and phone, then run:

```bash
bun run web:vpn
```

Open the printed `Mobile Codex VPN URL` while the phone VPN is connected. This avoids exposing a public Cloudflare tunnel.

Optional environment:

```text
CODEX_WEB_PORT=8791
CODEX_WEB_HOST=127.0.0.1
CODEX_WEB_TOKEN=long-random-token
CODEX_WEB_PIN=123456
CODEX_WEB_CWD=/Users/wjh
CODEX_WEB_MODEL=gpt-5.5
CODEX_WEB_HOSTNAME=codex.example.com
CODEX_WEB_TUNNEL_NAME=codex-mobile-web
CODEX_WEB_IDLE_TIMEOUT_MS=1800000
CODEX_WEB_ABSOLUTE_TIMEOUT_MS=28800000
CODEX_WEB_REQUIRE_CF_ACCESS=true
CODEX_WEB_ALLOWED_CF_EMAILS=you@example.com
CODEX_WEB_ALLOWED_CLIENT_CIDRS=203.0.113.10/32,203.0.113.0/24,2001:db8:1234::/48
```

Security defaults:

- The token link is only used to bootstrap a browser session; APIs require an HttpOnly cookie.
- Login requires `CODEX_WEB_PIN`; approvals require re-entering the PIN.
- State-changing APIs require a CSRF token and are rate-limited.
- Sessions expire after idle and absolute timeouts.
- `/health` is also kept behind the configured Cloudflare/IP policy and only returns a minimal status.
- Prompt, input, approval, login, logout, and expiry events are written to `~/.codex-mobile-web/audit.jsonl`.

Recommended hardened flow:

```text
phone browser
  -> Cloudflare Access app on a fixed domain
  -> Google login policy
  -> company VPN egress IP policy
  -> cloudflared named tunnel
  -> local Codex web app
```

When using Cloudflare Access, set `CODEX_WEB_REQUIRE_CF_ACCESS=true`, restrict `CODEX_WEB_ALLOWED_CF_EMAILS`, and set `CODEX_WEB_ALLOWED_CLIENT_CIDRS` to the company VPN public egress CIDR. IPv4 and IPv6 CIDRs are supported. The local app checks Cloudflare Access headers again before allowing token/PIN login.

After a domain is connected to Cloudflare:

```bash
cloudflared tunnel login
bun run web:cf:setup codex.example.com
bun run web:cloudflare
```

In Cloudflare Zero Trust, create a Self-hosted Access application for the same hostname and add policies for Google login plus the company VPN egress IP range.

---

## SMS to Codex

`twilio-codex-sms.ts` lets an allowlisted phone send prompts into Codex app-server.
It starts Codex app-server over stdio, keeps one Codex thread per phone number, and sends final results back by SMS.

Run:

```bash
cp sms.env.example .env.sms
bun run sms:tunnel
bun run sms:configure
```

Twilio webhook:

```text
POST https://your-domain.example.com/twilio/sms
```

SMS controls:

```text
/status  current session state
/new     start a fresh Codex thread
YES      approve a pending command or file change
NO       decline a pending command or file change
```

Security defaults:

- `CODEX_SMS_ALLOWED_FROM` is required. Any other sender gets a rejection message.
- Twilio request signatures are checked unless `CODEX_SMS_SKIP_TWILIO_SIGNATURE=true`.
- Outbound SMS uses Twilio REST credentials. With missing credentials, replies are logged instead of sent.

---

## How it works

```
Codex  →  codex-mcp.ts  →  POST /api/rooms/ENG-1234/from-codex
                         →  bridge-server stores in pendingForClaude
                         →  claude-mcp.ts long-polls pending-for-claude
                         →  mcp.notification() → Claude sees message
                         →  Claude calls reply tool
                         →  claude-mcp.ts  →  POST /api/rooms/ENG-1234/from-claude
                         →  bridge-server resolves Codex's waiting poll
Codex  ←  send_to_claude() returns Claude's reply
```

Each room has its own isolated state: pending replies, in-flight deduplication, and message queues never touch other rooms.

---

## Known limitations

- Claude → Codex is still queue-based: Claude-initiated messages wait until Codex polls. Codex-initiated turns are the real-time path.
- Both agents must be on the same machine (localhost bridge).
- `--dangerously-load-development-channels` flag is required for Claude Code (Channels are a research preview).
- Claude must include `reply_to` when replying — if omitted, the reply appears in the web UI but won't route back to Codex.

---

## License

MIT
