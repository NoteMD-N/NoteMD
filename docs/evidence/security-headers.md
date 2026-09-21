# Security response headers — verification

Verified by loading the production build locally with the exact headers
render.yaml serves (`npm run preview` applies them, read from render.yaml so
there is one source of truth).

## Headers served

| Header | Value |
| --- | --- |
| Content-Security-Policy | see below |
| Strict-Transport-Security | `max-age=63072000; includeSubDomains; preload` |
| X-Frame-Options | `DENY` |
| X-Content-Type-Options | `nosniff` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| Permissions-Policy | `microphone=(self)`, everything else denied |
| Cross-Origin-Opener-Policy | `same-origin` |
| Cross-Origin-Resource-Policy | `same-origin` |

## Content Security Policy

    default-src 'self';
    script-src 'self';
    style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
    font-src 'self' data: https://fonts.gstatic.com;
    img-src 'self' data: blob: https://*.supabase.co;
    media-src 'self' blob: https://*.supabase.co;
    connect-src 'self' https://*.supabase.co wss://*.supabase.co
                https://api.eu.deepgram.com wss://api.eu.deepgram.com;
    worker-src 'self' blob:;
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    upgrade-insecure-requests

`script-src` carries neither `'unsafe-inline'` nor `'unsafe-eval'`. The
production build emits a single module script and no inline script, so the
strictest useful value is achievable; this is the directive that actually
constrains cross-site scripting. `style-src` requires `'unsafe-inline'`
because the application styles through React's `style` prop, which produces
inline style attributes — a materially weaker concern than script injection.

## Residency enforced in the browser

The browser streams consultation audio directly to the transcription
provider, so `connect-src` names the EU endpoint and deliberately omits the
global one. Observed in the browser console:

    Connecting to 'wss://api.deepgram.com/v1/listen' violates the following
    Content Security Policy directive: "connect-src 'self'
    https://*.supabase.co wss://*.supabase.co https://api.eu.deepgram.com
    wss://api.eu.deepgram.com". The action has been blocked.

and for the EU endpoint, no violation is raised — the connection is permitted
and closed by the provider for lack of a token.

This means EU residency for transcription does not rely solely on the server
that mints the streaming token. If any future change pointed the stream at a
non-EU region, the browser would refuse the connection rather than silently
sending patient audio outside the EEA.

## Application verified against the policy

Loading the built application with the policy applied produced no Content
Security Policy violations: web fonts loaded (100 faces), stylesheets applied
(4), the hero image rendered, and the Supabase REST endpoint was reachable
(HTTP 401, the expected response for an unauthenticated probe).

## Verified in production — 21 September 2026

Headers applied in the Render dashboard on the `doctor-note-ai` static site,
which serves `notemd.co.uk`. (`render.yaml` is read only on a Blueprint's
initial deploy, so a service created in the dashboard needs them entered
there; this is why they were initially absent.)

Each served value was compared character for character with `render.yaml`:
all seven match on the origin. The HSTS value observed on the
`*.onrender.com` address is Render's own platform default, which takes
precedence on that domain; the custom domain serves the configured value.

Loaded `https://notemd.co.uk` with the policy enforced:

| Check | Result |
| --- | --- |
| Content-Security-Policy present | yes |
| Violations raised by the application | none |
| Web fonts | 100 faces loaded |
| Supabase API | reachable |
| `wss://api.eu.deepgram.com` | permitted |
| `wss://api.deepgram.com` | **blocked by `connect-src`** |

The EU-residency property described above therefore holds in production,
not only in the local preview.

Note on rollout: `notemd.co.uk` responses carry `s-maxage=300`, so the edge
serves previously cached copies — without the new headers — for up to five
minutes after a change. An uncached path returned the new headers immediately.

**Not yet exercised under the production policy:** the signed-in clinical
flow — live dictation, audio playback on the letter view, and letter
generation. These use only origins the policy permits and were exercised
against the same policy locally, but a single end-to-end consultation in
production is the check that would close this completely.
