# Wrong-patient and concurrency testing

Reviewed 17 September 2026 against the scenarios in item 7. Each was examined
in the code paths that implement it, and the outcome recorded below. Two
defects were found and fixed; the guards for both are covered by
`src/test/session-isolation.test.ts` and `src/test/local-phi.test.ts`.

The objective throughout: prevent wrong-patient correspondence, cross-patient
transcript or letter association, duplicate correspondence, incomplete
transcripts being treated as complete, and unapproved output being sent.

---

## Scenario results

| # | Scenario | Before | Now |
| --- | --- | --- | --- |
| 1 | Patient A and Patient B open in different tabs | **Defect — F-006** | Fixed |
| 2 | Multiple consultations simultaneously open | **Defect — F-006** | Fixed |
| 3 | Starting dictation against one patient and switching to another | Safe | Safe |
| 4 | Generating a letter while another patient's page becomes active | **Defect — F-007** | Fixed |
| 5 | Browser refresh during transcription | Safe | Safe |
| 6 | Browser back / forward during transcription | Safe | Safe |
| 7 | Interrupted transcription | Safe, with a warning | Safe |
| 8 | Partial transcript | Safe | Safe |
| 9 | Failed AI generation | Safe | Safe |
| 10 | Double-clicking Generate | At risk | Fixed |
| 11 | Double-clicking Approve / Send | At risk | Fixed |
| 12 | Failed email followed by retry | Safe | Safe |
| 13 | Stale patient / session context | **Defect — F-007** | Fixed |
| 14 | Expired session during transcription or generation | Safe | Safe |

---

## Defects found

### F-006 — Two consultations in different tabs overwrote each other

The crash-recovery snapshot was held at one `localStorage` key per user.
That storage is shared by every tab on the origin, so two consultations open
side by side wrote to the same slot roughly every three seconds. One session
was lost outright, and the survivor could be offered back in the other tab
under a different patient's name.

Fixed by naming slots per tab, using an identifier held in `sessionStorage`.
A snapshot left by a tab that has since closed is still recoverable — the
mount path falls back to the freshest slot belonging to the same user, and
says on screen that it came from a different tab. The patient name is now
stated first in that prompt, with its absence spelled out rather than rendered
as an empty gap, because that name is the only thing a clinician can check a
recovered transcript against before restoring it.

### F-007 — A late transcription result could land in the next patient's transcript

Segment transcription is deliberately fire-and-forget: a ten-second slice of
audio is uploaded, transcribed, and its text appended to the live transcript
when it returns. Before moving to the review screen the recorder waits for
outstanding segments — **but only for eight seconds**, after which it
proceeds.

So a slow segment could still be in flight when the clinician had finished,
generated the letter, and started recording the next patient. When it landed
it appended to whatever transcript was current by then: one patient's spoken
words in another patient's transcript, and from there into their letter.

Fixed with a session token, rotated whenever a recording starts. Each segment
captures the token when it begins and discards its result if the session has
changed. The same guard is applied to the streaming path, because a provider
commonly emits one last final result as the stream closes and the socket is
not torn down until cleanup runs.

The defect is demonstrated directly in the test file — the unguarded model is
shown producing the cross-contamination, then the guarded one refusing it —
so the test proves the behaviour rather than asserting the fix is present.

### Double submission (scenarios 10 and 11)

Both Generate and Send relied on a state flag to disable their button. React
may not have flushed that render between two fast clicks. Both now use a ref
checked and set synchronously on click, so the guard does not depend on render
timing.

The consequences differ and both matter: a duplicated generation writes a
second recording row and a second letter for one consultation; a duplicated
send produces clinical correspondence that cannot be recalled.

---

## Scenarios that were already safe, and why

**Switching patient mid-recording (3).** The patient name and identifier
fields are disabled whenever `isRecording` or `processing` is true, so the
identity attached to a transcript cannot change while it is being captured.
They are editable again at the review screen, which is intentional: the
clinician is looking at the transcript and the patient together at that point,
and correcting a mistyped identifier before generation is the desired
behaviour.

**Refresh, back and forward during transcription (5, 6).** The transcript is
snapshotted to browser storage every three seconds and mirrored to the server
as a draft every fifteen. After a refresh the session is offered back by the
recovery prompt. Drafts also appear in the Recordings list, which is what
made the earlier "lost session on back button" reports recoverable.

**Interrupted transcription and partial transcripts (7, 8).** A disconnect
during recording is recorded in `hadDisconnectRef` and the review screen warns
the clinician explicitly that the connection dropped, so a short transcript is
not silently treated as a complete one. The clinician reads the transcript on
the review screen before any letter is generated.

**Failed generation (9).** Generation failures surface as an error and leave
no letter row; the recording remains and can be retried. The realtime
subscription that acts as a backstop when a response is dropped is guarded by
`navigateOnce`, so a letter arriving by both routes navigates once rather than
twice.

**Failed email then retry (12).** Sending is now refused unless the letter has
been reviewed, and a failure is recorded as a `letter.email_failed` audit
event with the reason. A retry after a genuine failure is the correct action;
the in-flight guard prevents the accidental double-send.

**Expired session during transcription or generation (14).** A revoked or
expired session cannot be refreshed — verified in the cross-user suite against
a live database. Server calls made with an expired token are rejected by Row
Level Security rather than partially applied, and the inactivity timeout
suspends itself while a recording is in progress so a clinician is never
signed out mid-consultation.

---

## Scope note

This was a functional and code-level review, as agreed, not an automated
browser test suite. The guards introduced for F-006, F-007 and double
submission are covered by unit tests that model the failing behaviour, so
those specific defects cannot recur silently. Full multi-tab behaviour is not
exercised automatically; that would need the browser harness which was
deliberately left out of scope.
