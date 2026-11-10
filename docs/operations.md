# Operations and incident response

These instructions prepare a future deployment. No host was provisioned, service started permanently, channel created or Slack message sent during implementation.

## Configure and operate

DevOps owns packaging, placement and service installation. The intended reference is BME's single-replica workload on `provider-monitoring` / `akash-services`; live placement has not been inspected. The runtime needs Node 24 and Python 3, a readable JSON config, and a writable durable state directory. Paths below are examples for the operator to choose. Run one instance per state directory. Two instances sharing that directory are rejected by an OS file lock; independent redundant instances require separate state and alert routing.

1. Install with `npm ci --ignore-scripts` and run `npm run verify`.
2. Copy `src/mainnet.example.json` to the config path. Supply reliable RPC endpoints, the real Slack member ID and optional `publicUrl` (HTTPS origin only).
3. Store the channel-bound Slack webhook in a protected environment file or secret manager. Use `SINK_MONITOR_SLACK_WEBHOOK`; keep it out of command-line arguments, Git and chat.
4. Run `npm run monitor -- --config /etc/akash-sink-monitor/config.json --check`, followed by `--once` without `--notify`. Confirm identity, history coverage, counts and cap values.
5. DevOps should package and install the service using the existing monitoring deployment process when separately authorized. The runtime command is `npm run monitor -- --config /etc/akash-sink-monitor/config.json --notify`. Configure the incoming webhook specifically for `#akash-sink-monitor`.
6. Verify a deliberately generated **test** alert and resolution in the target channel as a separate, authorized launch check. Automated tests use a fake Slack transport and do not establish live webhook delivery.

The program runs directly from TypeScript through pinned `tsx`, so the same package works on Linux ARM64 and x86_64. There is no reporter, relayer, header encoder or Solana contract build in this repository.

The initial index can need substantial RPC history. Do not delete `burn-index.json` or `monitor-state.json` as a routine restart procedure. A fresh state directory intentionally establishes a new transfer-event baseline and rejection cursor. Back up the state directory as a unit while the service is stopped or via a consistent filesystem snapshot. Retain `burn-events/` and `events/` for incident review; there is no automatic retention deletion.

Writes use mode 0600, adjacent temporary files, fsync and atomic rename. These temporary files must be adjacent to durable state so replacement stays on the same filesystem; they are not build scratch files. Local development scratch lives in the repository's ignored `.cache/`.

## Transaction links in alerts

Transfer notifications and transfer-specific incidents link the original Akash deposit and finalized Solana mint/void transaction. Deposit links bind the signed message and response ID to the reconciled transfer; Solana links bind the program, status account, instruction and resolution slot. Rejected deposits link the failed committed transaction, and burn notices link the independently indexed burn transaction.

Missing history never produces an invented transaction link. The monitor retries receipt lookups with a bounded per-poll budget and sends a follow-up when a link becomes available. Refund notices link the original deposit and void evidence and label the observation block separately: a refund may run automatically in a block without its own transaction. Aggregate accounting/cap alerts identify their observation blocks rather than claiming a single transaction caused the condition.

Receipt lookup does not replace accounting verification. RPC history unavailable for reconciliation remains an observation failure. The service observes committed/finalized activity, so there is normal chain-finality and polling delay.

## Critical alert: pause Solana issuance

1. Open the alert's Squad link with a member wallet. Copy its base58 payload or use **Copy base58 pause transaction** in the dashboard.
2. In TX Builder create a transaction, then **Add instruction → Import base58 encoded tx**. Paste, click Next, and inspect the instruction.
3. It must be **`guardian_pause`**, targeting program `98inUHb5mMaHWQZ9ut9PGrnmkMpncLZWWAyFwxCWagME`, signed through vault `H2sXJRVW3SnTdFGjTXpGSsVKN2HnDaKc6xLRomS36H3U`. No transfer, upgrade or enable instruction should appear.
4. Simulate, initiate, get the required second member approval, and execute. The monitor does none of these steps automatically.
5. Confirm `mintingEnabled: false` in a fresh monitor snapshot. Keep the incident open until accounting is reconciled; a pause does not repair a mismatch.

