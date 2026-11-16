import type { FastifyReply } from 'fastify';
import { config, isProduction } from '../config.js';
import { generateSessionToken } from './token.js';
import { CSRF_COOKIE, SESSION_COOKIE } from './session.js';

/**
 * Cookie attributes, in one place.
 *
 * Every attribute that scopes a cookie (`path`, `domain`) has to match
 * exactly when the cookie is cleared, or the browser treats the clear as a
 * different cookie and keeps the old one. Logout used to clear without the
 * production domain, so it never actually removed anything there.
 */
const scope = {
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
  domain: isProduction ? config.COOKIE_DOMAIN : undefined,
} as const;

/** The session cookie: httpOnly, the browser's credential. */
export function setSessionCookie(reply: FastifyReply, token: string, expires: Date): void {
  reply.setCookie(SESSION_COOKIE, token, { ...scope, httpOnly: true, expires });
}

/**
 * The CSRF cookie is deliberately readable by JavaScript — the client copies
 * it into the `X-CSRF-Token` header on every mutation.
 *
 * It expires with the session. It used to be a browser-session cookie while
 * the session cookie lasted 7 days, so after a browser restart the session
 * survived and the CSRF token did not, and every mutation — logout included
 * — failed with 403.
 */
export function setCsrfCookie(reply: FastifyReply, token: string, expires?: Date): void {
  reply.setCookie(CSRF_COOKIE, token, {
    ...scope,
    httpOnly: false,
    ...(expires ? { expires } : {}),
  });
}

/** Issue a fresh CSRF token, for a session whose CSRF cookie has gone missing. */
export function reissueCsrfCookie(reply: FastifyReply, expires?: Date): void {
  setCsrfCookie(reply, generateSessionToken(), expires);
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, scope).clearCookie(CSRF_COOKIE, scope);
}
