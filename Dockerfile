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

COPY . .

# SESSION_DATA_PATH points here — a Fly Volume mounted at runtime (see
# fly.toml [[mounts]]) so WhatsApp auth keys and session SQLite databases
# survive machine restarts/redeploys instead of living in the container's
# own ephemeral filesystem, which would force a WhatsApp re-pair on every
# deploy.
RUN mkdir -p /data/sessions

CMD ["node", "src/app.js"]