Opening a link, copying bytes, initiating a proposal or collecting approvals alone does not pause the bridge. Execution is required. If the guardian differs from the configured vault, the monitor suppresses the payload and raises a critical identity alert. During an RPC outage the last verified payload remains available with its observation time; recheck the authority in Squads.

`guardian_pause` disables Solana issuance only. It does not freeze existing token accounts, stop transfers of existing AKT, stop governance voids, disable Akash deposits, or halt refunds.

## Protect native Akash escrow

For suspected backing/refund corruption or a sustained Solana outage, contact the native pause-guardian operator. The expected launch guardian is `akash1aagclq778tq4ga0lke3wrd3mgw0rt3cc6670dp`; verify the live `nativeGuardian` field before action.

That operator must use the native `MsgGuardianPause` operation to pause deposits, refunds, or both according to the incident. A Squads Solana signature cannot authorize that Akash operation. The monitor intentionally holds neither guardian's signing key. Refund challenge periods and governance holds remain in force; do not bypass them to clear an alert.

A native deposit pause is especially relevant when Solana cannot settle transfers. Pausing refunds additionally protects escrow if refund evidence is suspect. Recovery/enabling requires the appropriate governance or upgrade-authority process, not the guardian-pause payload.

## Monitor the monitor

Endpoints:

- `/`: dashboard, counters, transfers, events, Squad link and copyable pause import.
- `/status`: public chain observations and active alerts; no RPC URLs, webhook or full Slack messages.
- `/healthz`: 200 for a recent complete observation, 503 when missing/stale. It is a collection-health check, not an assertion of financial health.
- `/metrics`: Prometheus freshness, last success, pending deliveries, critical alert count, uakt balances and caps.

Use an independent Prometheus/Alertmanager installation to alert on a missing/down process, stale observations and a growing notification backlog. `deploy/prometheus-alerts.yml` provides starter rules. Route these to an independent receiver if Slack itself is down. A service cannot reliably page about its own dead host.

Critical monitor alerts include pause bytes. External process-down alerts link the Squad but cannot independently certify a current guardian or produce a newly verified payload; preserve the last known import in your incident notes. Backing checks use exact integer arithmetic. Prometheus samples use floating point, so use the JSON snapshot for exact audit amounts.

Inspect structured service logs for `snapshot-attempt-failed`, `observation-unavailable` and `slack-delivery-failed`. RPC failures are labelled by endpoint index and redact URLs. A 429 is an observation/delivery problem, not evidence of lost funds. Do not use public shared RPC endpoints as your only production data source.

## Coverage and limits

- Collection uses committed Akash state and finalized Solana observations, not mempool events. Committed rejections are indexed from the first successful observation onward; pre-start rejections are not backfilled.
- CheckTx/mempool rejections and relayer transactions that never reach chain need operator logs. This monitor does not claim to see them. Failed Solana submissions leave a pending transfer and are detected through its settlement timer.
- The initial burn index must reach mint creation. Subsequent scans must cover the saved finalized slot. Use a Solana RPC retaining transaction history and Akash RPCs retaining required block/results and query heights. Missing coverage fails closed.
- This version fully reconciles retained transfer history each pass. It is intended for current launch traffic; it has not been load-tested for large lifetime histories. The burn scan is bounded to 10,000 transactions per pass and becomes unavailable if exceeded. Preserve state and monitor collection latency; do not hide this condition by deleting the index or raising limits blindly.
- RPC fallback is availability protection, not independent cryptographic verification of both chains or multi-provider consensus. The monitor trusts its configured RPCs. Existing contract light-client validation is unchanged.
- The default listener is loopback. Use a VPN or authenticated HTTPS reverse proxy before exposing the dashboard. An external watchdog is required to alert if this host dies or Slack delivery fails.


This bridge is one-way: Solana issuance and Akash refunds are bridge outflows; wallet-to-wallet SPL transfers are not. Burns reduce supply and do not redeem native AKT.
