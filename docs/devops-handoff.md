# DevOps handoff

Application source: [akash-network/akash-sink-monitor](https://github.com/akash-network/akash-sink-monitor), a public standalone repository. Owner of infrastructure, image publication, deployment and live Slack setup: DevOps. This repository has not been deployed. No existing BME, node, reporter, relayer or cluster configuration was changed.

## Follow the BME monitor pattern

Reference: [`chainzero/akash-bme-monitor`](https://github.com/chainzero/akash-bme-monitor/tree/cbd2796d5a0287ffa3069c5219317ec314e8a41a), especially its [deployment guide](https://github.com/chainzero/akash-bme-monitor/blob/cbd2796d5a0287ffa3069c5219317ec314e8a41a/documentation/deployment.md), `deploy/deployment.yaml`, `deploy/configmap.yaml`, `internal/alerting/slack.go`, and `.github/workflows/release.yml`.

Its documented mainnet deployment is one replica on cluster `provider-monitoring`, namespace `akash-services`. Configuration is a ConfigMap, credentials come from a Secret, and a private GHCR image is produced by the tag-triggered GitHub Actions release workflow. The documented cluster architecture is Linux amd64; the earlier ARM64 relayer requirement does not establish this monitor host's architecture. Confirm the actual target before building an image.

The checked-in BME Deployment still names a Docker Hub image while its deployment guide names GHCR. DevOps must verify the live workload and source of truth in `ovrclk/server-mgmt`; this implementation did not query kubeconfig, SSH into any machine, or inspect the live cluster.

Use a separate `akash-sink-monitor` workload, ConfigMap, Secret, service and state volume. Do not replace the BME workload or reuse its Slack webhook. Its existing channel must remain unaffected. Co-location with BME is an infrastructure decision for DevOps, not performed here.

The application follows BME's per-key 10-minute cooldown, escalation bypass, recovery messages, external Slack credential and RPC fallback. Added bridge requirements are durable accounting history, durable delivery retries, exact uakt arithmetic, critical user mentions and the unsigned Squads pause import. It does not include BME's unrelated price/router/guardian monitors or twice-daily BME health reports.

## Runtime contract

| Requirement | Value |
| --- | --- |
| Runtime | Node.js 24 and Python 3 standard library |
| Install | `npm ci --ignore-scripts`; no native bigint-buffer binding |
| Validate | `npm run verify`; local unit/HTTP tests only, no signing or Slack calls |
| Start | `npm run monitor -- --config /path/to/config.json --notify` |
| Public config template | `src/mainnet.example.json` |
| Required credential | `SINK_MONITOR_SLACK_WEBHOOK`, a webhook installed for `#akash-sink-monitor` |
| Mention identity | Joseph's actual `slackMemberId` (`U…`), still unset |
| Persistence | One writable state directory, preserved across updates/restarts; full-directory backup |
| Listener | Default `127.0.0.1:9465`; choose container binding and private service routing |
| Health/metrics | `/healthz`, `/metrics`; optional starter Prometheus rules in `deploy/` |
| Dashboard | `/`; private/authenticated access required if exposed |
| Optional alert action link | `publicUrl` is the authenticated dashboard's HTTPS origin |
| Wallet access | None; do not mount any signer key or ceremony wallet |

BME is stateless; this service is not. Its burn index, rejection cursor and notification queue must survive restarts. Choose an appropriate persistent volume and a rollout strategy that prevents two replicas writing the same state. A file lock provides a second guard. Validate filesystem fsync/atomic-rename behavior. Application scratch is not a substitute for persistent state.

The BME deployment documents a cluster-specific DNS problem when all Linux capabilities are dropped. Preserve the infrastructure team's known working security context; do not copy a generic hardened template without validating that cluster behavior. This service can run nonroot, with no Kubernetes API token and a read-only application filesystem apart from its state directory. Container packaging and these controls have not been tested here.

## Inputs and launch verification still owned by DevOps

- Confirm cluster/node architecture, capacity, image registry and pull credentials. Application source lives in the public `akash-network/akash-sink-monitor` repository.
- Provide reliable historical Akash and Solana RPCs. Keep any credential-bearing config in a Secret, not a public ConfigMap or repository.
- Create `#akash-sink-monitor`, install its webhook and obtain Joseph's Slack member ID.
- Choose persistent storage, private dashboard access and independent process/Slack-delivery monitoring.
- Run a read-only observation from the actual host and compare escrow, supply, pending/refund counts and caps to independent chain queries.
- Test a labelled critical notification, Joseph's actual mention and its resolution. Unit tests do not verify live Slack delivery.
- Rehearse the exact guardian-pause import through Squads in an appropriate test environment. This code round-trips the unsigned transaction but has not executed a pause or created a live Squads proposal.
- Establish external paging for a dead host, RPC history loss, persistent delivery backlog and state-volume failure. Review capacity as lifetime transfer history grows.

These are handoff notes, not authorization to deploy. The user asked to leave deployment to the infrastructure team.
