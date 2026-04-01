<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
    <img alt="CC Gateway" src=".github/logo-light.svg" width="440">
  </picture>

  <p>Take back control of your AI API telemetry</p>
</div>

<div align="center">

[![License: MIT][license-shield]][license-url]
[![Version][version-shield]][version-url]
[![Tests][tests-shield]][tests-url]

</div>

<div align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#client-setup">Client Setup</a> &middot;
  <a href="#what-gets-rewritten">What Gets Rewritten</a> &middot;
  <a href="#clash-rules">Clash Rules</a>
</div>

---

> **Alpha** — This project is under active development. Test with a non-primary account first.

> **Disclaimer** — This software is provided for security research and privacy auditing purposes. It is the user's responsibility to comply with applicable terms of service. The authors assume no liability for misuse.

## Why

Claude Code collects **640+ telemetry event types** across 3 parallel channels, fingerprints your machine with **40+ environment dimensions**, and phones home every 5 seconds. Your device ID, email, OS version, installed runtimes, shell type, CPU architecture, and physical RAM are all reported to the vendor — continuously.

If you run Claude Code on multiple machines, each device gets a unique permanent identifier. There is no built-in way to manage how your identity is presented to the API.

CC Gateway is a reverse proxy that sits between Claude Code and the Anthropic API. It normalizes device identity, environment fingerprints, and process metrics to a single canonical profile — giving you control over what telemetry leaves your network.

## Features

- **Full identity rewrite** — device ID, email, session metadata, and the `user_id` JSON blob in every API request are normalized to one canonical identity
- **40+ environment dimensions replaced** — platform, architecture, Node.js version, terminal, package managers, runtimes, CI flags, deployment environment — the entire `env` object is swapped, not patched
- **System prompt sanitization** — the `<env>` block injected into every prompt (Platform, Shell, OS Version, working directory) is rewritten to match the canonical profile, preventing cross-reference detection between telemetry and prompt content
- **Process metrics normalization** — physical RAM (`constrainedMemory`), heap size, and RSS are masked to canonical values so hardware differences don't leak
- **Centralized OAuth** — the gateway manages token refresh internally; client machines never contact `platform.claude.com` and never need a browser login
- **Telemetry leak prevention** — strips `baseUrl` and `gateway` fields that would reveal proxy usage in analytics events
- **Three-layer defense architecture** — env vars (voluntary routing) + Clash rules (network-level blocking) + gateway rewriting (identity normalization)

## Quick Start

### 1. Install and configure

```bash
git clone https://github.com/motiful/cc-gateway.git
cd cc-gateway
npm install

# Generate canonical identity
npm run generate-identity
# Generate a client token
npm run generate-token my-machine

# Configure
cp config.example.yaml config.yaml
# Edit config.yaml: paste device_id, client token, and OAuth refresh_token
```

### 2. Extract OAuth token (on a machine that has logged into Claude Code)

```bash
bash scripts/extract-token.sh
# Copies refresh_token from macOS Keychain → paste into config.yaml
```

### 3. Start the gateway

```bash
# Development (no TLS)
npm run dev

# Production
npm run build && npm start

# Docker
docker-compose up -d
```

### 4. Verify

```bash
# Health check
curl http://localhost:8443/_health

# Rewrite verification (shows before/after diff)
curl -H "Authorization: <your-token>" http://localhost:8443/_verify
```

## Client Setup

Add these environment variables on each client machine. No browser login needed.

```bash
# Route all Claude Code traffic through the gateway
export ANTHROPIC_BASE_URL="https://gateway.your-domain.com:8443"

# Disable side-channel telemetry (Datadog, GrowthBook, version checks)
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Authenticate to the gateway using Claude Code's native gateway auth path
export ANTHROPIC_AUTH_TOKEN="YOUR_TOKEN"
```

CC Gateway now accepts the client token in any of these headers and strips them before forwarding upstream:

- `Authorization: YOUR_TOKEN` or `Authorization: Bearer YOUR_TOKEN`
- `Proxy-Authorization: YOUR_TOKEN` or `Proxy-Authorization: Bearer YOUR_TOKEN`
- `X-Api-Key: YOUR_TOKEN`

That means it works with:

- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_API_KEY`
- `apiKeyHelper`-based gateway setups that emit `Authorization` / `X-Api-Key`

Or run the interactive setup script:

```bash
bash scripts/client-setup.sh
```

Then start Claude Code normally. If you previously saw `/login` fail with `401 OAuth authentication is currently not supported`, remove the old `CLAUDE_CODE_OAUTH_TOKEN` workaround and use one of the token-based gateway auth methods above instead.

## What Gets Rewritten

| Layer | Field | Action |
|-------|-------|--------|
| **Identity** | `device_id` in metadata + events | → canonical ID |
| | `email` | → canonical email |
| **Environment** | `env` object (40+ fields) | → entire object replaced |
| **Process** | `constrainedMemory` (physical RAM) | → canonical value |
| | `rss`, `heapTotal`, `heapUsed` | → randomized in realistic range |
| **Headers** | `User-Agent` | → canonical CC version |
| | `Authorization` / `Proxy-Authorization` / `X-Api-Key` | → stripped client credential, replaced with gateway-managed OAuth token |
| | `x-anthropic-billing-header` | → canonical fingerprint |
| **Prompt text** | `Platform`, `Shell`, `OS Version` | → canonical values |
| | `Working directory` | → canonical path |
| | `/Users/xxx/`, `/home/xxx/` | → canonical home prefix |
| **Leak fields** | `baseUrl` (ANTHROPIC_BASE_URL) | → stripped |
| | `gateway` (provider detection) | → stripped |

## Clash Rules

Clash acts as a network-level safety net. Even if Claude Code bypasses env vars or adds new hardcoded endpoints in a future update, Clash blocks direct connections.

```yaml
rules:
  - DOMAIN,gateway.your-domain.com,DIRECT    # Allow gateway
  - DOMAIN-SUFFIX,anthropic.com,REJECT        # Block direct API
  - DOMAIN-SUFFIX,claude.com,REJECT           # Block OAuth
  - DOMAIN-SUFFIX,claude.ai,REJECT            # Block OAuth
  - DOMAIN-SUFFIX,datadoghq.com,REJECT        # Block telemetry
```

See [`clash-rules.yaml`](clash-rules.yaml) for the full template.

## Architecture

```
Client machines                        CC Gateway                    Anthropic
┌────────────┐                    ┌──────────────────┐
│  Claude Code │── ANTHROPIC_ ────│  Auth: Bearer     │
│  + env vars  │   BASE_URL       │  OAuth: auto-     │
│  + Clash     │                  │    refresh        │──── single ────▶ api.anthropic.com
│  (blocks     │                  │  Rewrite: all     │     identity
│   direct)    │                  │    identity       │
└────────────┘                    │  Stream: SSE      │
                                  │    passthrough    │
                                  └──────────────────┘
                                         │
                                   platform.claude.com
                                   (token refresh only,
                                    from gateway IP)
```

**Defense in depth:**

| Layer | Mechanism | What it prevents |
|-------|-----------|-----------------|
| Env vars | `ANTHROPIC_BASE_URL` + `DISABLE_NONESSENTIAL` + `ANTHROPIC_AUTH_TOKEN` | CC voluntarily routes to gateway, disables side channels, and uses token-based gateway auth |
| Clash | Domain-based REJECT rules | Any accidental or future direct connections to Anthropic |
| Gateway | Body + header + prompt rewriting | All 40+ fingerprint dimensions normalized to one device |

## Caveats

- **MCP servers** — `mcp-proxy.anthropic.com` is hardcoded and does not follow `ANTHROPIC_BASE_URL`. If clients use official MCP servers, those requests bypass the gateway. Use Clash to block this domain if MCP is not needed.
- **CC updates** — New Claude Code versions may introduce new telemetry fields or endpoints. Monitor Clash REJECT logs for unexpected connection attempts after upgrades.
- **Token lifecycle** — The gateway auto-refreshes the OAuth access token. If the underlying refresh token expires (rare), re-run `extract-token.sh` on the admin machine.

## References

This project builds on:

- [Claude Code 封号机制深度探查报告](https://bytedance.larkoffice.com/docx/E2JudVzf7oCNfhxyxaQcZIW1n0g) — Reverse-engineering analysis of Claude Code's 640+ telemetry events, 40+ fingerprint dimensions, and ban detection mechanisms
- [instructkr/claude-code](https://github.com/instructkr/claude-code) — Deobfuscated Claude Code source used for the telemetry audit

## License

[MIT](LICENSE)

---

<div align="center">
  <sub>Crafted with <a href="https://github.com/anthropics/claude-code">Claude Code</a></sub>
</div>

<!-- Badge references -->
[license-shield]: https://img.shields.io/github/license/motiful/cc-gateway
[license-url]: https://github.com/motiful/cc-gateway/blob/main/LICENSE
[version-shield]: https://img.shields.io/badge/version-0.1.0--alpha-blue
[version-url]: https://github.com/motiful/cc-gateway/releases
[tests-shield]: https://img.shields.io/badge/tests-16%20passed-brightgreen
[tests-url]: https://github.com/motiful/cc-gateway/blob/main/tests/rewriter.test.ts
