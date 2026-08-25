# Brief: Live Real-Time Voice Conversation for JRB Agent

## Context for the agent picking this up

This is the JRB Agent repo — a persistent AI executive assistant for Michael
Reardon (owner, J.R. Boehlke LLC) built on the Anthropic API, running as a
Microsoft Teams bot plus a scheduler on a dedicated Windows machine. Read
`CLAUDE.md` at the repo root first — it documents the full architecture,
credential pattern, autonomy rules, and the worktree convention you MUST
follow (never check out a branch in the live root `C:\Users\Assistant\JRBAgent`
itself; always work in a new worktree under `C:\Users\Assistant\.worktrees\`,
per CLAUDE.md's "Worktree Convention" section).

**Goal**: Michael wants to have a live, real-time, verbal, back-and-forth
conversation with the agent — like calling a real assistant on the phone —
to do things like reprioritize his calendar or talk through inbox triage,
rather than typing or recording-and-waiting. This is explicitly a step
beyond the existing voice-memo feature (see below).

## What already exists (do not rebuild)

- **Async voice memos** (built, live, working as of 2026-08-24): Michael can
  record a voice memo in Teams, it gets transcribed via OpenAI Whisper, the
  agent responds via its normal tool-using pipeline, and can optionally reply
  with synthesized speech (OpenAI TTS) if he explicitly asks for a voice
  reply. See `tools/impl/openai-voice.js` and `teams/bot.js`'s
  `extractAndTranscribeVoiceMemo`/`WANTS_VOICE_REPLY_RE`. This is turn-based
  (record → send → wait several seconds → reply), NOT a live call — that gap
  is what this brief is about.
- **`OPENAI_API_KEY`** is already provisioned in Windows Credential Manager
  (`JRBAgent:OPENAI_API_KEY`) and injected by `launcher/start-agent.ps1`, with
  real billing set up on the OpenAI platform side (platform.openai.com, not
  the ChatGPT consumer app — these are separate billing systems, confirmed
  live 2026-08-24 after an initial mix-up).
- **Full tool layer already exists** for everything the live-voice agent
  would need to act on: calendar (`tools/impl/m365.js`'s
  `listCalendarEvents`/`createCalendarEvent`/`updateCalendarEvent` etc.,
  default to `michael@jrboehlke.com`), email (`listEmails`/`get_email_triage`/
  `draft_email`/`send_email`, any mailbox via `userEmail` param — confirmed
  working for `michael@jrboehlke.com`, `assistant@jrboehlke.com`, and
  `support@jrboehlke.com`), OneDrive/SharePoint (`searchSharePoint`/
  `listSharePointSites`, full access confirmed live as of 2026-08-24 after a
  `Sites.Read.All` Graph permission grant). A dedicated
  `resolve_calendar_conflict` tool (built 2026-08-25) already runs the
  President Weekly Block Schedule's priority-tier auto-displacement logic on
  demand — reuse this rather than reimplementing calendar conflict
  resolution.
- **`tools/dispatcher.js`** is the single call-routing layer between any tool
  name and its implementation — the live-voice bridge should call into this
  exact same dispatcher, not duplicate tool logic.

## What's missing — the actual scope of this work

There is **zero real-time audio/calling infrastructure** anywhere in this
repo. `teams/bot.js` only handles Bot Framework's `message` activity type
(text + attachments); no `botbuilder`/`@azure/communication-calling`
packages exist. Confirmed by direct repo search 2026-08-24.

## Recommended architecture

### 1. Real-time audio transport
Build against **Azure Communication Services (ACS) Call Automation**, NOT
Teams' native calling channel, at least for a first version. Michael dials a
dedicated phone number, ACS answers programmatically and streams raw audio
to/from a new server over a WebSocket. Rationale: this is Microsoft's
modern, well-documented calling API, needs zero Teams admin/manifest
changes, and is provisioned entirely through code + one new Azure resource.
Registering a custom bot for Teams' actual calling channel is a separate,
more operationally finicky path (older calling-media API surface, may need
Teams-admin-center involvement) — don't tackle both unknowns
(real-time-audio-plus-function-calling AND Teams-calling-registration) at
once. If Michael specifically wants it reachable as a literal Teams call
later, that's a second phase built on top of a working ACS version, not the
starting point.

### 2. Conversational engine
Use **OpenAI's Realtime API** (WebSocket-based, speech-to-speech, supports
mid-conversation function/tool calling, low-latency interruption/barge-in).
`OPENAI_API_KEY` is already available. Anthropic/Claude has no public
real-time speech-to-speech equivalent as of this writing — chaining a
separate streaming STT + Claude (text) + streaming TTS is possible but adds
real latency-tuning complexity; start with OpenAI Realtime for the voice
surface specifically. Claude keeps handling every other surface (Teams
text/voice-memo, scheduling, CRM, dev work) unchanged — this is additive,
not a replacement.

### 3. Tool access
The live session's function-calling schema should be a **curated subset** of
existing tool definitions in `tools/registry.js`, dispatched through the
same `tools/dispatcher.js` used everywhere else — not a parallel
reimplementation. Start with: read calendar, `resolve_calendar_conflict`,
create/move/delete calendar events, list/search recent emails,
`get_email_triage`, `draft_email`. Expand later based on what Michael
actually asks for on real calls.

## Proposed concrete build

- New Azure Communication Services resource + a phone number (needs to be
  provisioned in the Azure Portal — Michael's account, not something an
  agent can self-serve without his Azure access).
- New file `voice/realtime-bridge.js` (new top-level `voice/` directory,
  parallel to `teams/`/`scheduler/`): a WebSocket server that (a) accepts
  ACS's Call Automation media-streaming connection when a call comes in,
  (b) opens a second WebSocket to OpenAI's Realtime API, (c) relays audio
  frames both ways, (d) registers the curated tool schema from above, whose
  function-call handler calls straight into `tools/dispatcher.js`.
- Runs as its own supervised process — new Windows Task Scheduler task +
  watchdog, mirroring the existing "JRB Teams Bot" / "JRB Cloudflare
  Watchdog" pattern (see `launcher/watchdog-bot.ps1` for the existing
  pattern to copy). Fronted by the existing Cloudflare tunnel
  (`agent.jrboehlke.com`) on a new path.
- **Caller authorization**: a live phone line has no Azure AD identity to
  check the way a Teams message does (see `teams/bot.js`'s `resolveSender`
  for that pattern). Allow-list Michael's caller ID as a first line of
  defense (spoofable, so treat as advisory only) plus a short spoken
  PIN/passphrase challenge before granting any tool access.
- **New credential**: an ACS connection string, saved via the same
  `launcher/save-*-secrets.ps1` interactive-prompt pattern as every other
  secret in this project (see `launcher/save-openai-secrets.ps1` for the
  exact template to copy), then added to `launcher/start-agent.ps1`'s
  `$secrets` hashtable. **Per CLAUDE.md's autonomy rules, editing
  `start-agent.ps1` always requires Michael's explicit go-ahead before that
  specific PR is opened/merged** — do the rest of the build first, flag this
  one step for his sign-off separately.
- **Known operational gotcha to design around**: this machine's live bot
  process cannot be killed/restarted by an agent session directly (a
  previously-confirmed permission limitation — `taskkill`/`Stop-ScheduledTask`
  both fail silently from a non-elevated Claude Code session). Any change
  requiring a restart to take effect needs to be flagged to Michael to
  restart it himself; don't loop trying workarounds.

## Cost note to surface to Michael before starting

Both ACS calling minutes and OpenAI Realtime API audio-minutes are metered
and meaningfully more expensive per-minute than the existing
Whisper-transcribe + one Claude turn + one TTS-call voice-memo path. Fine
for occasional use; worth him knowing before this becomes a default channel.

## Verification plan

1. Live Graph/tool sanity checks are already done — no need to re-verify
   mailbox/calendar/OneDrive access, just reuse the existing tools.
2. Real end-to-end test call: dial the new ACS number, confirm live
   transcription/response/interruption behavior feels natural, and confirm
   a tool call (e.g. "what's on my calendar tomorrow") actually reaches
   `tools/dispatcher.js` and returns real data — not a hallucinated answer.
3. Confirm caller-ID + PIN gating actually blocks an unauthorized caller
   before granting tool access.

## Explicit non-goals for a first version

- Teams-native calling registration (separate follow-up, see above).
- Broad, unreviewed tool access on the first call — start narrow (calendar +
  email read/triage), expand deliberately.
- Don't touch `start-agent.ps1` without a separate, explicit go-ahead from
  Michael, even though the rest of this build can proceed autonomously.
