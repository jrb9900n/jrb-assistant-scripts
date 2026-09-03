// voice/session-state.js — in-memory per-call state.
//
// No persistence: this repo's other supervised processes (Teams bot,
// scheduler) keep session-scoped state in memory too, and a live phone call
// dying on a process restart is an acceptable v1 tradeoff for a single
// caller with at most 1-2 concurrent calls — same as any phone system
// hiccup, not a data-loss risk (nothing here is the record of truth for
// anything; the calendar/email actions taken mid-call already persisted
// through the normal tools/dispatcher.js path).

const sessions = new Map();

function create(callConnectionId, initial = {}) {
  const state = {
    callConnectionId,
    fromNumber: initial.fromNumber ?? null,
    authState: initial.authState ?? 'awaiting_pin',
    pinAttempts: 0,
    pinDeadline: Date.now() + 60_000,
    wsToAcs: null,
    openaiClient: null,
    // Raw call transcript for voice/call-memory.js -- populated only once
    // authState reaches 'verified' (see openai-realtime-client.js's
    // handleTranscript), so a spoken PIN attempt never lands in here.
    startedAt: new Date().toISOString(),
    transcript: [],
    // Per-tool-call record for voice/call-memory.js + voice-call-review.js --
    // {name, args, success, error, latencyMs, at}. Populated in
    // openai-realtime-client.js's handleFunctionCall, regardless of
    // authState (though nothing reaches there pre-verification -- see the
    // belt-and-suspenders check in handleFunctionCall itself).
    toolCalls: [],
    // True while an OpenAI Realtime response is in flight (from the moment
    // this bridge sends response.create until that response's response.done
    // arrives) -- see openai-realtime-client.js's createResponse(). Used to
    // avoid firing a "give me a second" filler on top of an already-active
    // response, which the Realtime API is expected to reject.
    responseActive: false,
    // Identity marker for whichever media WebSocket is currently live for
    // this call -- see acs-call-handler.js's attachAcsMediaSocket(). A
    // reconnect replaces this with the new ws; the OLD ws's eventual close
    // event checks against this to tell "this call really ended" apart from
    // "the socket that got replaced is finally tearing down."
    _activeMediaWs: null,
  };
  sessions.set(callConnectionId, state);
  return state;
}

function get(callConnectionId) {
  return sessions.get(callConnectionId) ?? null;
}

function remove(callConnectionId) {
  sessions.delete(callConnectionId);
}

export { create, get, remove };
