# Unreleased OAuth reliability candidate

This is a local pre-merge preparation note, not a publication or tag. It combines the work from PR #19 (Petr Bondarev / bondarevpm-tech) with the state-safety repairs in PR #20 and the additional local pre-merge fixes below. The six contributor commits remain unchanged in ancestry.

## Release version decision

The owner repository's newest release and tag is v0.13.1. The current package version 0.13.6 was inherited from the unmerged contributor branch; there is no owner release/tag evidence for v0.13.2 through v0.13.6. This local candidate leaves package.json unchanged to avoid silently making a release decision. Before merge/release, either normalize the cumulative candidate to the next owner patch version (recommended v0.13.2) or explicitly adopt v0.13.6 and explain the skipped versions. Do not infer owner releases from contributor deployment claims. No automatic bump to v0.13.7 is justified.

## Changes for an eventual owner release

- RFC 8707 resource binding on OAuth authorization, token exchange and refresh, using protected-resource metadata.
- Explicit callback-origin allowlist, HTML-escaped callback messages, and bracketed IPv6 loopback support.
- Single-flight refresh and shared all-writer locking, atomic private state replacement, and changed-field merging that preserves other processes' rotated pairs.
- Adoption and comparison-snapshot rebasing of newer persisted OAuth, including an expired access token; persisted permanent failures stop token replay.
- Referenced lock waits, live-owner protection, serialized stale-lock reclamation, and fail-closed behavior after rotation cannot be persisted.
- Startup uses the existing immediate restore/reconnect path; the redundant delayed loop no longer resurrects disabled/deleted servers.
- Additional pre-merge local fixes: FIFO lock ownership prevents same-process save reordering; duplicate-ID migration retains exactly the repaired rows; failed enable/disable persistence restores the previous local flag so a retry works.
- README install examples point to the existing v0.13.1 stable tag. This candidate is not advertised as already released.

## Integration with independently handled issue #21

Issue #21's planned `application_type: native` belongs in the dynamic registration request object in ensureClientId (`lib/index.js`, next to client_name / grant_types / redirect_uris). This candidate does not add that field or duplicate its tests. Apply the #21 change after the state-safety repairs, retain the awaited persistServer call, and jointly run oauth-discovery, oauth-resource and real Loader validation. Test both a new registration and reuse of a cached registration, plus the manual Client ID path which must continue to bypass registration. Both work streams touch lib/index.js and OAuth tests; contextual conflicts must retain resource parameters and exact callback URIs.

## Verification and limits

The committed #20 head is 8fdf5416ef59e76873411aff74cd83e7e7fa60c3, based on unchanged main 5bf55ceb260d067c22c3b2e3183ec85d4dbb5301 and original #19 head 9d0c6a42e6dadc4d2630160d31cb38aacd7a2b68. Fresh pre-merge baseline tests passed 139/139 on macOS Node22.23.2 and Node26.8.2. Three additional local regressions failed that exact remote source before repair. Current candidate check results are recorded in the separate premerge-20261023 review report; they are not claims about the unmodified remote PR.

Keep the existing limits explicit: real-provider browser consent, Windows and Node24 are unverified; DSH0.2.1-rc.2 Loader smoke is outside the declared <0.2.0 compatibility interval; the full compatibility matrix is not established. Orphaned reclaimer guards need verified manual recovery. File-lock acquisition times out after25s; waiting for earlier in-process FIFO owners is additional time. Process death after provider rotation but before durable save, permanent storage failure, and old clients ignoring the new lock remain recovery limitations. lastToolOkAt includes generic RPC success and workspace views expose fewer OAuth health fields.
