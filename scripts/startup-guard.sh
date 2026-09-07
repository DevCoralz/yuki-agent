#!/bin/bash
# Startup guard: fails fast with clear instructions if volume is missing
# Called from Dockerfile entrypoint before running the app

set -e

DATA_DIR="/data"

echo "=== Checking persistent storage ==="

if [ ! -d "$DATA_DIR" ]; then
    echo "❌ FATAL: Volume not mounted at $DATA_DIR"
    echo ""
    echo "This usually means:"
    echo "  1. The Fly volume 'session_data' was not created"
    echo "  2. The volume is in a different region than your app"
    echo ""
    echo "Fix:"
    echo "  fly volumes create session_data --size 3 --region <your-region>"
    echo "  fly deploy"
    echo ""
    exit 1
fi

if [ ! -d "$DATA_DIR/sessions" ]; then
    echo "⚠️  Fresh install: no existing sessions found"
    echo "   This is normal for first deploy"
fi

echo "✅ Volume mounted at $DATA_DIR"
echo "   Contents: $(ls -la "$DATA_DIR" 2>/dev/null | wc -l | tr -d ' ') items"
