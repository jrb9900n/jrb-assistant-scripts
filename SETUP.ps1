# JRB Executive Agent — System Setup Guide
# Machine: dedicated agent machine
# Agent Windows account: C:\Users\Assistant
# Agent M365 account: assistant@jrboehlke.com
# Run every command below while logged in as your ADMIN account unless noted otherwise.

# ============================================================
# PHASE 1 — FOLDER STRUCTURE
# ============================================================
# Run this in PowerShell as Administrator

$base = "C:\Users\Assistant\JRBAgent"

$folders = @(
    "$base\agent",
    "$base\agent\core",
    "$base\agent\tools\impl",
    "$base\agent\memory",
    "$base\agent\scheduler",
    "$base\agent\teams",
    "$base\agent\agents",
    "$base\agent\skills",
    "$base\agent\config",
    "$base\scripts\playwright",
    "$base\scripts\sync",
    "$base\outputs\reports",
    "$base\outputs\drafts",
    "$base\logs",
    "$base\backups",
    "$base\vault"
)

foreach ($folder in $folders) {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    Write-Host "Created: $folder"
}

Write-Host "`nFolder structure created at $base"


# ============================================================
# PHASE 2 — WINDOWS PERMISSIONS
# ============================================================
# Lock down sensitive folders so only your admin account can access them.
# The Assistant account gets write access only where the agent needs it.

# Agent gets full access to working folders
$agentFolders = @("agent", "scripts", "outputs", "logs")
foreach ($folder in $agentFolders) {
    $path = "$base\$folder"
    $acl = Get-Acl $path
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "DESKTOP-XXXX\Assistant",   # <-- Replace DESKTOP-XXXX with your machine name
        "Modify",
        "ContainerInherit,ObjectInherit",
        "None",
        "Allow"
    )
    $acl.SetAccessRule($rule)
    Set-Acl $path $acl
    Write-Host "Permissions set: Assistant can modify $folder"
}

# Admin-only folders (backups and vault — no agent access)
$restrictedFolders = @("backups", "vault")
foreach ($folder in $restrictedFolders) {
    $path = "$base\$folder"
    $acl = Get-Acl $path

    # Remove Assistant account access entirely
    $acl.Access | Where-Object { $_.IdentityReference -like "*Assistant*" } | ForEach-Object {
        $acl.RemoveAccessRule($_) | Out-Null
    }
    Set-Acl $path $acl
    Write-Host "Restricted: Assistant cannot access $folder"
}

# How to find your machine name:
# Run: $env:COMPUTERNAME


# ============================================================
# PHASE 3 — NODE.JS SETUP
# ============================================================
# Run as the Assistant account (switch users or use runas)

# 1. Install Node.js LTS from https://nodejs.org
#    Choose the Windows Installer (.msi) — install for current user only

# 2. Install pm2 globally
npm install -g pm2

# 3. Copy agent code into place
# (Copy the agent/ folder from this project into C:\Users\Assistant\JRBAgent\agent\)

# 4. Install dependencies
cd C:\Users\Assistant\JRBAgent\agent
npm install

# 5. Create .env from the template
copy .env.example .env
# Then edit .env with your credentials — see Phase 5 below


# ============================================================
# PHASE 4 — SUPABASE TABLES
# ============================================================
# 1. Log into supabase.com → your project (mzywmgesulyalevtzudw)
# 2. Go to SQL Editor
# 3. Paste and run the contents of agent/config/supabase_schema.sql
# 4. Verify tables exist: agent_token_log, agent_memory, agent_cache,
#    agent_library, skill_library, agent_cache
#
# Add RLS policies so only the service role key can write:

-- Run this in the Supabase SQL Editor after the schema:

