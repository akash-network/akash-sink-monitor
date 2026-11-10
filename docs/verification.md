# Verification and remaining work

Application code is published separately in the public `akash-network/akash-sink-monitor` repository. No image publication, deployment, Slack sends or chain transactions were made during implementation or source publication. The earlier experimental monitor edits in the node worktree were removed; that worktree was verified clean.

## Completed checks

- `npm run verify`: SDK/IDL checksum verification, absence of the vulnerable native bigint-buffer binding, strict TypeScript compilation, **23 passing tests**, and Prettier checks.
- Tests exercise accounting deficits, legitimate pending balances, independent burn reconciliation, refund contradictions/deadlines, reporter lag, large integer caps, frozen clients, changed guardians, Slack mentions and cooldowns, failed-delivery restart, recurrence before recovery delivery, observation outages/watchdog, rejected committed deposits, HTTP readiness/read-only endpoints, Squad URLs and the exact unsigned pause instruction.
- The pause import was decoded back into one `guardian_pause` instruction. Program ID, account order, signer/writable flags, independent discriminator hash and empty signatures were asserted. No simulation or signing was performed.
- Read-only **standalone** mainnet observation at `2026-11-10T04:29:41Z`: Akash height `29450626`, finalized Solana slot `467586295`; 13 AKT deposited/escrow/proven minted/supply, zero pending, zero refunds, zero burns, no active accounting alerts. Four historical transfers were baselined. Notifications were disabled.
- Browser inspection of the actual local dashboard against that saved observation: four transfers, eight cap rows, correct Squad link, 332-character base58 import, enabled copy button and correct stale-data warning. The direct action-panel anchor scrolls into view after asynchronous data loading. Copy behavior was verified with a substituted clipboard sink, so the system clipboard was not changed. The dashboard preview process was stopped afterward.
- Independently rebuilt the generated SDK from its public release tag. With `umask 022`, its archive SHA-256 matches the bundled archive byte-for-byte; see `vendor/README.md`.
- Scoped source-pattern scan found no private-key PEM, actual Slack webhook/token, AWS access key or 64-byte numeric keypair array in publishable source. No private wallet files were read or copied. This is a scoped check, not a claim about every repository or all possible secret formats. The SDK archive was reproduced from public source rather than accepted as opaque local content.

The final source checksums and local scan evidence are retained under the ignored `.cache/review/` directory. Earlier pre-extraction tests are not counted as validation of the standalone repository.

## Not yet verified

- Production Linux/container packaging, cluster placement, storage behavior and resource sizing.
- Long-duration or large-history load; this implementation reconciles full transfer history each pass.
- Real Slack webhook delivery, Joseph's live @mention, or delivery under Slack rate limiting. The actual member ID and webhook are unset.
- A Squads UI import/simulation/execution of this monitor's pause payload. Unit decoding is not an on-chain rehearsal.
- Failure drills involving real chain outages, adversarial RPCs, actual refund challenges or a down monitoring host. Fault tests cover the application policy and delivery paths.

`npm audit` still reports inherited transitive advisories. Their scoped dispositions are documented in `vendor/README.md`; they are not claimed fixed. DevOps/application review should reassess them when packaging the service.

The code uses BME's monitoring conventions in TypeScript, with bridge adapters from node. It does not modify or fork the running BME Go service. DevOps owns the remaining deployment qualification described in `devops-handoff.md`.
