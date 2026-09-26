# ThePharmer fork experiments

Use this plan to choose and evaluate changes in [ThePharmer/paseo](https://github.com/ThePharmer/paseo).
All entries are proposed experiments. They are not shipped features or an upstream roadmap.

## Priorities

The primary workflow is Android access to a self-hosted Paseo deployment behind Cloudflare
Access, alongside services managed through Proxmox, Docker, and Portainer. The main friction is
entering a domain, port, and custom authentication headers instead of using the existing SSO.

| Order | Experiment | Benefit | Estimated effort |
| --- | --- | --- | --- |
| 1 | Cloudflare Access sign-in and connection links | Use existing SSO without manually configuring headers | Medium to high; validate feasibility first |
| 2 | Durable mobile outbox | Preserve pending instructions through disconnects and app restarts | Medium |
| 3 | Prompt stashes with attachments | Put unfinished instructions aside while answering an interruption | Low to medium |
| 4 | File checkpoints across providers | Recover from unwanted agent changes | High |
| 5 | Mobile Share to Paseo | Capture a screenshot, link, or file from another app | Medium |
| 6 | Resource-aware host recommendations | Place new work on an eligible machine with available capacity | High; useful with multiple hosts |

Effort is a relative planning estimate. Start with the Access feasibility experiment, then the
outbox and prompt stashes. Evaluate checkpoints separately because restoration changes files.

## 1. Cloudflare Access sign-in and connection links

**Target experience:** Open the protected Paseo site, tap **Open in Paseo**, complete the existing
SSO in the system browser, approve the device once, and enter the workspace. A link or QR supplies
the server address. Later launches reuse the saved connection and renew credentials when allowed.

Prototype [Cloudflare Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
first. At the research date it is beta and documents discovery, browser authorization, and refresh
tokens for non-browser clients. Confirm supported Android redirects and resource indicators before
selecting the implementation. Validate HTTP requests and WebSocket handshakes through the same
Access policy; browser login alone does not establish native transport access.

Access authorization and Paseo device permissions remain separate. Use the existing permission
model to establish daemon access. Hub is not required for this experiment; machine discovery
through a Hub account would be additional work. Read [permissions](permissions.md),
[Hub relationships](hub.md), and [routing](expo-router.md) before changing those boundaries.

The user reports custom headers in a custom Android release. That patch was not located in the
reviewed checkout. Identify its branch and request paths before replacing it.

**Acceptance evidence:** On a fresh Android install, open a connection link, authenticate, approve
the device, and send a message without entering headers, tokens, or a separate port. Verify uploads,
downloads, previews, and WebSocket reconnects. Kill and reopen the app, expire the access token,
and revoke access. Renewal must preserve the conversation; revocation must stop new authorized
requests without deleting the draft. Keep credentials out of links, screenshots, and logs.

## 2. Durable mobile outbox

**Workflow:** Submit instructions and attachments while disconnected, then continue after the app
restarts and connectivity returns. [T3's released composer guide](https://github.com/pingdotgg/t3code/blob/v0.0.40/docs/user/composer.md)
is the behavior reference.

Build on Paseo's existing draft and attachment persistence. Starting points are the
[session store](../packages/app/src/stores/session-store.ts),
[draft store](../packages/app/src/stores/draft-store/index.ts), and
[host runtime](../packages/app/src/runtime/host-runtime.ts). Follow the existing
[timeline and submission contract](timeline-sync.md), including acknowledgement reconciliation.

Persist the send before clearing the composer. Retain the host, agent, message identity, and
attachment references. Reconcile uncertain delivery before retrying; a lost acknowledgement must
not cause a second provider submission. Preserve attachment bytes until delivery or explicit removal.

**Acceptance evidence:** Queue text and a screenshot in airplane mode, kill the app, reopen, and
reconnect. Observe one delivery with the attachment intact. Repeat with connectivity lost after
daemon acceptance but before acknowledgement. Cover ordering, cancellation, and an unavailable host.

## 3. Prompt stashes with attachments

**Workflow:** Save unfinished instructions, answer an urgent agent question, then restore the saved
prompt. Use [T3's prompt stash](https://github.com/pingdotgg/t3code/blob/v0.0.40/docs/user/composer.md#prompt-stash)
as the reference, with an accessible mobile action as well as a desktop shortcut.

Extend the existing draft and attachment stores with a saved-prompts picker. Define whether a stash
belongs to a host or workspace and how restoration handles a nonempty composer. Retain attachments
for the stash lifetime; report missing files before sending.

**Acceptance evidence:** Save three prompts with attachments, answer an interruption, restart, and
restore each. Preserve the current draft when choosing another stash. Deleting one stash must not
remove attachment bytes referenced by another draft or pending message.

## 4. File checkpoints across providers

**Workflow:** Restore the workspace to a chosen turn when an agent takes the wrong approach.
[T3's checkpoint architecture](https://github.com/pingdotgg/t3code/blob/v0.0.40/docs/internals/overview.md#turn-completion-and-checkpoints)
uses hidden Git refs and coordinates file restoration with conversation rollback.

Review Paseo's existing rewind capability contracts in the
[Codex adapter](../packages/server/src/server/agent/providers/codex-app-server-agent.ts) and
[Claude adapter](../packages/server/src/server/agent/providers/claude/agent.ts). The opportunity is
to extend file recovery across providers while retaining the existing rewind UI.

Start with Codex, one agent, and an isolated worktree. Define handling for dirty files, staging,
untracked files, ignored files, binaries, and concurrent writers before adding restoration. Keep
snapshots off the user's branch. Reject unsupported conversation rollback before changing files.

**Acceptance evidence:** Restore edits, deletions, and new files while preserving the pre-turn dirty
state and staging area. Detect intervening human or second-agent changes. Exercise failures between
conversation and file restoration and provide a recoverable outcome. Measure snapshot latency and
storage growth on a representative repository.

## 5. Mobile Share to Paseo

**Workflow:** Share a GitHub link, screenshot, or file from another app, choose the destination, and
review a draft before sending. [T3's mobile attachment flow](https://github.com/pingdotgg/t3code/blob/v0.0.40/docs/user/composer.md#attach-files)
is the reference.

Use platform share integration and Paseo's existing attachment storage. Begin on Android. Treat
an incoming share as a draft, preserve temporary file contents, and keep destination selection
explicit. Read [routing](expo-router.md) before adding entry routes.

**Acceptance evidence:** Share from the browser, photo library, and file manager while Paseo is
closed or offline. Verify durable file copies, correct host and agent selection, cancellation,
and preservation of an existing draft. The share action must not send automatically.

## 6. Resource-aware host recommendations

**Workflow:** Recommend a machine for new work, with a visible reason and manual override.
[T3's released load-balancing behavior](https://github.com/pingdotgg/t3code/blob/v0.0.40/docs/user/remote-access.md#balance-new-threads-across-machines)
is the reference.

Check repository availability, provider readiness, and existing access before comparing CPU and
memory. Keep the selected destination stable once a branch or worktree is chosen. Start with a
recommendation; automatic placement can be a later experiment. Existing agents stay on their host.

**Acceptance evidence:** Make one host busy, another offline, and a third ineligible for the selected
provider or repository. Verify the recommendation and explanation, stale-metric handling, manual
override, and stable placement. Do not add provider login checks to automated tests.

## Evidence and delivery

Research snapshot: 2026-09-08. Local Paseo baseline:
`1f33b1a024fd0efb87f90f5838d0e1904fed5081`. T3 references are pinned to `v0.0.40`.
Cloudflare documentation is a live reference. Recheck upstream implementations and service support
before starting each experiment; source review does not establish comparative runtime quality.

Use focused branches and reviewable changes. Record the tested app and daemon revisions, affected
platforms, before/after observations, and unresolved limitations here when evaluating an experiment.
Follow [testing](testing.md), [QA](qa.md), and [mobile testing](mobile-testing.md). Run typecheck and
lint after changes; use the relevant focused tests rather than the full local suite.

Adapt useful behavior and small algorithms to Paseo's existing contracts. Keep implementation details
in the owning code and subject docs. Update this plan's status and link to results as work lands.
