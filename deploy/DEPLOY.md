# Loop OS — deployment runbook

Target: `player.loopplayer.com.br`, Debian VPS, Docker + nginx already installed.

**This box is shared with other production stacks** (gestão-cirúrgica, Supabase, ERPNext,
Evolution API, n8n, loop-os). Everything below is scoped to Loop OS: its own directory, its
own container name, its own nginx site. Nothing here touches another stack, and the compose
file caps CPU/memory so a video transcode cannot starve the neighbours.

---

## 1. Get the code

```bash
mkdir -p /opt/loop-os && cd /opt/loop-os
git clone https://github.com/vitoralves2003/screentinker.git .
git checkout feat/loop-os-saas
```

## 2. Configure

```bash
cp deploy/env.production.template .env
chmod 600 .env

# Generate the two secrets and write them in:
openssl rand -hex 64   # -> JWT_SECRET
openssl rand -hex 32   # -> ASAAS_WEBHOOK_TOKEN
```

Then edit `.env` and paste your Asaas **sandbox** key into `ASAAS_API_KEY`.
Leaving it empty is a valid state: screens work, they just are not re-priced.

## 3. Build and start

```bash
cd /opt/loop-os
docker compose -f docker-compose.prod.yml up -d --build
```

First boot runs the schema migrations, so give it ~40s before expecting a healthy
container. Watch it come up:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

Expect to see, in order: the migration lines, `[MEDIA] ffmpeg/ffprobe found`, the plan seed,
and `[lottery] megasena concurso NNNN`.

## 4. Verify the container before exposing it

```bash
curl -s localhost:3010/api/status | head -c 200      # must answer
docker compose -f docker-compose.prod.yml ps         # must say (healthy)
```

## 5. Publish it

```bash
cp deploy/nginx-player.loopplayer.com.br.conf \
   /etc/nginx/sites-available/player.loopplayer.com.br
ln -sf /etc/nginx/sites-available/player.loopplayer.com.br /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

`nginx -t` must pass before the reload. If it fails, the reload is skipped and the currently
running config — serving the other stacks — is untouched.

## 6. Register the first account

Open <https://player.loopplayer.com.br> and sign up. The first account becomes
`platform_admin` automatically.

## 7. Grant yourself the top plan

Every signup — including the first — lands on a 14-day **Premium** trial. As the platform
admin you want Corporativo (layouts + no screen ceiling). From the browser console while
logged in:

```js
await (await fetch('/api/subscription/assign', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json',
             Authorization: 'Bearer ' + localStorage.getItem('rd_token') },
  body: JSON.stringify({ user_id: 'YOUR_USER_ID', plan_id: 'corporate' }),
})).json();
```

Your user id is in the `/api/auth/me` response.

## 8. Point Asaas at the webhook

Asaas panel > Integrações > Webhooks:

- URL: `https://player.loopplayer.com.br/api/asaas/webhook`
- Token: the `ASAAS_WEBHOOK_TOKEN` from `.env`
- Events: `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`

Deliveries are deduplicated server-side, so Asaas retrying is harmless.

---

## Smoke test — the four phases end to end

1. **Compression.** Upload a >1080p photo and a large video. The photo shrinks immediately
   (check `file_size` in the content list). The video shows **Processando…** and the badge
   clears on its own within a minute or two. `docker compose logs | grep MEDIA` shows the
   before/after sizes.
2. **Sub-lists.** Create a second playlist with 3 items, then in the first playlist:
   *Add item → Sub-lists →* pick it. Publish. The published snapshot expands to N passes with
   a different sub-item each time.
3. **Widgets.** *Add item → Widgets →* add Clock (one click) and Lottery. The lottery widget
   renders the current Mega-Sena draw, fetched by the server, not the panel.
4. **Plan gates.** Assign yourself `free` temporarily — the Widgets and Sub-lists tabs
   disappear and the API answers 403 `FEATURE_LOCKED`. Set it back to `corporate`.

---

## Operations

```bash
cd /opt/loop-os

# logs
docker compose -f docker-compose.prod.yml logs -f --tail=100

# update to the latest commit
git pull && docker compose -f docker-compose.prod.yml up -d --build

# restart / stop
docker compose -f docker-compose.prod.yml restart
docker compose -f docker-compose.prod.yml down          # keeps the data volume

# locked out of the admin account
docker exec -it loop-player node scripts/reset-admin.js
```

### Backup

`st-data` is the **only** durable state — database, uploads and the JWT secret. Everything
else is rebuildable from the repository.

```bash
docker run --rm -v loop-os_st-data:/data -v /root/backups:/backup alpine \
  tar czf /backup/loop-os-$(date +%F).tar.gz -C /data .
```

Restore is the same command with `tar xzf`, against a stopped container.

### What is NOT deployed yet

- **Per-device sub-list cursor persistence.** The server records it and the rotation works;
  the Android/web players do not yet keep their position across a restart, so a rebooted
  screen resumes from the start of the snapshot rather than where it left off.
- **Asaas is in sandbox.** No real charge can be issued until `ASAAS_BASE_URL` is switched
  to `https://api.asaas.com/v3`.
