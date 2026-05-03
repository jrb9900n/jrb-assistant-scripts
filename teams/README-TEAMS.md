# Teams Bot Setup Guide

This connects your AI agent to Microsoft Teams so you can message it from
your phone or desktop exactly like a colleague.

---

## Architecture

```
Your phone/laptop
      │  (Teams message)
      ▼
Azure Bot Service  ──────────────────────►  ngrok / your domain
      │                                          │
      │  (webhook POST /api/messages)             │
      ▼                                          ▼
teams/bot.js ──────────────────────► runAgent()  →  Claude API
```

---

## Step 1 — Register the Bot in Azure

1. Go to [portal.azure.com](https://portal.azure.com)
2. Create a new resource → **Azure Bot**
   - Name: `JRB Executive Agent`
   - Resource group: your existing RG (or create new)
   - Pricing: **Free (F0)** — plenty for personal use
   - Microsoft App ID: **Create new Microsoft App ID**
3. After creation, go to the bot → **Configuration**
   - Copy the **Microsoft App ID** → add to `.env` as `TEAMS_BOT_APP_ID`
4. Go to **Manage** (next to App ID) → **Certificates & secrets**
   - New client secret → copy value → add to `.env` as `TEAMS_BOT_APP_SECRET`

---

## Step 2 — Expose Your Local Server

The bot needs a public HTTPS URL. Two options:

### Option A — ngrok (for testing / getting started fast)
```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3978
# Copy the https://xxxx.ngrok.io URL
```

### Option B — Cloudflare Tunnel (permanent, free, recommended for production)
```bash
# Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
cloudflared tunnel --url http://localhost:3978
# Or set up a named tunnel pointing to a subdomain you own
```

---

## Step 3 — Set the Messaging Endpoint

1. Back in Azure Bot → **Configuration**
2. Set **Messaging endpoint** to:
   `https://YOUR_PUBLIC_URL/api/messages`
3. Click **Apply**

---

## Step 4 — Enable Teams Channel

1. Azure Bot → **Channels**
2. Click **Microsoft Teams** → **Apply**
3. Agree to Terms of Service

---

## Step 5 — Add to .env

```env
TEAMS_BOT_APP_ID=your-app-id-guid
TEAMS_BOT_APP_SECRET=your-client-secret
TEAMS_PORT=3978
```

---

## Step 6 — Start the Bot

```bash
node teams/bot.js
```

Or add it to pm2 alongside the scheduler:
```bash
pm2 start teams/bot.js --name jrb-agent-teams
pm2 save
```

---

## Step 7 — Chat with Your Bot

1. In Teams, go to **Apps** → search for your bot by name, OR
2. Use this direct link (replace with your App ID):
   `https://teams.microsoft.com/l/chat/0/0?users=28:YOUR_BOT_APP_ID`
3. Start a chat — the bot appears as a contact

To add to a team channel:
- Go to the channel → **+** (Add tab or connector) → search your bot name

---

## Usage from Teams

### Natural language (just type normally)
```
summarise my inbox
what invoices are overdue?
draft a follow-up for the Acme deal
write a script that pulls all QB payments this month and saves to OneDrive
```

### Shorthand commands
```
/list agents              ← see all saved agents
/list skills              ← see all saved skills
/agent invoice-chaser Chase all invoices older than 30 days
/skill weekly-crm-report
/skill playwright-run SCRIPT_NAME=hubspot-sync
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Bot doesn't respond | Check ngrok/tunnel is running, messaging endpoint is correct |
| 401 errors in logs | Regenerate client secret, update .env, restart bot |
| "Working on it..." but no reply | Check agent logs at logs/agent.log for errors |
| Teams shows bot as offline | Bot server must be running; check `pm2 status` |

---

## Security Notes

- The bot currently accepts messages from **any Teams user in your tenant**.
- To restrict to yourself only, add this check in `teams/bot.js → handleMessage`:
  ```js
  const ALLOWED_USERS = process.env.TEAMS_ALLOWED_EMAILS?.split(',') ?? [];
  if (!ALLOWED_USERS.includes(activity.from?.aadObjectId)) {
    return 'You are not authorised to use this assistant.';
  }
  ```
- Add `TEAMS_ALLOWED_EMAILS=your-aad-object-id` to `.env`
  (find your AAD Object ID at portal.azure.com → Users → your account)
