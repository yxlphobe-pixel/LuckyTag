# LuckyTag Known-Answer Test Document

## How should I enable automatic replies safely?

Keep LuckyTag in dry-run mode the first time you enable automatic replies. Allowlist the immutable `channelId` of a dedicated test group, sync a small knowledge directory, and send a new `@` message that should match this document. Disable dry-run only after you have verified the proposed answer, citations, source-message retraction check, human-takeover check, and deduplication behavior.

## What happens when the knowledge base is insufficient?

LuckyTag must not guess when it cannot find a unique, sufficiently reliable source. It should mark the message as `needs_manual` so a person can answer it or improve the authoritative documentation.

## Can an automatic reply become new knowledge automatically?

No. Generated replies are not authoritative evidence and must not be written directly into the QA corpus or knowledge mirror. Only human-reviewed, published documentation or approved standard answers may become sources for future replies.
