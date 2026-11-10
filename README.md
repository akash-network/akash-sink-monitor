# Akash Sink Monitor

Monitors the one-way Akash → Solana bridge accounting, pending transfers, refunds, rejections, caps and light-client health. Follows [BME monitor](https://github.com/chainzero/akash-bme-monitor) alerting conventions.

Slack alerts include transaction explorer links when receipts are available. Critical alerts @mention the configured operator and include your Squad link plus an unsigned base58 pause transaction to import and approve. The monitor holds no wallet keys and sends no chain transactions.

## Setup

Requires **Node.js 24** and **Python 3**.

```sh
git clone https://github.com/akash-network/akash-sink-monitor.git
cd akash-sink-monitor
npm ci --ignore-scripts
npm run verify
cp src/mainnet.example.json config.local.json
```

Edit `config.local.json`: set production RPCs, an absolute writable `stateDir`, and `slackMemberId` (the actual `U…` ID, not a display name). Mainnet program and vault addresses are already supplied.

For Slack, provide `SINK_MONITOR_SLACK_WEBHOOK` through the host's secret manager, with the webhook bound to **#akash-sink-monitor**. Never commit credentials or local config.

```sh
npm run monitor -- --config config.local.json --check
npm run monitor -- --config config.local.json --once
npm run monitor -- --config config.local.json --notify
```

`--check` validates configuration. `--once` collects one observation without sending Slack messages; inspect `stateDir/monitor-state.json` for alerts. `--notify` runs continuously with Slack delivery.

Dashboard: **http://127.0.0.1:9465**. Health: `/healthz`. Prometheus: `/metrics`.

## Deployment

Run one instance with persistent state and RPCs retaining chain history. Keep the dashboard behind a VPN or authenticated HTTPS proxy; optionally set `publicUrl` so alerts link to its pause-action panel. DevOps owns service packaging and deployment.

See the [DevOps handoff](docs/devops-handoff.md) for deployment, [operations guide](docs/operations.md) for alerts and incident response, and [verification notes](docs/verification.md) for tested behavior and limitations.
