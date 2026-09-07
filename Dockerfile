# Node WhatsApp/Telegram bot — deployed as its OWN Fly app, separate from
# the Python model server (see ../DevCoralz_api/fly.toml or wherever that
# lives). This process holds a persistent WhatsApp WebSocket (Baileys) and
# a Telegram connection — it is NOT a request/response HTTP service, so it
# must run as an always-on machine, not Fly's auto-stop-on-idle-HTTP
# pattern (which doesn't apply here anyway, since there's no HTTP traffic
# to trigger wake/sleep on in the first place).
#
# MUST be Node 22+ (not 20): src/storage/sessionStore.js imports the
# built-in `node:sqlite` module, which does not exist at all in Node 20 —
# it was only added in Node 22.5.0, and needs 22.13+ to run without the
# --experimental-sqlite flag. Node 20 threw exactly this at boot:
#   Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
# which crash-looped the machine (Fly Doctor: "machines restarting a lot").
# 22-slim is current Node LTS (maintained into 2027), so this isn't a
# stopgap version bump.
FROM node:22-slim

# --- Dev + defensive-security toolchain -------------------------------
# Baked into the image (not installed at runtime via run_command) so it
# survives restarts/redeploys and doesn't cost boot time or need network
# access on every cold start. Scope, by explicit choice:
#   - full-stack dev: compilers, Python, common languages, git, build
#     tools, ffmpeg, image libs, DB clients, curl/wget/jq (git clone and
#     arbitrary downloads both already work via these + run_command)
#   - deploy/infra tooling: wrangler (Cloudflare Workers/Pages CLI —
#     deploy, publish, manage from chat) and cloudflared (tunnels)
#   - defensive/analysis security tooling: nmap (for scanning YOUR OWN
#     infra), openssl, hashing utilities, dependency-vulnerability
#     scanners (npm audit is built into npm; pip-audit added below)
# Deliberately EXCLUDED: exploit frameworks, credential-dumping tools,
# and offensive scanners aimed at third-party targets (metasploit,
# sqlmap, hydra, etc.) — this bot accepts commands from anyone who can
# register a Telegram/WhatsApp chat, and run_command already has
# unrestricted shell access within its workspace (see commandScreen.js).
# Baking attacker tooling into that combination is a real risk, not a
# hypothetical one, regardless of the operator's own intentions.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # --- core build & VCS ---
    build-essential git curl wget jq unzip zip ca-certificates gnupg \
    # --- Python ---
    python3 python3-pip python3-venv \
    # --- media / image processing (also backs the image-analysis tool) ---
    ffmpeg libvips-dev \
    # --- networking / inspection (defensive use: your own infra only) ---
    nmap netcat-openbsd dnsutils iputils-ping traceroute whois \
    # --- crypto / hashing ---
    openssl \
    # --- DB clients ---
    postgresql-client sqlite3 default-mysql-client \
    # --- misc useful CLI ---
    less vim-tiny \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir pip-audit \
    && npm install -g pnpm yarn typescript tsx wrangler \
    # Install cloudflared based on architecture
    && ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
      curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb; \
    elif [ "$ARCH" = "arm64" ]; then \
      curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb; \
    else \
      echo "Unsupported architecture: $ARCH" && exit 1; \
    fi && \
    dpkg -i /tmp/cloudflared.deb \
    && rm -f /tmp/cloudflared.deb \
    && echo "--- toolchain installed ---" \
    && node --version && python3 --version && git --version && ffmpeg -version | head -1 && wrangler --version && cloudflared --version

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Generate package-lock.json if missing, then use npm ci for reproducible installs
RUN npm install --package-lock-only 2>/dev/null || npm install --package-lock-only \
    && npm ci --omit=dev \
    && echo "--- installed node_modules (top level) ---" \
    && ls node_modules

# Copy the rest of the application
COPY . .

# Create a non-root user for security
RUN groupadd -r nodeuser && useradd -r -g nodeuser -d /app -s /sbin/nologin nodeuser \
    && chown -R nodeuser:nodeuser /app \
    && mkdir -p /data/whatsapp-auth /data/sessions \
    && chown -R nodeuser:nodeuser /data

# Switch to non-root user
USER nodeuser

# NOTE: intentionally NOT creating /data/sessions here. This runs at
# IMAGE BUILD time, before Fly ever attaches the [[mounts]] volume — a
# mkdir here only creates an empty dir inside the image layer, which
# gets shadowed the instant the real volume mounts at /data on boot. It
# looked harmless but implied build-time and run-time filesystems are
# the same, which they aren't; sessionManager.js already does the real
# mkdir (fs.mkdir(..., { recursive: true })) against the live mounted
# path at actual startup, which is the only place it can correctly happen.

# Healthcheck — verifies the app entry point exists and is parseable
# Uses ESM syntax since the project has "type": "module" in package.json.
# We use --check to verify syntax without executing the module (which would
# hang waiting for Telegram/WhatsApp connections).
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node --check /app/src/app.js || exit 1

CMD ["node", "src/app.js"]
