# Node WhatsApp/Telegram bot — deployed as its OWN Fly app, separate from
# the Python model server (see ../DevCoralz_api/fly.toml or wherever that
# lives). This process holds a persistent WhatsApp WebSocket (Baileys) and
# a Telegram connection — it is NOT a request/response HTTP service, so it
# must run as an always-on machine, not Fly's auto-stop-on-idle-HTTP
# pattern (which doesn't apply here anyway, since there's no HTTP traffic
# to trigger wake/sleep on in the first place).
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# SESSION_DATA_PATH points here — a Fly Volume mounted at runtime (see
# fly.toml [[mounts]]) so WhatsApp auth keys and session SQLite databases
# survive machine restarts/redeploys instead of living in the container's
# own ephemeral filesystem, which would force a WhatsApp re-pair on every
# deploy.
RUN mkdir -p /data/sessions

CMD ["node", "src/app.js"]
