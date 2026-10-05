# AI provider — Azure OpenAI cutover

Production cut over on **5 October 2026** from OpenAI direct to the client's
Azure OpenAI resource `notemd-eu`. Verified in production the same day.

## What was confirmed

| Check | Result |
| --- | --- |
| Enhanced dictation reaches Azure | yes — `notemd-eu.openai.azure.com`, HTTP 200 |
| Transcription deployment answers | yes — `gpt-4o-transcribe` |
| Letter generation reaches Azure | yes — `notemd-eu.openai.azure.com`, HTTP 200 |
| Letter deployment answers | yes — `gpt-4o` |
| Processing region, from Azure's own response header | **France Central**, both paths |
| Live transcription unchanged | Deepgram EU (`api.eu.deepgram.com`, `eu-central-1`) |
| Deepgram retention opt-out still applied | yes |
| Stripe webhook unaffected by the function redeploys | yes — `verify_jwt = false` intact |

Verified through the in-product residency diagnostic
(Settings → Data residency → Run check), which probes each provider from the
edge function's own environment. No operator handles a credential to run it,
the probe sends a generated 440 Hz tone rather than patient data, and the
credential is never returned to the caller — only the host, the model or
deployment name, and the region.

The region is read from Azure's `x-ms-region` response header, so residency is
**evidenced by the provider** rather than asserted from our configuration.
This is the value to cite in the DPIA.

## Residency position

The client's instruction was to prefer a UK regional deployment. UK South does
not host the required models, so the working resource is in **France Central**.
France is in the EEA and the UK recognises the EEA as adequate, so the transfer
is lawful — but it is a departure from the UK-only position in the original
specification and must be **recorded in the DPIA as a decision, not assumed**.

The pilot Trust should be asked early whether it has a UK-only requirement.
That is far cheaper to discover now than at DTAC review.

## Open risk: the transcription model retires mid-pilot

`gpt-4o-transcribe` is **retired by Microsoft on 31 December 2026**. Clinical
dictation now runs on it.

`gpt-transcribe` is supported until 2028 and additionally accepts **keyword
hints** as a dedicated parameter. That matters beyond the retirement date:
clinical vocabulary is currently supplied through the `prompt` field, and
prompt-stuffing is the mechanism by which the model returns drug names back as
fabricated dictation when there is little or no speech. Keyword hints remove
that cause; the current server-side checks only reject the symptom.

**Action on the client:** create a `gpt-transcribe` deployment on `notemd-eu`.
Our side is then one environment variable
(`AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT`), with no code change.

Changing transcription model re-opens clinical validation, so it is better
done once, now, than twice — before the pilot rather than during it.

## Two configuration points still outstanding

**Staging is still on OpenAI direct.** No Azure secrets are set on the staging
project, so staging and production now exercise **different AI providers**.
Local development and testing point at staging by design, which means neither
is currently a faithful rehearsal of production for anything AI-related. This
should be resolved before the pilot.

**Both environments would share one resource.** The client's own requirement is
separate credentials per environment. `notemd-eu` is presently the only
resource with deployments, so pointing staging at it would satisfy provider
parity while breaching credential separation. A second resource — or at least
separate keys — is the correct end state.

## How to reproduce this evidence

1. Sign in to production as a clinician account.
2. Settings → Data residency → **Run check**.
3. Three blocks are reported: live transcription, enhanced dictation, letter
   generation. Each gives host, model or deployment, region, HTTP status and
   latency.

A 404 on either AI block means the deployment name does not exist on the
resource. The diagnostic treats that as a **failure rather than an
inconclusive result**, specifically so a misnamed deployment cannot pass a
check whose purpose is to catch it.

## Reversibility

The cutover is configuration, not a release. Unsetting `AZURE_OPENAI_API_KEY`
returns both paths to OpenAI direct within seconds, with no deploy.

A key that is present but unusable — a placeholder, a truncated paste, a
revoked or wrongly-scoped credential — is treated as **unconfigured** and falls
back to OpenAI rather than failing every clinical request, and the fallback is
logged. This guard exists because a literal placeholder was stored as the
production key during this cutover and briefly took the AI paths down; the
same class of fault had previously affected the email path.
