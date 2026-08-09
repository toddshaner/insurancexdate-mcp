#!/bin/sh
# Runs pulumi with .env sourced into the CLI environment, so the values reach
# both the program (index.ts) and the provider plugins (AWS, Cloudflare),
# which run as separate processes and never see a dotenv loaded in-program.
#
#   ./up.sh                                     -> pulumi up
#   ./up.sh preview                             -> pulumi preview
#   ./up.sh stack output connectorUrl --show-secrets
set -eu
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo "No .env file - copy .env.example to .env and fill it in." >&2
  exit 1
fi
set -a
. ./.env
set +a
if [ $# -eq 0 ]; then
  set -- up
fi
exec pulumi "$@"
