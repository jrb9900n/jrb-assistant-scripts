// voice/acs-call-handler.js — ACS Call Automation lifecycle + media relay wiring.
//
// Media-streaming audio format is fixed to Pcm24KMono (24kHz, 16-bit, mono
// PCM) -- this is what makes the "no resampling needed" bridge to OpenAI
// Realtime's 24kHz PCM work (see openai-realtime-client.js's header comment).
// The AudioMetadata frame ACS sends on connect is used as a defensive check
// on that assumption, not just trusted blindly.
import { CallAutomationClient, StreamingData, createOutboundAudioData } from '@azure/communication-call-automation';
import { logger } from '../core/logger.js';
import { checkCallerAllowlist } from './call-auth.js';
import { connectRealtimeSession } from './openai-realtime-client.js';
import * as sessions from './session-state.js';

const PUBLIC_MEDIA_WSS = process.env.VOICE_PUBLIC_MEDIA_WSS || 'wss://agent.jrboehlke.com/voice-media';
const PUBLIC_CALLBACK_URL = process.env.VOICE_PUBLIC_CALLBACK_URL || 'https://agent.jrboehlke.com/voice/events';

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.ACS_CONNECTION_STRING) {
      throw new Error('ACS_CONNECTION_STRING not set -- cannot answer/reject calls.');
    }
    _client = new CallAutomationClient(process.env.ACS_CONNECTION_STRING);
  }
  return _client;
}

export async function handleIncomingCallEvent(evt) {
  const fromNumber = evt.data?.from?.phoneNumber?.value ?? null;
  const incomingCallContext = evt.data?.incomingCallContext;

  if (!checkCallerAllowlist(fromNumber)) {
    logger.warn('Voice bridge: rejecting call from unrecognized caller ID', { fromNumber });
    try {
      await getClient().rejectCall(incomingCallContext);
    } catch (err) {
      logger.error('Voice bridge: rejectCall failed', { err: err.message });
    }
    return;
  }

  try {
    const answerResult = await getClient().answerCall(incomingCallContext, PUBLIC_CALLBACK_URL, {
      mediaStreamingOptions: {
        transportUrl: PUBLIC_MEDIA_WSS,
        transportType: 'websocket',
        contentType: 'audio',
        audioChannelType: 'unmixed',
        startMediaStreaming: true,
        enableBidirectional: true,
        // DTMF (keypad) PIN entry isn't part of v1 -- only spoken-PIN
        // matching (call-auth.js) -- so this stays off rather than
        // streaming tones nothing consumes.
        enableDtmfTones: false,
        // Exact casing per the SDK's KnownAudioFormat enum ('pcm24KMono', not
        // 'Pcm24KMono') -- not re-exported from the package root, so this is
        // a literal rather than an enum reference. Must match
        // openai-realtime-client.js's `rate: 24000` for the "no resampling
        // needed" bridge to hold.
        audioFormat: 'pcm24KMono',
      },
    });
    // answerCall() resolves { callConnectionProperties, callConnection } --
    // not a flat object -- the id lives on callConnectionProperties.
    const callConnectionId = answerResult.callConnectionProperties.callConnectionId;
    sessions.create(callConnectionId, { fromNumber, authState: 'awaiting_pin' });
    logger.info('Voice bridge: answered call', { callConnectionId, fromNumber });
  } catch (err) {
    logger.error('Voice bridge: answerCall failed', { err: err.message, fromNumber });
  }
}

export async function handleCallbackEvent(evt) {
  const callConnectionId = evt.data?.callConnectionId;
  if (!callConnectionId) return;

  // NOTE (2026-08-26): confirmed live that this branch never actually fires
  // -- zero 'Voice bridge: call ended' log lines across all 6 real calls
  // that day, including short ones nowhere near the trial number's 5-min-
  // per-call cap. Two evening calls' activity did stop almost exactly 5:00
  // after being answered (4:48 and 5:01 elapsed), consistent with the trial
  // cap hard-cutting the underlying PSTN/media path in a way that never
  // reaches Call Automation as a normal disconnect -- but that doesn't
  // explain the sub-cap calls also never logging this. Left in place as
  // defense-in-depth / the "proper" cleanup path for whenever a real
  // (non-trial) number removes the cap variable, but attachAcsMediaSocket's
  // ws.on('close') handler in this file is the cleanup path that's actually
  // been reliable -- don't assume this one is running in production.
  if (evt.eventType === 'Microsoft.Communication.CallDisconnected' ||
      evt.eventType === 'Microsoft.Communication.MediaStreamingFailed') {
    const session = sessions.get(callConnectionId);
    session?.openaiClient?.close();
    sessions.remove(callConnectionId);
    logger.info('Voice bridge: call ended', { callConnectionId, eventType: evt.eventType });
  }
}

