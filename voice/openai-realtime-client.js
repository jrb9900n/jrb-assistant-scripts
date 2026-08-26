// voice/openai-realtime-client.js — one OpenAI Realtime API session per call.
//
// Audio format: configured for 24kHz mono PCM on both input and output,
// matching ACS Call Automation's Pcm24KMono media-streaming format exactly
// (see acs-call-handler.js) -- no resampling/transcoding needed, just
// re-wrapping the same base64 payload between ACS's and OpenAI's JSON
// envelopes. See attachAcsMediaSocket() in acs-call-handler.js for the
// defensive sample-rate check on the ACS side of that assumption.
//
// PIN gate: the session starts with NO `tools` key in session.update at all
// -- the model has no vocabulary for calendar/email actions until the
// caller's spoken PIN matches (call-auth.js's matchSpokenPin). Once matched,
// a second session.update swaps in the full system prompt plus the curated
// tool schema. This mirrors this repo's existing TOOL_MAP.employee pattern
// of restricting by omission rather than by instruction alone.
import WebSocket from 'ws';
import { logger } from '../core/logger.js';
import { matchSpokenPin } from './call-auth.js';
import { buildVoiceToolSchema, handleVoiceToolCall } from './tool-bridge.js';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime';
const PIN_MAX_ATTEMPTS = 3;
const VOICE = 'alloy';

const PIN_GATE_PROMPT = `You are JRB's executive assistant, answering a live phone call.
Before discussing anything else, greet the caller briefly and ask them to say their PIN.
Do not discuss calendar or email content, and do not attempt any action, until told the PIN was accepted.
If a spoken PIN attempt is wrong, ask them to repeat it -- do not guess or make one up.`;

const VOICE_SYSTEM_PROMPT = `You are JRB's executive assistant (for Michael Reardon, J.R. Boehlke LLC),
speaking with Michael live on the phone. Be concise and conversational -- this is a live voice call,
not a chat window, so keep responses short and natural to say out loud. You can read/update Michael's
calendar, resolve block-schedule conflicts, and read/search/triage/draft his email using the tools
available to you. Always check the calendar before claiming a time is free or busy. If asked to do
something outside your available tools, say so plainly rather than pretending to have done it.`;

function audioSessionConfig(instructions, tools) {
  const session = {
    type: 'realtime',
    model: 'gpt-realtime',
    output_modalities: ['audio'],
    instructions,
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        turn_detection: { type: 'server_vad' },
        // Input transcription is opt-in -- without this, the caller's speech
        // is never transcribed at all, and handleTranscript() below (the
        // entire PIN gate) would never fire on a real call.
        transcription: { model: 'gpt-4o-mini-transcribe' },
      },
      output: { format: { type: 'audio/pcm', rate: 24000 }, voice: VOICE },
    },
  };
  if (tools) session.tools = tools;
  return session;
}

/**
 * @param {object} opts
 * @param {object} opts.session - the call's session-state.js record (mutated in place:
 *   sets .openaiWs, reads/writes .authState/.pinAttempts/.pinDeadline)
 * @param {function} opts.hangUp - async () => void, called to end the call (PIN exhausted)
 */
