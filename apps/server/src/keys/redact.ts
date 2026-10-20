import { RAW_KEY_PATTERN } from './format.js';

/**
 * Scrub raw API keys out of anything that might get logged or returned to a
 * client.
 *
 * The regex is the safety net, not the primary defence — the primary defence
 * is that `verifyKey` returns a context object and the raw string is dropped
 * immediately. This catches the paths where a raw key could otherwise slip
 * through: a thrown error message, a pino payload, a SQL debug log.
 *
 * The pattern is rebuilt per call because a shared global regex carries
 * `lastIndex` state between calls and would skip matches.
 */
export function redact(text: string): string {
  if (!text) return text;
  return text.replace(new RegExp(RAW_KEY_PATTERN.source, 'g'), 'sk_***');
}

/**
 * Redact a value that may be a key or may contain one. Used for headers and
 * structured log fields where the type is not known up front.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  return value;
}
