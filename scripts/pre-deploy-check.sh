#!/bin/bash
# Pre-deploy check: ensure the Fly volume exists before deploying
# Run this before `fly deploy` to prevent data loss

set -e

APP_NAME="${1:-yuki-agent-bot}"
REGION="${2:-iad}"

echo "=== Checking Fly volume for $APP_NAME ==="

# Check if volume exists
VOLUME=$(fly volumes list --app "$APP_NAME" --json 2>/dev/null | grep -o '"name":"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"' || true)

if [ -z "$VOLUME" ]; then
    echo "❌ Volume 'session_data' not found. Creating it now..."
    fly volumes create session_data --size 3 --region "$REGION" --app "$APP_NAME"
    echo "✅ Volume created: session_data"
else
    echo "✅ Volume 'session_data' already exists"
fi

echo "=== Ready to deploy ==="
