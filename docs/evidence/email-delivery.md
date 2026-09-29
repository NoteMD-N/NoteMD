# Clinical email delivery — ACS verification

Verified on staging, 29 September 2026, against the client's live
`Emails-NoteMD` resource (data location: **UK**).

## What was confirmed

| Check | Result |
| --- | --- |
| HMAC request signing accepted by ACS | yes |
| Approval gate refuses an unreviewed letter | yes — HTTP 409, audited as `denied` |
| Reviewed letter accepted for delivery | yes, operation id returned |
| Delivery outcome resolved before reporting to the clinician | yes |
| Duplicate send suppressed | yes — one operation, second call reports `already_sent` |
| Deliberate resend after an edit | still permitted |
| Audit metadata (provider, recipients, operation id, status) | recorded |
| Real delivery to an external mailbox | **arrived, in the junk folder** |

## Finding: the Azure managed domain is not usable for clinical mail

A synthetic letter sent from the Azure managed domain
(`DoNotReply@<guid>.azurecomm.net`) to an external Microsoft mailbox arrived
in **junk**.

This is the expected result and not a fault. The sender has no relationship to
notemd.co.uk, so SPF and DKIM cannot align with it, and the domain has no
sending reputation. notemd.co.uk additionally publishes `DMARC p=quarantine`,
which instructs receivers to treat unaligned mail exactly this way.

**A custom sending subdomain is therefore a prerequisite for any real use,**
not an optional improvement. Required before the pilot:

1. Provision `mail.notemd.co.uk` as a custom domain on the Email
   Communication Service.
2. Add the records Azure issues to GoDaddy DNS: domain verification (TXT),
   SPF (TXT), and two DKIM CNAMEs.
3. Connect the verified domain to the `Emails-NoteMD` resource and set the
   sender, e.g. `letters@mail.notemd.co.uk`.
4. Request a sending quota increase; new domains start with low limits.
5. Re-run this verification and confirm the message reaches the inbox.

Because notemd.co.uk uses relaxed DMARC alignment (`adkim=r`, `aspf=r`), DKIM
signed as `mail.notemd.co.uk` aligns with the organisational domain, so a
correctly configured subdomain should pass DMARC.

## Clinical-safety consideration

A letter that silently lands in a recipient's junk folder is a clinical-safety
issue rather than a technical one: the sender believes it was delivered and
the recipient never sees it. Two points follow.

- **ACS reports "Succeeded" when it accepts and dispatches a message.** A
  bounce or a junk placement happens afterwards and is not visible to NoteMD.
  The application therefore reports "sent", never "delivered".
- **Bounce handling is not implemented.** ACS can report delivery outcomes via
  Event Grid; wiring that up would let a failed delivery be surfaced to the
  clinician and recorded in the audit trail. It is not currently in scope and
  should be a deliberate decision before the pilot.

For NHS recipients specifically, deliverability from any third-party domain is
uncertain, and a Trust will generally expect NHSmail or an approved secure
pathway for patient-identifiable correspondence. This result is concrete
evidence for raising that question early rather than at DTAC review.


## Authentication verified — 29 September 2026

Message sent from the linked custom domain and analysed by an independent
third-party checker. Headers as received:

    Received-SPF: Pass (mailfrom) identity=mailfrom;
      envelope-from=donotreply@mail.notemd.co.uk;
      helo=cwxp265cu009.outbound.protection.outlook.com
    Authentication-Results: dkim=pass (2048-bit key)
      header.d=mail.notemd.co.uk header.i=@mail.notemd.co.uk
      header.a=rsa-sha256 header.s=selector1-azurecomm-prod-net
    Authentication-Results: dmarc=none (p=none dis=none)
      header.from=mail.notemd.co.uk
    From: DoNotReply <DoNotReply@mail.notemd.co.uk>

| Mechanism | Result |
| --- | --- |
| SPF | **pass** |
| DKIM | **pass**, 2048-bit, selector1 |
| DMARC | **none** — no policy found for the sending subdomain |

Overall deliverability score 7/10, the only deduction being -3 for
authentication, attributable entirely to the DMARC result.

### Finding: DMARC policy is not being inherited in practice

`notemd.co.uk` publishes `p=quarantine`, and RFC 7489 requires a receiver that
finds no record at the sending subdomain to fall back to the organisational
domain's policy. The independent checker did not do this, reporting `p=none`.
Receivers vary here, and this is the most likely reason a message with passing
SPF and DKIM was still filed as junk.

**Remedy:** publish an explicit record at `_dmarc.mail.notemd.co.uk` rather
than relying on inheritance:

    v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net

This should be re-tested after the record propagates, and the result recorded
here.


## Final state — 29 September 2026

After adding an explicit DMARC record at `_dmarc.mail.notemd.co.uk`, a further
test message still arrived in the junk folder of a personal Outlook mailbox.

### Configuration: verified complete

| Control | Status | How verified |
| --- | --- | --- |
| SPF | pass | observed in received headers |
| DKIM | pass, 2048-bit, aligned | observed in received headers |
| DMARC record | valid, `p=quarantine`, relaxed alignment | published and resolving on four public resolvers |
| DMARC alignment | both mechanisms match the From domain | `header.d` and envelope-from are both `mail.notemd.co.uk` |
| External report authorisation | published | `mail.notemd.co.uk._report._dmarc.onsecureserver.net` |

No configuration defect remains that could be identified.

### Not yet confirmed

A `dmarc=pass` verdict has not been observed on a message sent *after* the
policy was published. Alignment and policy make it the expected outcome, but
that is inference, not observation. Two ways to close it:

- read `Authentication-Results` from a received test message, or
- read the DMARC aggregate reports, which state pass rates directly and
  arrive within roughly 24 hours.

### Assessment

The residual cause is most likely **sender reputation**. The domain sent its
first message the same day, and large consumer providers weight sending
history heavily regardless of authentication quality. Reputation builds over
weeks of consistent, low-volume sending and cannot be fixed with further DNS
changes.

### Consequence for the pilot

This is the substantive finding, and it is a clinical-safety matter rather
than a deliverability inconvenience: **a letter filed into a recipient's junk
folder is not seen, while the sender believes it was sent.** NoteMD has no
visibility of junk placement, and bounce handling is not implemented.

If reaching a personal Outlook mailbox requires this much work, reaching NHS
mail systems reliably from a new third-party domain is a material risk. The
options, in the order they should be considered:

1. **NHSmail or the Trust's approved secure pathway** for patient-identifiable
   correspondence. This is what a Trust is likely to require in any case.
2. **Export into the Trust's clinical record** rather than email, which is the
   workflow the client has already described as preferred.
3. **Email as a convenience channel only**, with the clinician told explicitly
   that delivery is not confirmed.

Sending clinical letters from a newly provisioned domain, without bounce
handling, should not be relied upon for the pilot.
