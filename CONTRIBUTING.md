# Contributing

Thanks for helping improve **dsh-mcp-manager**. This is a small DSH plugin repository:
changes are usually discussed in GitHub issues first; code lives under `lib/`,
`test/`, and docs.

## Before you open an issue

| Goal | Where to go |
|------|-------------|
| **Security** (vulnerability, exploit, credential leak) | **Do not** use a public issue. Follow [SECURITY.md](SECURITY.md) and [GitHub private vulnerability reporting](https://github.com/hyqhyq3/dsh-mcp-manager/security/advisories/new). |
| **Bug or regression** | [Bug report template](https://github.com/hyqhyq3/dsh-mcp-manager/issues/new?template=bug_report.yml) |
| **Feature or improvement** | [Feature request template](https://github.com/hyqhyq3/dsh-mcp-manager/issues/new?template=feature_request.yml) |
| **Question / unclear report** | A template is preferred; a blank issue is still allowed (see below). |

You **do not** need to prove something is definitely a bug before filing. Describe
what you saw, on which version, and what you expected instead — maintainers will
triage.

### What helps in bug reports

- **Version**: annotated tag (e.g. `v0.18.0`) or commit SHA — not only `main`.
- **Platform**: OS, Node.js version, DSH profile (`web` / headless) if relevant.
- **Minimal steps**: shortest path to reproduce; optional small fixture, not a full
  project unless needed.
- **Expected vs actual** behavior.
- **Redacted logs**: Settings → MCP **Logs** panel, or `ctx.logger` lines with
  tokens, `code`/`state`, `client_secret`, and bearer values removed. Do **not**
  paste live credentials or full `~/.dsh/mcp-manager.json`.

### Security and sensitive content

- Never post **secrets**, **live OAuth tokens**, or **weaponized PoCs** in public
  issues, PRs, or comments.
- If you suspect a security problem, use the **private** channel only
  ([SECURITY.md](SECURITY.md)).

### Blank issues

`blank_issues_enabled` stays **on** so misrouted questions or one-off reports are
not blocked. Templates collect better evidence for bugs and features; blank issues
may get a **needs info** request and a pointer to the right template.

## Pull requests

1. Open or link an issue when the change is non-trivial (maintainers may still
   accept drive-by doc/test fixes).
2. Match existing style: plain ESM, no bundler, bilingual UI strings in the `mcp`
   locale namespace when touching `lib/client.js`.
3. Run `npm test` for behavioral changes; note platform limits in the PR if you
   could not run something (e.g. Windows-only paths).
4. User-visible behavior: bump `package.json` version, sync `README.md` and
   `README.zh-CN.md`, and follow [AGENTS.md](AGENTS.md) release steps when the
   maintainer cuts a release.

Maintainers review PRs; bots do **not** auto-merge, auto-close, or auto-label from
this policy alone.

## How maintainers triage (summary)

Detailed rules for maintainers and coding agents: [docs/maintainers.md](docs/maintainers.md).

Issues are sorted into one of six **routing** categories (routing ≠ accepting the
report as valid, promising a fix, or scheduling work):

1. **bug** — reproducible defect on a stated version.
2. **feature request** — intentional behavior change or addition.
3. **needs info** — missing version, platform, or repro.
4. **duplicate** — same **root cause** as an existing issue (must link the
   canonical issue, not merely similar wording).
5. **invalid / out-of-scope** — not a plugin concern, unsupported environment, or
   no actionable evidence.
6. **already fixed** — requires evidence: fix **commit** and a **released** tag
   users can install (a fix only on `main` is not “released” until tagged).

Security reports stay in the private advisory flow; they are not debated or
closed in public issues.

## Inspiration (not automation)

Issue-handling ideas draw on [Apache Magpie](https://github.com/apache/magpie) and
its [issue management notes](https://magpie.apache.org/docs/issue-management/readme/).
Upstream emphasizes **human confirmation** and experimental “issue family” work;
**this repository does not install Magpie** and does **not** run stale bots,
auto-close, or auto-triage workflows unless explicitly adopted later in a separate
decision. If idle/stale handling is ever added, only a reporter’s substantive
reply should reset a waiting clock — not maintainer reminders or bot comments
(see [docs/maintainers.md](docs/maintainers.md)).