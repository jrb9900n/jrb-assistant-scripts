// tools/impl/openai-voice.js — OpenAI Whisper (speech-to-text) + TTS
// (text-to-speech) for Teams voice memos. Michael chose OpenAI for both
// directions over Azure Speech specifically so voice-in and voice-out share
// one vendor/one credential (see CLAUDE.md's Teams Voice Messages section).
//
// Both functions degrade to null on any failure (missing key, bad audio,
// network error) rather than throwing -- callers should skip the voice
// feature on null, not fail the whole message handling over it.

import { logger } from '../../core/logger.js';

const OPENAI_API_KEY = () => process.env.OPENAI_API_KEY;

// OpenAI's TTS endpoint rejects input over 4096 characters -- a long agent
// reply needs truncating before synthesis, not just failing outright.
// Exported so callers can pre-truncate `text` before passing it to both
// synthesizeSpeech() and replyToTeamsWithAudio(), keeping the displayed
// text and spoken audio in sync (Finding 4).
export const TTS_MAX_INPUT_CHARS = 4000;

/**
 * Transcribe a voice memo to text via OpenAI's Whisper API.
 * @param {object} params
 * @param {Buffer} params.audioBuffer - Raw audio bytes as downloaded from Teams.
 * @param {string} [params.mimeType] - Attachment's contentType (e.g. 'audio/mp4').
 * @param {string} [params.filename] - Filename hint; extension drives OpenAI's format detection.
 * @returns {Promise<string|null>} Transcribed text, or null if unavailable/failed.
 */
export async function transcribeAudio({ audioBuffer, mimeType, filename = 'voice-memo.mp4' }) {
  const key = OPENAI_API_KEY();
  if (!key) {
    logger.warn('transcribeAudio: OPENAI_API_KEY not configured, skipping transcription');
    return null;
  }
  if (!audioBuffer?.length) return null;

  try {
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/mp4' }), filename);
    form.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn('transcribeAudio: OpenAI request failed', { status: res.status, body: body.slice(0, 300) });
      return null;
    }
    const data = await res.json();
    return data.text?.trim() || null;
  } catch (err) {
    logger.warn('transcribeAudio: request failed', { err: err.message });
    return null;
  }
}

/**
 * Synthesize speech from text via OpenAI's TTS API.
 * Input is truncated to TTS_MAX_INPUT_CHARS before synthesis. Callers should
 * pre-truncate using TTS_MAX_INPUT_CHARS so the displayed reply text also
 * reflects the truncation (keeping spoken and displayed content in sync).
 * @param {string} text
 * @returns {Promise<Buffer|null>} MP3 audio bytes, or null if unavailable/failed.
 */
export async function synthesizeSpeech(text) {
  const key = OPENAI_API_KEY();
  if (!key) {
    logger.warn('synthesizeSpeech: OPENAI_API_KEY not configured, skipping synthesis');
    return null;
  }
  const input = (text || '').trim().slice(0, TTS_MAX_INPUT_CHARS);
  if (!input) return null;

  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: 'alloy', input, response_format: 'mp3' }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn('synthesizeSpeech: OpenAI request failed', { status: res.status, body: body.slice(0, 300) });
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn('synthesizeSpeech: request failed', { err: err.message });
    return null;
  }
}
