/**
 * The Stoplight Elements web-components bundle, pinned.
 *
 * These were previously loaded as `https://unpkg.com/@stoplight/elements/…`,
 * which resolves to *whatever the registry serves at that moment*: no version,
 * no integrity hash, no `crossOrigin`. That is a supply-chain hole with direct
 * access to the dashboard's origin — the script can read the CSRF cookie and
 * make authenticated `/api` calls as the signed-in user.
 *
 * Two properties now hold:
 *
 *  1. **Version pinned.** `/@stoplight/elements@9.0.30/` can only ever serve
 *     that release, so an npm publish cannot change what the browser executes.
 *  2. **Integrity checked.** The SRI hashes below are computed from the exact
 *     files installed from `@stoplight/elements@9.0.30` (see the script in
 *     docs/SECURITY_HARDENING.md). The browser refuses to execute bytes that do
 *     not match, so even a compromised CDN cannot substitute a payload.
 *
 * The package is a devDependency rather than a runtime import on purpose: its
 * v9 line calls `ReactDOM.render`, which React 19 removed, so bundling it breaks
 * the build. It is present in the tree only so the hashes can be regenerated.
 */
const CDN_BASE = 'https://unpkg.com/@stoplight/elements@9.0.30';

export const STOPLIGHT_SCRIPT = {
  id: 'stoplight-elements-js',
  src: `${CDN_BASE}/web-components.min.js`,
  integrity: 'sha384-cUNgzzIq03hUQLuTMVBz8PsfjA7cwqO8gk+69PetkMuIIgt3N/ecXzm+ee34bsgK',
} as const;

export const STOPLIGHT_STYLES = {
  id: 'stoplight-elements-css',
  href: `${CDN_BASE}/styles.min.css`,
  integrity: 'sha384-iVQBHadsD+eV0M5+ubRCEVXrXEBj+BqcuwjUwPoVJc0Pb1fmrhYSAhL+BFProHdV',
} as const;
