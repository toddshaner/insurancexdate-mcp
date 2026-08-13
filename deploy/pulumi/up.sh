#!/bin/sh
# Runs pulumi with an env file sourced into the CLI environment, so the
# values reach both the program (index.ts) and the provider plugins (AWS,
# Cloudflare), which run as separate processes and never see a dotenv loaded
# in-program.
#
#   ./up.sh                                     -> pulumi up (with .env)
#   ./up.sh preview                             -> pulumi preview
#   ./up.sh stack output connectorUrl --show-secrets
#   ./up.sh -e .env.byok up                     -> second endpoint/stack
#
# Multiple endpoints (e.g. a private instance and a BYOK instance) live in
# separate env files AND separate MCP_STACK values with distinct
# MCP_SERVICE_NAME values.
set -eu
cd "$(dirname "$0")"
ENV_FILE=.env
if [ "${1:-}" = "-e" ]; then
  ENV_FILE="${2:?usage: ./up.sh [-e envfile] [pulumi args]}"
  shift 2
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE file - copy .env.example and fill it in." >&2
  exit 1
fi
set -a
. "./$ENV_FILE"
set +a
# Pin the env file to its required stack so values from one file cannot land
# in another file's stack through a stale prior selection.
if [ -z "${MCP_STACK:-}" ]; then
  echo "MCP_STACK is required in $ENV_FILE (for example: MCP_STACK=prod)." >&2
  exit 1
fi
pulumi stack select "$MCP_STACK" 2>/dev/null || pulumi stack init "$MCP_STACK"
if [ $# -eq 0 ]; then
  set -- up
fi
exec pulumi "$@"
