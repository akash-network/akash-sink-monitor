# akash-sink-monitor

Read-only monitoring for the Akash Sink bridge on `akashnet-2` and Solana mainnet. This is a standalone repository, with no runtime dependency on a node checkout. Source: [akash-network/akash-sink-monitor](https://github.com/akash-network/akash-sink-monitor). Deployment is managed separately by DevOps.

The monitor checks escrow backing, finalized Solana issuance, pending transfers, refunds, committed deposit rejections and both chains' caps. It serves a small dashboard and Prometheus metrics. Critical Slack alerts mention the configured member and include the Squad link and an unsigned base58 guardian-pause import.

It never loads wallet keys, signs, broadcasts or automatically pauses a chain. Member approval and execution in Squads remain necessary.

## Local verification

Requires Node.js 24, npm and Python 3 (standard-library file locking on Linux/macOS).

```sh
git clone https://github.com/akash-network/akash-sink-monitor.git
cd akash-sink-monitor
npm ci --ignore-scripts
npm run verify
```

For an optional **read-only** mainnet observation, create a local configuration and state directory:

```sh
mkdir -p .cache/preview
node -e 'const fs=require("fs"); const c=require("./src/mainnet.example.json"); c.stateDir=require("path").resolve(".cache/preview/state"); fs.writeFileSync("config.local.json",JSON.stringify(c,null,2)+"\n",{mode:0o600})'
npm run monitor -- --config config.local.json --check
npm run monitor -- --config config.local.json --once
```

No Slack message is sent without `--notify`. A successful `--once` means collection completed; inspect `state/monitor-state.json` for alerts. Public RPCs can be rate limited or omit historical data. Incomplete history produces an unavailable alert, not a healthy verdict.

To preview the dashboard locally, omit `--once`; open `http://127.0.0.1:9465`. Stop with Ctrl+C. This is not a service installation.

## What is monitored

| Check | Behavior |
| --- | --- |
| Akash escrow | Compare the module bank balance with native pending, minted, voided and refund-pending liabilities. A deficit is critical; unsolicited surplus is a warning. |
| Deposit conservation | Full deposit history must equal remaining recorded liabilities plus paid refunds. |
| Cross-chain backing | Proven finalized mints must equal current SPL supply plus independently indexed finalized burns. Pending deposits are not counted as minted. |
| Settlement | Alert on mint/refund contradictions, missing Solana void evidence, governance holds and delayed reporter settlement. |
| Pending transfers | Warn after 5 minutes; critical after 15 minutes without a finalized resolution. Configurable. |
| Refunds | Show the challenge deadline, reporter quorum and hold. Alert 10 minutes after an unheld refund becomes due. The normal challenge window is not an incident. |
| Caps | Live native epoch deposit/refund/per-account usage, both chains' per-transfer caps, and Solana daily mint usage. Warn at 80%; critical at 95%. Native reset boundaries come from Akash's epoch query. |
| Light client | Frozen or expired is critical. Warn at one-quarter of the trusting period; critical at one-half. |
| Identity and freshness | Pin chain/genesis/program/mint/light client, verify guardian, reject regressions and stale/incomplete observations. An outage never clears existing financial alerts. |
| Rejections | Index failed committed Akash deposit transactions from blocks and results. On-chain void outcomes are shown separately from transaction failures. |

This bridge is one-way. “Outflows” here means Solana issuance and Akash refunds; ordinary wallet-to-wallet SPL transfers are not bridge outflows. SPL burns reduce supply and do not redeem native AKT.

State and an outgoing notification queue survive restarts. Transfer events and burn receipts are written before their checkpoints. Slack delivery is at least once: a crash after Slack accepts a message can repeat its stable event ID.

## Your Squad and the pause action

[Open the mainnet Squad](https://app.squads.so/squads/H2sXJRVW3SnTdFGjTXpGSsVKN2HnDaKc6xLRomS36H3U/transactions?tab=Vault).

- Vault / Solana guardian: `H2sXJRVW3SnTdFGjTXpGSsVKN2HnDaKc6xLRomS36H3U`
- Multisig account: `Hx92ZBfSJ7kLaDpmRYvh5TcnrSLWMnh5eDdpQqC9B3ke`, vault index `0`
- AKT program: `98inUHb5mMaHWQZ9ut9PGrnmkMpncLZWWAyFwxCWagME`
- SPL mint: `5d3fjPDdkYbtYcAMR9PC2TANaEyhzuyP8JxTEwqjVgBZ`

Critical alerts include the full base58 import and the direct Squad link. The dashboard has a **Copy base58 pause transaction** button. If `publicUrl` is set to the monitor's HTTPS origin, Slack also links directly to that panel.

The Squad route is verified; a supported URL parameter that prefills arbitrary import bytes was **not** found. The link opens your Squad, where you paste the provided bytes using **TX Builder → Create transaction → Add instruction → Import base58 encoded tx**. See the [official Squads import instructions](https://docs.squads.so/main/navigating-your-squad/developers-assets/transaction-builder).

The payload contains exactly one `guardian_pause` instruction, no transfers or upgrades. Its placeholder blockhash and empty signature are intentional: Squads imports its instructions and constructs the executable transaction. It does not expire as an instruction template. Verify the current guardian/program and simulate the resulting Squads transaction before approval.

## Slack and future Linux deployment

Use channel **`akash-sink-monitor`**. Remaining inputs are Joseph's actual Slack member ID, a channel-bound incoming webhook, the monitoring host and, optionally, its HTTPS URL. `chalabi` is a display name and is deliberately rejected as a member ID. A workspace admin can supply the member ID if Slack's profile menu does not expose it.

The webhook belongs in the host's secret manager or a root-owned environment file as `SINK_MONITOR_SLACK_WEBHOOK`. Never commit it. The JSON config accepts `slackMemberId` (for example, your real `U…` ID), not a token. Incoming webhooks are bound to their installed channel: `slackChannel` is a label, not an override.

See [the DevOps handoff](docs/devops-handoff.md), [operations and incident response](docs/operations.md), [dependency provenance](vendor/README.md), and [verification notes](docs/verification.md). DevOps owns placement, packaging and deployment. `deploy/` contains optional Prometheus alert rules only. No services are enabled by installation of npm dependencies.

## Scope and operational limits

- Collection uses committed Akash state and finalized Solana observations, not mempool events. Committed rejections are indexed from the first successful observation onward; pre-start rejections are not backfilled.
- CheckTx/mempool rejections and relayer transactions that never reach chain need operator logs. This monitor does not claim to see them. Failed Solana submissions leave a pending transfer and are detected through its settlement timer.
- The initial burn index must reach mint creation. Subsequent scans must cover the saved finalized slot. Use a Solana RPC retaining transaction history and Akash RPCs retaining required block/results and query heights. Missing coverage fails closed.
- This version fully reconciles retained transfer history each pass. It is intended for current launch traffic; it has not been load-tested for large lifetime histories. The burn scan is bounded to 10,000 transactions per pass and becomes unavailable if exceeded. Preserve state and monitor collection latency; do not hide this condition by deleting the index or raising limits blindly.
- RPC fallback is availability protection, not independent cryptographic verification of both chains or multi-provider consensus. The monitor trusts its configured RPCs. Existing contract light-client validation is unchanged.
- The default listener is loopback. Use a VPN or authenticated HTTPS reverse proxy before exposing the dashboard. An external watchdog is required to alert if this host dies or Slack delivery fails.

The service is based on the monitoring conventions of [Scott's `chainzero/akash-bme-monitor`](https://github.com/chainzero/akash-bme-monitor): independent monitor/alert modules, multi-RPC fallback, Slack webhooks, per-condition cooldowns, immediate severity escalation and recovery notifications. Those behaviors are implemented in TypeScript so the bridge uses the existing Akash/Solana decoders; this is not a fork of its Go binary. No source from that repository was copied. Bridge decoding and reconciliation are adapted from the Apache-licensed Akash node code, with provenance below. The handoff records the matching BME deployment pattern for DevOps to use.
