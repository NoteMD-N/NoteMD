/**
 * Catching transcription output that was not spoken.
 *
 * Whisper-family models, which include the GPT transcription models, are
 * trained on continuous speech and do not return nothing when given nothing.
 * On silence or near-silence they emit plausible text. Two specific failures
 * are common enough to be worth detecting on the server, after the client has
 * already declined to send audio it measured as silent:
 *
 *   1. **Prompt echo.** A biasing prompt improves accuracy on clinical
 *      vocabulary, but when there is no speech the model has nothing else to
 *      condition on and returns the prompt itself as though it had been
 *      dictated. Ours is a list of drug names and abbreviations, which would
 *      appear in a letter as a convincing fragment of clinical content.
 *
 *   2. **Degenerate repetition.** With no signal the decoder can lock into a
 *      loop, repeating one short phrase.
 *
 * Both are rejected rather than cleaned up. A transcript the clinician can see
 * is empty is safe; one quietly edited is not, and the clinician cannot tell
 * which words were theirs.
 */

/** Lower-cased, punctuation-stripped, whitespace-collapsed. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the transcript is substantially the biasing prompt returned back.
 *
 * Compares word overlap rather than looking for the prompt verbatim, because
 * the model paraphrases, reorders and truncates it. The threshold is high: a
 * genuine dictation mentioning two or three of these drugs must not be
 * discarded, so a transcript only fails when most of what it contains came
 * from the prompt.
 */
export function looksLikePromptEcho(transcript: string, prompt: string): boolean {
  const words = normalise(transcript).split(" ").filter(Boolean);
  if (words.length === 0) return false;

  // Too short to judge by overlap — a handful of words that happen to be drug
  // names is a plausible real dictation.
  if (words.length < 6) return false;

  const promptWords = new Set(normalise(prompt).split(" ").filter(Boolean));
  if (promptWords.size === 0) return false;

  const fromPrompt = words.filter((w) => promptWords.has(w)).length;
  return fromPrompt / words.length >= 0.8;
}

/**
 * True when the transcript is one short phrase repeated.
 *
 * Requires several repetitions and a short unit, so clinically legitimate
 * repetition — "no chest pain, no shortness of breath, no palpitations" —
 * is not caught.
 */
export function looksDegenerate(transcript: string): boolean {
  const normalised = normalise(transcript);
  const words = normalised.split(" ").filter(Boolean);
  if (words.length < 12) return false;

  for (let unit = 1; unit <= 5; unit++) {
    if (words.length < unit * 4) continue;
    const phrase = words.slice(0, unit).join(" ");
    let repeats = 0;
    for (let i = 0; i + unit <= words.length; i += unit) {
      if (words.slice(i, i + unit).join(" ") === phrase) repeats++;
      else break;
    }
    // The same unit four times over, covering most of the text.
    if (repeats >= 4 && (repeats * unit) / words.length >= 0.8) return true;
  }
  return false;
}

export type TranscriptVerdict =
  | { usable: true; text: string }
  | { usable: false; reason: "empty" | "prompt_echo" | "degenerate" };

/**
 * Decides whether transcription output should be used.
 *
 * Returning a reason rather than a boolean so the audit trail records why a
 * transcript was discarded. A clinician seeing nothing has to know it was
 * rejected, not assume the system simply missed what they said.
 */
export function assessTranscript(text: string, prompt: string): TranscriptVerdict {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { usable: false, reason: "empty" };
  if (looksLikePromptEcho(trimmed, prompt)) return { usable: false, reason: "prompt_echo" };
  if (looksDegenerate(trimmed)) return { usable: false, reason: "degenerate" };
  return { usable: true, text: trimmed };
}
