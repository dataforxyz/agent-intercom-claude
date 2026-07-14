# Changelog

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
