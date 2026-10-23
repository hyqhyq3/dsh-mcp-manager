> Historical validation of the original #20 head. The integrated local candidate is now0.13.2; see [cumulative release notes](release-v0.13.2.md). The0.13.6 references below describe the original contributor metadata, not an owner release.

# OAuth state safety review validation

This candidate retains the six original commits from [PR #19](https://github.com/hyqhyq3/dsh-mcp-manager/pull/19), authored by Petr Bondarev / bondarevpm-tech, and adds the local review repairs. Original source head: `9d0c6a42e6dadc4d2630160d31cb38aacd7a2b68`; reviewed main: `5bf55ceb260d067c22c3b2e3183ec85d4dbb5301`. Original PR remains separate. No issue is closed by this candidate.

## Reproduced and repaired

- Adopt the newest disk refresh token even when its access token has expired; do not replay the spent in-memory token.
- Use the same lock for refresh and all state/configuration writes. Merge actual local field changes into fresh disk state, preserving another process's server/workspace tokens and unknown settings.
- Rebase the local comparison snapshot after adopting remote OAuth, so a later settings save does not roll back another rotation.
- Respect another process's persisted permanent OAuth error; stop replaying the token.
- Keep lock wait timers referenced so a fresh child process cannot exit while its top-level await is pending.
- Preserve live lock owners regardless of age; reclaim aged dead/incomplete owners through an exclusive reclaimer guard.
- After a successful rotation cannot be persisted, keep the new access token in memory and fail closed on further refresh until successful reauthorization.
- Parse bracketed IPv6 loopback callback hosts correctly.
- Remove the added delayed startup restore loop: the existing immediate startup/reconnect path already restores servers, and the extra loop resurrected disabled/deleted servers.

The original head passed its existing 122 tests. Five initial new reproductions all failed on that head; the expanded original-head set had ten failures and one passing unload control. Two later regressions caught issues in the first repair: adopted-token snapshot rollback, and repeated spent-token replay after an injected state-write failure. The final test set includes 17 additional review regressions, including real child processes sharing one state file, competing stale-lock reclaimers, and persistence fault injection.

## Validation (macOS, 2026-10-22)

| Check | Evidence |
| --- | --- |
| Full `node --test`, Node 22.23.2 | 139 passed; 0 failed, cancelled or skipped |
| Full `node --test`, Node 26.8.2 | 139 passed; 0 failed, cancelled or skipped |
| `node --check` | All 18 source/test/fixture/script JS files pass |
| `git diff --check` | Pass |
| Offline `npm pack --ignore-scripts` | Seven expected shipped files; extracted host/client bytes match the source; no lifecycle hooks run |
| Real DSH Loader smoke, source and packed artifact | DSH 0.2.1-rc.2; disposable profile recovers a delayed loopback workspace endpoint, registers `mcp__real__echo`, and returns HTTP 200 for logs and manual connect |

The Loader smoke is reproducible with `node scripts/verify-real-dsh.mjs <disposable-npm-prefix>` containing `@deepseek-ai/dsh@0.2.1-rc.2`. All tests use temporary HOME/USERPROFILE/DSH_HOME, synthetic OAuth credentials, and owned loopback endpoints. The Loader smoke was run with a sanitized environment and submits no model request. No real OAuth credentials or existing services were used.

No build/lint scripts exist in this plain ESM repository; those checks were not run. The first attempt with default Node 20.19.0 was unsupported and loopback-blocked (`listen EPERM`); supported-runtime runs above replace it.

## Limits before merge/release

- Real-provider browser consent, Windows and Node 24 were not exercised. The exact Loader smoke runtime (0.2.1-rc.2) is outside the package's declared `<0.2.0` compatibility interval; the smoke does not establish the entire declared version matrix.
- A crash leaving `.refresh.lock.reclaim` fails closed. An operator must verify the owner exited and remove the orphan before stale-lock recovery resumes; writes otherwise time out after 25 seconds. No automatic deletion of a possibly active guard is attempted.
- Process death after provider rotation but before durable save, permanent storage failure, and mixed deployment with older clients that ignore the all-writer lock cannot guarantee safe cross-process recovery. Repair storage and reauthorize as needed.
- `lastToolOkAt` currently includes successful generic RPC such as tools/list; it is not proof of a successful actual tool call. Workspace views do not expose the same OAuth health fields.
- Package version 0.13.6 is inherited from the contributor's branch, not a release assertion. Owner repository releases/tags were verified through v0.13.1; claims that 0.13.2–0.13.5 were deployed are not evidence of an owner release. Select the eventual version/tag separately. This candidate creates no tag, publication or deployment.