export async function connectRealtimeSession({ session, hangUp }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set -- cannot start a voice session.');

  const ws = new WebSocket(REALTIME_URL, { headers: { Authorization: `Bearer ${apiKey}` } });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.send(JSON.stringify({ type: 'session.update', session: audioSessionConfig(PIN_GATE_PROMPT, null) }));
  // Output only ever happens in response to a turn (VAD-detected end of
  // caller speech) or an explicit response.create -- without this, the
  // model's "greet the caller" instruction would never actually produce
  // audio until the caller spoke first, leaving a silent, confusing line.
  ws.send(JSON.stringify({ type: 'response.create' }));

  // The `ws.once('error', reject)` registered above for the initial connect
  // race stays attached afterward too (it only unregisters once fired), so
  // a later socket error won't crash the process -- but it silently calls
  // the by-then-inert `reject()` with nothing logged. Add a real listener
  // so a post-connect socket error is at least visible.
  ws.on('error', (err) => {
    logger.error('Voice bridge: OpenAI Realtime socket error', { callId: session.callConnectionId, err: err.message });
  });

  ws.on('message', (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (evt.type === 'response.output_audio.delta' && evt.delta) {
      session.wsToAcs?.sendAudioOut?.(evt.delta);
      return;
    }

    if (evt.type === 'conversation.item.input_audio_transcription.completed') {
      handleTranscript(session, ws, evt.transcript, hangUp);
      return;
    }

    if (evt.type === 'response.done') {
      // Per OpenAI's own documented pattern, the function name only
      // reliably appears on the completed response's output items
      // (response.done -> response.output[].name), not on
      // response.function_call_arguments.done -- a response can also
      // contain more than one function_call item, so every matching item
      // is handled, not just the first.
      const items = evt.response?.output ?? [];
      for (const item of items) {
        if (item.type !== 'function_call') continue;
        handleFunctionCall(session, ws, item).catch((err) =>
          logger.error('Voice bridge: unhandled function-call error', { err: err.message })
        );
      }
      return;
    }

    if (evt.type === 'error') {
      logger.error('Voice bridge: OpenAI Realtime session error', { evt });
    }
  });

  ws.on('close', () => {
    if (session) session.openaiClient = null;
  });

  return {
    sendAudioIn: (base64pcm) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64pcm }));
    },
    close: () => ws.close(),
    _ws: ws,
  };
}

function handleTranscript(session, ws, transcript, hangUp) {
  if (session.authState !== 'awaiting_pin') return;

  if (Date.now() > session.pinDeadline) {
    logger.warn('Voice bridge: PIN challenge timed out, hanging up', { callId: session.callConnectionId });
    hangUp?.();
    return;
  }

  const storedPin = process.env.VOICE_CALL_PIN;
  if (matchSpokenPin(transcript, storedPin)) {
    session.authState = 'verified';
    ws.send(JSON.stringify({
      type: 'session.update',
      session: audioSessionConfig(VOICE_SYSTEM_PROMPT, buildVoiceToolSchema()),
    }));
    logger.info('Voice bridge: caller PIN verified', { callId: session.callConnectionId });
    return;
  }

  session.pinAttempts += 1;
  if (session.pinAttempts >= PIN_MAX_ATTEMPTS) {
    logger.warn('Voice bridge: PIN attempts exhausted, hanging up', { callId: session.callConnectionId });
    hangUp?.();
  }
}

async function handleFunctionCall(session, ws, evt) {
  // Belt-and-suspenders: tools are never attached to the session until
  // authState flips to 'verified' (see handleTranscript above), but a
  // function-call event arriving pre-verification would mean that
  // invariant broke somewhere -- refuse rather than silently execute.
  if (session.authState !== 'verified') {
    logger.warn('Voice bridge: function call received before PIN verification, refusing', {
      callId: session.callConnectionId,
      name: evt.name,
    });
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: evt.call_id, output: JSON.stringify({ error: 'Not authorized yet.' }) },
    }));
    ws.send(JSON.stringify({ type: 'response.create' }));
    return;
  }

  // A caller only reaches 'verified' by matching VOICE_CALL_PIN (call-auth.js)
  // -- that's the whole point of the gate, so a verified voice caller IS
  // Michael. context.sender must match teams/identity.js's resolveSender()
  // shape ({isMichael, aadId, name, email, employeeId}), since dispatcher.js
  // handlers like book_time_with_michael read sender.isMichael directly --
  // a bare string here would make sender.isMichael undefined, misclassifying
  // Michael himself as a non-Michael employee requester.
  const result = await handleVoiceToolCall(evt.name, evt.arguments, {
    sender: { isMichael: true, aadId: null, name: 'Michael Reardon', email: 'michael@jrboehlke.com', employeeId: null },
    callId: session.callConnectionId,
    fromNumber: session.fromNumber,
  });

  ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: evt.call_id, output: JSON.stringify(result) },
  }));
  ws.send(JSON.stringify({ type: 'response.create' }));
}
