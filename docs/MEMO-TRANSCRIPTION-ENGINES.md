# Transcription engines — current position and a recommendation

**NoteMD · 5 October 2026 · for Mohamed Mustafa**

You asked which version of Deepgram we are using, and whether to replace it
with AssemblyAI Universal-3.5 Pro. The direct answer is below, followed by
three findings that I think change what the next step should be.

**In short**

1. Enhanced dictation is Azure OpenAI, not Deepgram — so please confirm which
   mode you were testing. Replacing Deepgram would not affect it.
2. Our Deepgram setup has no keyword boosting at all and is a generation
   behind. Both are cheap to fix and may be most of the problem.
3. Measure before migrating. Send me the audio and I will give you numbers
   rather than three vendors' claims.
4. Hold the `gpt-transcribe` Azure deployment until the engine decision is
   made, so clinical validation is done once rather than twice.

---

## 1. What is running today

| Path | Engine | Where it processes |
| --- | --- | --- |
| **Enhanced dictation** | Azure OpenAI `gpt-4o-transcribe` | France Central |
| **Usual recordings** (consultation mode, and dictation set to "fast") | Deepgram `nova-2-medical` | EU (`api.eu.deepgram.com`) |
| Letter generation | Azure OpenAI `gpt-4o` | France Central |

Deepgram is called with `model=nova-2-medical`, `language=en-GB`,
`smart_format=true`, `punctuate=true` and `mip_opt_out=true` (the opt-out from
vendor model training, applied to every request without exception).

**Enhanced dictation does not use Deepgram at all.** If the accuracy you were
judging was in enhanced dictation, replacing Deepgram would change nothing.
Before any decision, it is worth confirming which mode you were testing — the
two paths share no transcription code.

---

## 2. Three findings

### We are a generation behind on Deepgram

`nova-3-medical` is available, supports `en-GB`, and runs on the EU endpoint we
already use. Moving to it is a one-line configuration change with the same key
and the same residency position.

### We are not using keyword boosting at all

This is the one I would want you to notice. Deepgram supports boosting specific
vocabulary — drug names, abbreviations, dosing terms — so the model is far more
likely to get them right. **We have none of it configured.** Not the older
`keywords` parameter, not Nova-3's `keyterm` prompting, which accepts up to 100
clinical terms.

For medical dictation this is the cheapest accuracy lever available, and it is
currently untouched. It is quite likely a real part of what you are perceiving
as below standard.

### AssemblyAI is not blocked on data residency

I checked this specifically, because it would have been a showstopper. It is
not: Universal-3.5 Pro is available on AssemblyAI's EU endpoint, including
real-time streaming, with data kept in the EU. If the accuracy case holds up,
residency is not an obstacle.

---

## 3. The architectural question underneath

Two problems have come up in two days: dictation inventing content on quiet
audio, and dictation missing whole passages. Both are fixed and deployed. But
both are *consequences of the same design choice*, and that is worth putting in
front of you rather than leaving as an implementation detail.

Enhanced dictation uses a GPT-family transcription model. These models are
generative, which gives them their accuracy on difficult speech — and also
means:

- **Given silence, they produce fluent invented text.** This is inherent to the
  model family, not a defect in our configuration. Deepgram's models do not do
  this; they return nothing when there is nothing. Our current safeguards
  detect and discard fabricated output. A different engine would remove the
  cause rather than filter the symptom.
- **They cannot stream.** So we cut the audio into ten-second pieces and
  transcribe them concurrently. Everything that went wrong last week —
  passages lost, sentences arriving out of order — comes from that. We now
  sequence, retry, detect gaps and re-transcribe the whole recording when one
  is found. It works, but it is machinery built to compensate for the engine
  being batch-only.

It also means the clinician waits 10–15 seconds for the first text to appear.

---

## 4. Options

**A. Keep enhanced dictation as it is.** No work. Retains the highest raw
accuracy on difficult speech. Keeps the hallucination risk (mitigated, not
eliminated) and the segmented architecture. Also keeps us on
`gpt-4o-transcribe`, which Microsoft retires on **31 December** — mid-pilot —
so a model change is required regardless.

**B. Move enhanced dictation to Deepgram `nova-3-medical` with keyterm
prompting.** Live text instead of a 10–15 second wait. Removes the
hallucination mechanism and the entire segmented pipeline. Lower cost. The open
question is whether accuracy holds up — and if it does, "enhanced" and "fast"
become much the same thing, which is a product decision for you.

**C. Both, in sequence — my recommendation.** Deepgram streams the text live
during the consultation; when the clinician stops, the complete recording goes
through the higher-accuracy model **once**, and that becomes the final
transcript.

Option C gives immediate feedback during dictation, keeps the best available
accuracy for the transcript that becomes the letter, and replaces thirty
concurrent requests with one. It also sharply reduces the hallucination risk,
because a single pass over a full recording containing real speech is far less
prone to invention than thirty passes of which several may be near-silent.

---

## 5. What would decide it

Whether `nova-3-medical` with proper clinical keyterms closes the accuracy gap.
That single measurement answers your AssemblyAI question too.

The test: the same audio through `nova-2-medical` (what you have now),
`nova-3-medical` with keyterms, and `gpt-4o-transcribe`, scored on word error
rate for clinical terms specifically rather than overall — a transcript can
read well and still get the drug wrong.

**What I need from you:** a representative audio sample, ideally one of the
recordings where you judged accuracy to be below standard. Your judgement is
what we are measuring against, so your audio is the right benchmark.

I will include AssemblyAI in that comparison if you want it. Worth being clear
that a vendor migration costs more than the integration: a new data processing
agreement, a new sub-processor in the DPIA, fresh residency evidence, separate
key management, and re-running clinical validation. Worth paying if Deepgram
properly configured still falls short — an expensive way to discover we had
simply not configured the current vendor fully.

**One sequencing point.** You were going to create a `gpt-transcribe`
deployment on the Azure resource, which is still needed before 31 December if
enhanced dictation stays on that engine. **Please hold that until this is
decided.** If dictation moves to Deepgram, the deployment and its clinical
validation are not needed — and validation is the expensive part, so it is
worth doing once rather than twice.
