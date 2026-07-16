# Changelog

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
