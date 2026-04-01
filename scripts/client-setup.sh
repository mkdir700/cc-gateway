#!/bin/bash
# CC Gateway Client Setup
# Run this on each client machine to configure Claude Code to use the gateway.
# Client machines NEVER contact Anthropic directly.

set -e

echo "=== CC Gateway Client Setup ==="
echo ""

read -p "Gateway URL (e.g., https://gateway.office.com:8443): " GATEWAY_URL
read -p "Your gateway token: " GATEWAY_TOKEN

if [[ -z "$GATEWAY_URL" || -z "$GATEWAY_TOKEN" ]]; then
  echo "Error: Gateway URL and token are required."
  exit 1
fi

# Detect shell config file
if [[ -n "$ZSH_VERSION" ]] || [[ "$SHELL" == */zsh ]]; then
  RC_FILE="$HOME/.zshrc"
elif [[ -n "$BASH_VERSION" ]] || [[ "$SHELL" == */bash ]]; then
  RC_FILE="$HOME/.bashrc"
else
  RC_FILE="$HOME/.profile"
fi

ENV_BLOCK="
# === CC Gateway ===
# Route all Claude Code API traffic through the gateway
export ANTHROPIC_BASE_URL=\"$GATEWAY_URL\"
# Disable all side-channel telemetry (Datadog, GrowthBook, updates)
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# Gateway auth token - Claude Code sends this natively as Authorization
export ANTHROPIC_AUTH_TOKEN=\"$GATEWAY_TOKEN\"
# === End CC Gateway ==="

echo ""
echo "Will add to: $RC_FILE"
echo ""
echo "Environment variables:"
echo "  ANTHROPIC_BASE_URL=$GATEWAY_URL"
echo "  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
echo "  ANTHROPIC_AUTH_TOKEN=<token>"
echo ""
echo "Effect:"
echo "  - All API traffic routes through gateway (no direct Anthropic contact)"
echo "  - Claude Code uses token-based gateway auth (no browser login needed)"
echo "  - Gateway injects the real OAuth token upstream"
echo "  - Telemetry side-channels disabled"
echo ""

read -p "Continue? [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  sed -i.bak '/# === CC Gateway ===/,/# === End CC Gateway ===/d' "$RC_FILE" 2>/dev/null || true
  echo "$ENV_BLOCK" >> "$RC_FILE"
  echo ""
  echo "Done! Run: source $RC_FILE"
  echo ""
  echo "Then start Claude Code normally: claude"
  echo "(No /login needed - Claude Code will use ANTHROPIC_AUTH_TOKEN)"
else
  echo "Aborted."
fi
