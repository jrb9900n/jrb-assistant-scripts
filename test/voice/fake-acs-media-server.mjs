// test/voice/fake-acs-media-server.mjs — local test harness for the voice
// bridge, standing in for a real ACS phone call with zero Azure dependency.
//
// Starts the real voice bridge server (voice/realtime-bridge.js) in-process,
// seeds a fake call session directly via session-state.js (bypassing
// acs-call-handler's answerIncomingCall, which needs a real
// ACS_CONNECTION_STRING), then connects a WS client to /voice-media exactly
// as ACS's own infrastructure would, sending synthetic AudioMetadata +
// AudioData frames and logging whatever comes back.
//
// This exercises the full relay/PIN-gate/tool-call loop against the REAL,
// already-live OpenAI Realtime API and REAL dispatchTool() calls -- only the
// telephony leg (ACS itself) is faked. Requires OPENAI_API_KEY to be set.
//
// Usage: node test/voice/fake-acs-media-server.mjs
import WebSocket from 'ws';
import { StreamingData } from '@azure/communication-call-automation';
import { createVoiceBridgeServer } from '../../voice/realtime-bridge.js';
import * as sessions from '../../voice/session-state.js';

const SAMPLE_RATE = 24000;
const FRAME_MS = 20; // ACS streams ~20ms audio frames in practice
const SAMPLES_PER_FRAME = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
const FAKE_CALL_ID = 'fake-call-' + Date.now();

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not set -- this harness calls the real OpenAI Realtime API. Set it and re-run.');
  process.exit(1);
}

// Synthetic 400Hz tone, 16-bit PCM mono, little-endian -- stands in for a
// real WAV file so this harness needs no committed binary test fixture.
function generateToneFrame(sampleOffset) {
  const buf = Buffer.alloc(SAMPLES_PER_FRAME * 2);
  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    const t = (sampleOffset + i) / SAMPLE_RATE;
    const sample = Math.round(Math.sin(2 * Math.PI * 400 * t) * 8000);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

async function main() {
  const server = createVoiceBridgeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`Fake harness: voice bridge listening on :${port}`);

  sessions.create(FAKE_CALL_ID, { fromNumber: '+15555550100', authState: 'awaiting_pin' });
  console.log(`Fake harness: seeded session ${FAKE_CALL_ID}`);

  const ws = new WebSocket(`ws://localhost:${port}/voice-media`, {
    headers: { 'x-ms-call-connection-id': FAKE_CALL_ID },
  });

  ws.on('open', () => {
    console.log('Fake harness: media socket connected, sending AudioMetadata + tone frames');
    ws.send(JSON.stringify({
      kind: 'AudioMetadata',
      audioMetadata: { subscriptionId: 'fake-sub', encoding: 'PCM', sampleRate: SAMPLE_RATE, channels: 1, length: SAMPLES_PER_FRAME * 2 },
    }));

    let sampleOffset = 0;
    const interval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(interval);
        return;
      }
      const frame = generateToneFrame(sampleOffset);
      sampleOffset += SAMPLES_PER_FRAME;
      ws.send(JSON.stringify({
        kind: 'AudioData',
        audioData: { timestamp: new Date().toISOString(), participantRawID: 'fake-participant', data: frame.toString('base64'), silent: false },
      }));
    }, FRAME_MS);

    // 30s is enough to observe the PIN-gate prompt and a few response turns;
    // not meant to complete a real PIN challenge (the tone carries no speech).
    setTimeout(() => {
      clearInterval(interval);
      console.log('Fake harness: done, closing.');
      ws.close();
      server.close();
      process.exit(0);
    }, 30_000);
  });

  ws.on('message', (raw) => {
    // What we receive here is the bridge's OUTBOUND-to-ACS frame shape
    // (created via createOutboundAudioData -- lowercase "audioData" kind),
    // a different wire schema from the inbound frames we're sending above
    // (StreamingData.parse() only understands the PascalCase inbound kinds,
    // so it isn't used here -- this just inspects the JSON directly).
    try {
      const parsed = JSON.parse(raw.toString());
      if (parsed.kind === 'audioData') {
        console.log(`Fake harness: received audio-out frame (${parsed.audioData?.data?.length ?? 0} b64 chars)`);
      } else {
        console.log('Fake harness: received frame', parsed.kind);
      }
    } catch {
      console.log('Fake harness: received non-frame message', raw.toString().slice(0, 200));
    }
  });

  ws.on('close', () => console.log('Fake harness: media socket closed'));
  ws.on('error', (err) => console.error('Fake harness: media socket error', err.message));
}

main().catch((err) => {
  console.error('Fake harness failed:', err);
  process.exit(1);
});
