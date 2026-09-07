# Node WhatsApp/Telegram bot — deployed as its OWN Fly app, separate from
# the Python model server (see ../DevCoralz_api/fly.toml or wherever that
# lives). This process holds a persistent WhatsApp WebSocket (Baileys) and
# a Telegram connection — it is NOT a request/response HTTP service, so it
# must run as an always-on machine, not Fly's auto-stop-on-idle-HTTP
# pattern (which doesn't apply here anyway, since there's no HTTP traffic
# to trigger wake/sleep on in the first place).
#
# MUST be Node 22+ (not 20): src/storage/sessionStore.js imports the
# built-in node:sqlite module, which does not exist at all in Node 20 —
# it was only added in Node 22.5.0, and needs 22.13+ to run without the
# --experimental-sqlite flag. Node 20 threw exactly this at boot:
#   Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
# which crash-looped the machine (Fly Doctor: "machines restarting a lot").
# 22-slim is current Node LTS (maintained into 2027), so this isn't a
# stopgap version bump.
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
# npm ci is faster and fully reproducible (exact versions from the
# lockfile) but requires package-lock.json to exist. Falls back to
# npm install if there's no lockfile in the repo yet. Either way, ls
# right after prints the resolved dependency tree into the Fly build
# log so you can confirm packages actually landed, instead of finding
# out at runtime via a missing-module crash.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && echo "--- installed node_modules (top level) ---" \
    && ls node_modules

COPY . .

# NOTE: intentionally NOT creating /data/sessions here. This runs at
# IMAGE BUILD time, before Fly ever attaches the [[mounts]] volume — a
# mkdir here only creates an empty dir inside the image layer, which
# gets shadowed the instant the real volume mounts at /data on boot. It
# looked harmless but implied build-time and run-time filesystems are
# the same, which they aren't; sessionManager.js already does the real
# mkdir (fs.mkdir(..., { recursive: true })) against the live mounted
# path at actual startup, which is the only place it can correctly happen.

CMD ["node", "src/app.js"]