ALTER TABLE agent_token_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory     ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_cache      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_library    ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_library    ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically (that's correct).
-- Anon key gets zero access:
CREATE POLICY "deny_anon" ON agent_token_log FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon" ON agent_memory     FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon" ON agent_cache      FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon" ON agent_library    FOR ALL TO anon USING (false);
CREATE POLICY "deny_anon" ON skill_library    FOR ALL TO anon USING (false);


# ============================================================
# PHASE 5 — CREDENTIALS (do these in order)
# ============================================================

# --- A. Anthropic API key ---
# 1. Go to console.anthropic.com
# 2. Settings → API Keys → Create key
#    Name: "JRB Executive Agent"
# 3. Settings → Billing → Usage limits
#    Set monthly limit: $50 (adjust once you see real usage after 1 week)
# 4. Add to .env:
ANTHROPIC_API_KEY=sk-ant-...

# --- B. Supabase keys ---
# 1. supabase.com → project mzywmgesulyalevtzudw → Settings → API
# 2. Copy "service_role" key (NOT the anon key)
# 3. Add to .env:
SUPABASE_URL=https://mzywmgesulyalevtzudw.supabase.co
SUPABASE_SERVICE_KEY=eyJ...   # service_role key only

# --- C. HubSpot private app ---
# 1. app.hubspot.com → Settings → Integrations → Private Apps → Create
#    Name: "JRB Executive Agent"
# 2. Scopes — select ONLY:
#    crm.objects.contacts.read
#    crm.objects.deals.read
#    crm.objects.companies.read
#    crm.objects.line_items.read
#    (Do NOT add any .write scopes)
# 3. Create app → copy access token
# 4. Add to .env:
HUBSPOT_API_KEY=pat-na1-...

# --- D. QuickBooks (already set up via AuditMatchingEngine) ---
# Copy these from the AuditMatchingEngine .env:
QB_CLIENT_ID=        # from developer.intuit.com
QB_CLIENT_SECRET=    # from developer.intuit.com
QB_REFRESH_TOKEN=    # current refresh token (expires ~July 2026)
QB_REALM_ID=9130357265584656

# --- E. GitHub fine-grained PAT ---
# 1. github.com → Settings → Developer settings → Personal access tokens → Fine-grained
# 2. Token name: "JRB Executive Agent"
#    Expiration: 90 days (set a calendar reminder to rotate)
#    Resource owner: your org or personal account
#    Repository access: Only select repositories → "jrb-scripts" (create this repo first)
# 3. Repository permissions:
#    Contents: Read and write
#    Metadata: Read (required automatically)
#    (Everything else: No access)
# 4. Add to .env:
GITHUB_TOKEN=github_pat_...
GITHUB_ORG=jrboehlke          # your GitHub org/username
GITHUB_DEFAULT_REPO=jrb-scripts

# --- F. Microsoft 365 App Registration ---
# This is the most involved step. Do it once.
#
# 1. portal.azure.com → sign in with your admin account (NOT assistant@jrboehlke.com)
# 2. Azure Active Directory → App registrations → New registration
#    Name: "JRB Executive Agent"
#    Supported account types: Single tenant (your org only)
#    Redirect URI: leave blank
#    → Register
#
# 3. Note the Application (client) ID → this is your TEAMS_BOT_APP_ID and M365_CLIENT_ID
# 4. Note the Directory (tenant) ID → this is your M365_TENANT_ID
#
# 5. API Permissions → Add a permission → Microsoft Graph → Application permissions
#    Add ONLY these:
#    Mail.ReadWrite
#    Mail.Send
#    Calendars.ReadWrite
#    Tasks.ReadWrite
#    Files.ReadWrite           ← NOT Files.ReadWrite.All
#    User.Read.All             ← needed to resolve assistant@jrboehlke.com
#
#    DO NOT ADD:
#    Directory.ReadWrite.All
#    Files.ReadWrite.All
#    Mail.ReadWrite.All
#    Any DeviceManagement.* permissions
#
# 6. Grant admin consent (the blue button — requires your admin account)
#
# 7. Certificates & secrets → New client secret
#    Description: "JRB Agent Secret 2025"
#    Expires: 24 months
#    → Add → COPY THE VALUE IMMEDIATELY (it hides after you navigate away)
#
# 8. Add to .env:
M365_TENANT_ID=       # Directory (tenant) ID from step 4
M365_CLIENT_ID=       # Application (client) ID from step 3
M365_CLIENT_SECRET=   # Secret value from step 7
M365_USER_EMAIL=assistant@jrboehlke.com

# --- G. Teams Bot (do this after M365 app registration) ---
# 1. portal.azure.com → Create a resource → Azure Bot
#    Bot handle: JRBExecutiveAgent
#    Subscription: your subscription
#    Resource group: reuse existing or create "jrb-agent-rg"
#    Pricing tier: F0 (Free)
#    Microsoft App ID: Use existing → paste the Client ID from step F.3
#    → Review + Create
#
# 2. Azure Bot → Channels → Microsoft Teams → Apply
#
# 3. Set messaging endpoint after starting the bot server (Phase 6)
#
# 4. Add to .env:
TEAMS_BOT_APP_ID=     # Same as M365_CLIENT_ID
TEAMS_BOT_APP_SECRET= # Same as M365_CLIENT_SECRET
TEAMS_PORT=3978


# ============================================================
# PHASE 6 — CLOUDFLARE TUNNEL (permanent public URL for Teams)
# ============================================================
# Free and permanent — better than ngrok for production use.

# 1. cloudflare.com → sign up for free account
# 2. Download cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
#    Choose: Windows 64-bit
#    Place cloudflared.exe in C:\Users\Assistant\JRBAgent\

# 3. Authenticate (run as Assistant account):
cloudflared tunnel login

# 4. Create a named tunnel:
cloudflared tunnel create jrb-agent

# 5. Note the tunnel ID printed — you'll need it in step 7

# 6. Create tunnel config at C:\Users\Assistant\.cloudflared\config.yml:
tunnel: <YOUR_TUNNEL_ID>
credentials-file: C:\Users\Assistant\.cloudflared\<YOUR_TUNNEL_ID>.json

ingress:
  - hostname: agent.jrboehlke.com   # or any subdomain you own
    service: http://localhost:3978
  - service: http_status:404

# 7. Add DNS record in Cloudflare dashboard:
#    Type: CNAME
#    Name: agent
#    Target: <YOUR_TUNNEL_ID>.cfargotunnel.com
#    Proxy: enabled (orange cloud)

# 8. Run tunnel as a Windows service (auto-starts with machine):
cloudflared service install
net start cloudflared

# 9. Update Azure Bot messaging endpoint to:
#    https://agent.jrboehlke.com/api/messages


# ============================================================
# PHASE 7 — START SERVICES WITH PM2
# ============================================================
# Run as the Assistant account

cd C:\Users\Assistant\JRBAgent\agent

# Seed the agent and skill library (one time)
node agents/seed.js
node skills/seed.js

# Start the Teams bot
pm2 start teams/bot.js --name jrb-teams-bot

# Start the scheduler
pm2 start scheduler/cron.js --name jrb-scheduler

# Save the process list so it survives reboots
pm2 save

# Configure pm2 to auto-start on Windows boot:
pm2 startup windows
# Follow the printed instructions (usually installs a Windows service)

# Check everything is running:
pm2 status


# ============================================================
# PHASE 8 — VERIFY EVERYTHING WORKS
# ============================================================

# Test 1: Run a task from the CLI (as Assistant account)
cd C:\Users\Assistant\JRBAgent\agent
node cli.js "list my 5 most recent unread emails"

# Test 2: Check token logging worked
# Go to Supabase → Table Editor → agent_token_log
# You should see one row from the test above

# Test 3: Teams bot
# Open Microsoft Teams → search for "JRB Executive Agent" in Apps
# Send: "hello"
# Expected: "⏳ Working on it..." then a response

# Test 4: Check the agent daily token spend view
# Supabase → SQL Editor:
SELECT * FROM agent_daily_token_spend;


# ============================================================
# ONGOING MAINTENANCE
# ============================================================

# Rotate GitHub PAT every 90 days (set a calendar reminder):
# github.com → Settings → Developer settings → Fine-grained PATs → regenerate

# Rotate M365 client secret every 24 months (set a reminder for Jan 2027):
# portal.azure.com → App registrations → JRB Executive Agent → Certificates & secrets

# Rotate QB refresh token if it expires (~100 days from last OAuth flow):
# Re-run OAuth flow at developer.intuit.com → OAuth Playground
# Current expiry: ~July 2026

# Weekly: check pm2 status and logs
pm2 status
pm2 logs jrb-teams-bot --lines 50
pm2 logs jrb-scheduler --lines 50

# Monthly: review Anthropic spend
# console.anthropic.com → Usage
# Also: SELECT * FROM agent_monthly_token_spend; in Supabase

# Backup .env to the vault (encrypted, not synced anywhere):
# Manually copy C:\Users\Assistant\JRBAgent\agent\.env
#         to   C:\Users\Assistant\JRBAgent\vault\.env.backup.YYYY-MM-DD
# Keep vault\ off OneDrive sync