export async function hangUpCall(callConnectionId) {
  try {
    await getClient().getCallConnection(callConnectionId).hangUp(true);
  } catch (err) {
    logger.error('Voice bridge: hangUp failed', { callConnectionId, err: err.message });
  }
}

export function attachAcsMediaSocket(ws, headers) {
  const callConnectionId = headers['x-ms-call-connection-id'];
  const session = sessions.get(callConnectionId);
  if (!session) {
    logger.warn('Voice bridge: media socket connected for unknown call, closing', { callConnectionId });
    ws.close();
    return;
  }

  session.wsToAcs = {
    sendAudioOut: (base64pcm) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(createOutboundAudioData(base64pcm));
    },
  };

  let loggedSampleRate = false;

  ws.on('message', (raw) => {
    // StreamingData.parse() returns the parsed payload with its wrapper
    // stripped (e.g. AudioData's .data directly, not .audioData.data) --
    // the kind it was parsed as is only available via the separate
    // getStreamingKind() call, which reads a static field the parse() call
    // just set. Must be read synchronously right after parse(), before any
    // await, since that field is shared process-wide (not per-call) --
    // fine here since this whole handler runs synchronously to completion.
    let parsed, kind;
    try {
      parsed = StreamingData.parse(raw);
      kind = StreamingData.getStreamingKind();
    } catch (err) {
      logger.warn('Voice bridge: failed to parse ACS media frame', { err: err.message });
      return;
    }

    if (kind === 'AudioMetadata') {
      if (!loggedSampleRate) {
        loggedSampleRate = true;
        if (parsed.sampleRate !== 24000) {
          logger.warn('Voice bridge: ACS media stream sample rate is not 24000 -- audio will be distorted without resampling', { callConnectionId, sampleRate: parsed.sampleRate });
        }
      }
      return;
    }

    if (kind === 'AudioData') {
      session.openaiClient?.sendAudioIn(parsed.data);
    }
    // enableDtmfTones is off above -- no DtmfData frames expected in v1.
  });

  ws.on('close', () => {
    // Primary cleanup path, not just a backstop: confirmed live 2026-08-26
    // that handleCallbackEvent's 'Microsoft.Communication.CallDisconnected'
    // branch (the intended cleanup trigger -- closes openaiClient AND
    // removes the sessions.js entry) never actually fired for any of that
    // day's 6 real calls, including ones that ended well under the trial
    // number's 5-min-per-call cap -- so it isn't solely a trial-cap artifact.
    // This media-socket close is a TCP-level event ACS always delivers when
    // a call's audio stream ends, regardless of whether the separate HTTP
    // callback for CallDisconnected ever reaches this server, so it's the
    // reliable place to do full cleanup. Without the sessions.remove() call
    // here, session-state.js's Map only ever grew -- openaiClient was closed
    // but the stale entry (fromNumber, authState, etc.) never got evicted.
    session.openaiClient?.close();
    session.wsToAcs = null;
    sessions.remove(callConnectionId);
  });

  ws.on('error', (err) => {
    logger.error('Voice bridge: ACS media socket error', { callConnectionId, err: err.message });
  });

  connectRealtimeSession({ session, hangUp: () => hangUpCall(callConnectionId) })
    .then((client) => { session.openaiClient = client; })
    .catch((err) => {
      logger.error('Voice bridge: failed to start OpenAI Realtime session', { callConnectionId, err: err.message });
      hangUpCall(callConnectionId);
    });
}
