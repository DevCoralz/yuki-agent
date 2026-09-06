# Deploying to Fly.io

This project is TWO separate Fly apps, deployed independently:

1. **This repo (`yuki-agent`)** — the Node WhatsApp/Telegram bot.
2. **The model server** (separate repo/folder, e.g. `DevCoralz_api`) —
   the Python FastAPI + llama-cpp-python backend.

They're kept as separate Fly apps deliberately: a model-server crash or
redeploy shouldn't drop the bot's persistent WhatsApp connection, and they
scale/restart independently.

## One-time setup, per app

Run these once, for EACH app (the bot, and separately the model server —
`cd` into each project's own directory first):

```bash
fly launch --no-deploy
# Answer the prompts (app name, region). Say NO to "would you like to
# deploy now" — we need to set up secrets and volumes first.

fly volumes create session_data --size 3 --region <same-region-as-above>
# For the model server instead, use a bigger volume for model files:
#   fly volumes create model_data --size 10 --region <same-region>

cat .env | fly secrets import
# Loads every KEY=value in your local .env as an encrypted Fly secret in
# one shot. Review what actually got imported with `fly secrets list` —
# it lists names only, never values.

fly deploy
```

## Where do environment variables actually go?

Fly has two places, and they're not interchangeable:

- **`fly secrets set KEY=value`** (or the bulk `cat .env | fly secrets
  import` above) — for anything sensitive: `YUKI_API_KEY`,
  `TELEGRAM_BOT_TOKEN`, `YUKI_SYSTEM_PROMPT` if you'd rather not have it
  in a committed file, `CLOUDFLARE_TUNNEL_TOKEN`, etc. Encrypted at rest,
  injected as env vars at boot. Never appears in `fly.toml`, never gets
  committed to git.
- **`fly.toml`'s `[env]` block** — for everything else: ports, non-secret
  tuning values (`YUKI_MAX_TOOL_ROUNDS`, `N_CTX`, etc). This file IS meant
  to be committed to git — never put a real credential in it.

`fly.toml` in this repo already has sensible `[env]` defaults filled in —
you mainly need to run the secrets import step above for the sensitive
values, then adjust `app`, `primary_region`, and `YUKI_API_BASE_URL` (see
below) to match your actual setup.

## Connecting the two apps to each other

Fly apps in the same organization can reach each other over Fly's private
network at `<app-name>.internal`, without going over the public internet.
If both the bot and the model server are Fly apps, set:

```
YUKI_API_BASE_URL=http://<your-model-server-app-name>.internal:8000
```

This is already the default in `fly.toml`'s `[env]` block — update
`yuki-model-server` in that URL to whatever you actually named the model
server app during its own `fly launch`.

## The one thing NOT in fly.toml: restart-on-host-reboot

Per Fly's own team (this isn't currently settable in `fly.toml` — only
per-machine via the CLI), run this once after your first deploy of the
bot specifically, since it has no `[http_service]` block for Fly's proxy
to use as a wake signal:

```bash
fly machine list                          # get the machine ID
fly machine update --restart always <machine-id>
```

Without this, an actual Fly host reboot (rare, but possible) could leave
the bot's machine stopped rather than automatically restarting. The model
server doesn't need this same step since it DOES have an `[http_service]`
block, which already implies restart behavior.

## Checking it actually worked

```bash
fly logs                    # tail logs for whichever app you're in
fly ssh console -C "printenv" | grep -i yuki   # confirm secrets landed
fly status                  # machine state, region, health
```

For the bot specifically, watch the logs for the WhatsApp QR pairing
step on first boot — you'll need to scan it once per phone number, same
as any fresh WhatsApp Web login, and it'll persist afterward on the
mounted volume.
