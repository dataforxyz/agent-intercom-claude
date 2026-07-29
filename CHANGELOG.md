# Changelog

## Unreleased

- Pin Core `8316cbab` and add the dormant Stage-B Boss contract foundation: exact base-v3 capability parsing, optional authoritative bindings, feature-aware run ACLs/discovery, and correlated typed-control validation. The production MCP surface remains unavailable until protected Controller transport and durable dispatch exist.
- Make `cci` and worker launches safe by default, validate Claude permission modes, reject appended permission overrides, and force Adversary/Council workers and their subagents under a read-only `plan` ceiling.
- Reject every appended single-dash option cluster for hardened Claude roles, including Commander forms such as `-pwoutside`, before configuration acceptance or process spawn.
- Keep Core as one required runtime peer by externalizing its root and subpath imports from every bundle, with exact commit/artifact provenance gates for Core `0.1.0`.
- Reject competing live runtimes that claim an active stable session ID while preserving legitimate reconnects and pending deliveries.
- Add ID-free `oldest`/`latest` selection for multiple pending asks from one sender, hide protocol IDs from pending output, and refuse a second unresolved ask to the same recipient.
- Automatically reconnect persistent workers and MCP runtimes with their stable Intercom identity after broker restarts.
- Clarify that assignments and progress/status checkpoints use `intercom_send`, reserving `intercom_ask` for blocking decisions.

## 0.10.0 - 2026-07-16

- Add `intercom_team` so owned Claude coworkers can find their current manager and live siblings without a global peer search.
- Automatically supply the packaged Intercom MCP server to normal headless `cci` workers, including isolated proxy-backed Claude profiles.

## 0.9.3 - 2026-07-15

- Coordinate the Agent Intercom family on the `0.9.3` release line.

## 0.9.2 - 2026-07-14

- Coordinate the Agent Intercom family on the `0.9.2` release line.
- Declare canonical GitHub repository metadata for npm provenance verification.

- Add CI for branches and pull requests.
- Add tag-driven npm trusted publishing with provenance and automatic GitHub Releases.

## 0.9.1 - 2026-07-14

- Publish the package under the public npm scope `@dataforxyz/agent-intercom-claude`.
- Keep the Git repository and executable names unchanged.

## 0.9.0 - 2026-07-14

- Align the Agent Intercom family on one coordinated `0.9.0` release line.
- No behavior change from the immediately preceding AGPL release.

## 0.3.0 - 2026-07-14

- Forward Claude effort selection through `cci` and orchestrator-managed workers.
- Changed the current project license to `AGPL-3.0-or-later`. Previously published MIT versions remain under MIT, and original `pi-intercom` notices are preserved in `THIRD_PARTY_NOTICES.md`.

## 0.2.0

- Upgrade the bundled broker and client to strict intercom protocol v3.
- Add receiver acknowledgements/rejections and broker-confirmed ask defer/cancel controls.
- Add durable sender outboxes with reconnect replay and incompatible-broker replacement.
- Add Alt+I contact copying to interactive `cci` and `ccim` launchers.
