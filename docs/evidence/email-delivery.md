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
