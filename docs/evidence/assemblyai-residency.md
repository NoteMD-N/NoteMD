# Live transcription — AssemblyAI residency and controls

AssemblyAI became the primary live-transcription engine on **9 October 2026**,
with Deepgram retained as an automatic fallback. Verified in production the
same day and again on 14 October.

## What was confirmed

| Check | Result |
| --- | --- |
| Primary engine reachable and credential accepted | yes — `streaming.eu.assemblyai.com`, session opened |
| Model in use | `universal-3-5-pro`, pinned explicitly |
| Medical mode | **off**, by the client's decision after testing |
| Fallback engine reachable and credential accepted | yes — `api.eu.deepgram.com`, `nova-3` |
| Deepgram training opt-out present on the issued URL | yes — `mip_opt_out=true` |
| EU endpoint permitted by the browser | yes |
| Each vendor's global endpoint refused by the browser | yes — `connect-src` violation raised |
| Long-lived API key reaching the browser | **no** — short-lived token, 120-second redemption window |

Verified through the in-product diagnostic (Settings → Data residency → Run
check), which opens a real session against the configured vendor from the edge
function's own environment. No audio is sent and the credential is never
returned to the caller — the check reports only the host, the model and whether
the session was accepted.

## Residency, and why the browser enforces it

Audio is streamed from the clinician's browser directly to the vendor. The
Content Security Policy therefore names each vendor's EU host and deliberately
omits their global ones:

    connect-src 'self' https://*.supabase.co wss://*.supabase.co
                https://api.eu.deepgram.com wss://api.eu.deepgram.com
                wss://streaming.eu.assemblyai.com;

This matters more for AssemblyAI than for Deepgram. AssemblyAI's default
endpoint, `streaming.assemblyai.com`, uses **edge routing**: it sends audio to
whichever region is nearest, which includes the United States. Omitting it is
therefore guarding against the vendor's documented default behaviour, not
against a typo on our side.

Observed in production on 14 October, with the browser's own violation events
recorded:

| Endpoint | Result |
| --- | --- |
| `wss://streaming.eu.assemblyai.com` | permitted — session opened |
| `wss://streaming.assemblyai.com` | **blocked** — `connect-src` violation |
| `wss://api.eu.deepgram.com` | permitted by policy; closed by the vendor for lack of a token |
| `wss://api.deepgram.com` | **blocked** — `connect-src` violation |

A misconfiguration pointing live transcription outside the EEA therefore
produces a failed connection, not a silent export.

## Model training exclusion — note the difference between vendors

The two vendors exclude audio from model training by **different mechanisms**,
and the DPIA wording has to reflect that rather than making one statement about
both:

- **Deepgram** is excluded by a parameter we add to every request
  (`mip_opt_out=true`). It is enforced in code, the session endpoint refuses to
  issue a URL without it, and a test asserts the refusal.
- **AssemblyAI** is excluded as a property of their **European data zone**:
  under vendor policy, files processed on the European servers are not used for
  model improvement. There is no per-request parameter. We enforce it by
  refusing to issue a session for any host other than the EU one.

So "the audio is not used for training" is true of both, but is a code-enforced
per-request control in one case and a contractual property of the processing
location in the other.

**Outstanding:** written confirmation from AssemblyAI of the training exclusion
and retention position, and a signed DPA. This is a commercial action for the
data controller, not a technical one.

## Model pinning

`speech_model` is sent explicitly on every session. If it were omitted,
AssemblyAI would select its current flagship — which changed to
`universal-3.6-pro` during this work. An omitted model would mean a vendor
release silently altering clinical transcription with no deployment on our side
and nothing to notice it by. The client tested 3.5 and 3.6 and chose 3.5; the
pin is what makes that choice hold.

## Failover

Deepgram is used automatically when AssemblyAI cannot open a session **at the
start of a consultation**. Mid-consultation switching is deliberately not
attempted: it would leave a seam where a word can duplicate or drop, and a
mid-session drop is already handled by reconnecting to the same vendor.

Both session descriptors are issued together, so falling back costs no second
round trip at the moment a clinician is waiting to begin. If the primary cannot
even be *configured* — token endpoint down, key revoked — the fallback serves
the session instead; an earlier version returned an error in that case and
never reached the healthy fallback.

## Audio format, and why it differs by vendor

Deepgram decodes the WebM/Opus that a browser MediaRecorder produces.
AssemblyAI accepts raw PCM, bare Opus packets, Ogg-Opus or AAC — **not** WebM —
and Chrome cannot produce Ogg. Audio for AssemblyAI is therefore captured as
raw 16 kHz PCM through a Web Audio tap running alongside the recorder.

The recorder is unaffected, so the audio that is **stored, segmented and
re-transcribed is unchanged** by which vendor transcribes it live. This is
relevant to the DPIA only in that it does not alter what is retained or where.

## How to reproduce this evidence

1. Sign in to production as a clinician account.
2. Settings → Data residency → **Run check**.
3. Four blocks are reported: live transcription engine, live transcription
   fallback, enhanced dictation, letter generation. Each gives the provider,
   host, model, region where the provider reports one, HTTP status and latency.

A failure in either live-transcription block means the credential, the model or
the plan is wrong, and live dictation will be failing for clinicians.
