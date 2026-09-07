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
    && curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
    && dpkg -i /tmp/cloudflared.deb \
    && rm -f /tmp/cloudflared.deb \
    && echo "--- toolchain installed ---" \
    && node --version && python3 --version && git --version && ffmpeg -version | head -1 && wrangler --version && cloudflared --version

WORKDIR /app

COPY package*.json ./
# npm ci is faster and fully reproducible (exact versions from the
# lockfile) but requires package-lock.json to exist. Falls back to
# npm install if there's no lockfile in the repo yet. Either way, `ls`
# right after prints the resolved dependency tree into the Fly build
# log so you can confirm packages actually landed, instead of finding
# out at runtime via a missing-module crash.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && echo "--- installed node_modules (top level) ---" \
    && ls node_modules

RUN chmod +x scripts/*.sh

COPY . .

# NOTE: intentionally NOT creating /data/sessions here. This runs at
# IMAGE BUILD time, before Fly ever attaches the [[mounts]] volume — a
# mkdir here only creates an empty dir inside the image layer, which
# gets shadowed the instant the real volume mounts at /data on boot. It
# looked harmless but implied build-time and run-time filesystems are
# the same, which they aren't; sessionManager.js already does the real
# mkdir (fs.mkdir(..., { recursive: true })) against the live mounted
# path at actual startup, which is the only place it can correctly happen.

CMD ["sh", "-c", "/app/scripts/startup-guard.sh && node src/app.js"]
