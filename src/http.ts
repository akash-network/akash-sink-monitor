import { createServer } from "node:http";
import type { Config } from "./config";
import type { MonitorState } from "./model";
import { squadsUrl } from "./pause";
import { healthLines } from "./summary";
import { reporterHealth } from "./reporters";

const page = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>Akash Sink Monitor</title>
<style>body{font:15px system-ui;background:#10141b;color:#e8eef7;margin:32px}h1{font-size:26px}section{background:#1a2230;padding:18px;margin:16px 0;border-radius:8px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px;border-bottom:1px solid #354055;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}.critical{color:#ff8b86}.warning{color:#f2d27c}#status{font-weight:bold}a{color:#8abfff}</style>
<h1>Akash Sink Monitor</h1><p id="status">Loading current observations…</p>
<section><h2>Alerts</h2><div id="alerts"></div></section>
<section><h2>Headers, light client and reporters</h2><pre id="health"></pre></section>
<section><h2>Accounting · AKT</h2><pre id="accounting"></pre></section>
<section><h2>Caps</h2><table><thead><tr><th>Limit</th><th>Used / limit · AKT</th><th>Remaining · AKT</th><th>Period</th></tr></thead><tbody id="caps"></tbody></table></section>
<section><h2>Transfers, refunds and rejections</h2><table><thead><tr><th>Transfer</th><th>AKT</th><th>Akash / Solana</th><th>Hold / refund deadline</th></tr></thead><tbody id="transfers"></tbody></table></section>
<section><h2>Recent transitions</h2><pre id="events"></pre></section>
<section id="pause-action"><h2>Emergency Solana pause</h2><p>Stops new Solana mints. Akash deposits and refunds require a separate guardian action.</p>
<p><button id="copy-pause" disabled>Copy base58 pause transaction</button> · <a id="squad" target="_blank" rel="noopener noreferrer">Open your Squad</a></p>
<p id="pause-status" role="status"></p>
<ol><li>Copy the base58 transaction, then open your Squad using a member wallet.</li><li>Open TX Builder, create a transaction, then Add instruction → Import base58 encoded tx.</li><li>Paste, review <code>guardian_pause</code>, simulate, and initiate.</li><li>Collect the second member's approval and execute. Verify Solana minting shows disabled.</li></ol>
<p id="pause-identity"></p><p>This is an unsigned instruction import, not an executed pause. Opening the link does not prefill Squads or send a transaction.</p><pre id="pause"></pre></section>
<script>
const el=id=>document.getElementById(id);
let pauseBytes=null;
let initialScroll=false;
el('copy-pause').addEventListener('click',async()=>{try{if(!pauseBytes)return;await navigator.clipboard.writeText(pauseBytes);el('pause-status').textContent='Copied. Open your Squad and import the transaction.'}catch{el('pause-status').textContent='Clipboard unavailable. Select and copy the base58 text below.'}});
const akt=x=>{const n=BigInt(x);return String(n/1000000n)+'.'+String(n%1000000n).padStart(6,'0')};
const row=(table,values)=>{const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td)}el(table).append(tr)};
async function refresh(){try{const response=await fetch('/status');if(!response.ok)throw Error('Monitor unavailable');const data=await response.json();const s=data.snapshot;
el('status').textContent=data.fresh?'Last complete observation: '+s.checkedAt:'STALE / NO COMPLETE OBSERVATION';
el('status').className=data.fresh?'':'critical';el('alerts').replaceChildren();
el('health').textContent=data.health.join('\\n');
for(const a of Object.values(data.active)){const p=document.createElement('p');p.className=a.severity;p.textContent=a.severity.toUpperCase()+': '+a.title+' — '+a.detail;el('alerts').append(p)}
pauseBytes=data.pauseImport;el('copy-pause').disabled=!pauseBytes;el('squad').href=data.squadsUrl;
el('pause').textContent=pauseBytes||'Unavailable; verify guardian configuration.';
el('pause-identity').textContent='Program: '+data.programId+' · Guardian / vault: '+data.squadsVault;
el('pause-status').textContent=data.fresh?'Based on the latest complete observation.':'State is stale: verify the guardian and program in Squads before approving.';
if(!s)return;
el('accounting').textContent=['Deposited: '+akt(s.depositedUakt),'Escrow: '+akt(s.lockedUakt),'Proven mints: '+akt(s.mintedUakt),'Solana supply: '+akt(s.supplyUakt),'Burned: '+akt(s.burnedUakt),'Refunded: '+akt(s.refundedUakt),'Pending unminted: '+akt(s.pendingUakt),'Refund pending: '+akt(s.refundPendingUakt),'Awaiting mint reports: '+akt(s.awaitingReportsUakt),'Deposits / mints / refunds enabled: '+[s.depositsEnabled,s.mintingEnabled,s.refundsEnabled].join(' / ')].join('\\n');
el('caps').replaceChildren();for(const c of s.caps){const remaining=BigInt(c.limitUakt)-BigInt(c.usedUakt);row('caps',[c.label,akt(c.usedUakt)+' / '+akt(c.limitUakt),akt(String(remaining>0n?remaining:0n)),c.period])}
el('transfers').replaceChildren();for(const t of [...s.transfers].reverse()){row('transfers',[t.id+' → '+t.recipient,akt(t.amountUakt),t.akash+' / '+t.solana,t.hold+' / '+(t.challengeEnd==='0'?'none':new Date(Number(t.challengeEnd)*1000).toISOString())+(t.vetoReason?' / '+t.vetoReason:'')])}
el('events').textContent=data.events.slice(-50).reverse().map(e=>e.at+' '+e.detail).join('\\n');
if(!initialScroll&&location.hash==='#pause-action'){el('pause-action').scrollIntoView();initialScroll=true}
}catch(e){el('status').textContent='MONITOR UNREACHABLE';el('status').className='critical'}}
refresh();setInterval(refresh,5000);
</script></html>`;

export function metrics(
  state: MonitorState,
  fresh: boolean,
  config: Config,
  now = Date.now(),
): string {
  const lines = [
    "# HELP akash_sink_monitor_fresh Whether the latest complete observation is within the configured freshness window.",
    "# TYPE akash_sink_monitor_fresh gauge",
    `akash_sink_monitor_fresh ${Number(fresh)}`,
    "# HELP akash_sink_monitor_last_success_seconds Unix timestamp of the latest complete observation, or zero before the first success.",
    "# TYPE akash_sink_monitor_last_success_seconds gauge",
    `akash_sink_monitor_last_success_seconds ${state.snapshot ? Date.parse(state.snapshot.checkedAt) / 1000 : 0}`,
    "# HELP akash_sink_monitor_outbox_pending Number of notifications awaiting successful delivery.",
    "# TYPE akash_sink_monitor_outbox_pending gauge",
    `akash_sink_monitor_outbox_pending ${state.outbox.length}`,
    "# HELP akash_sink_monitor_critical_alerts Number of active critical alerts.",
    "# TYPE akash_sink_monitor_critical_alerts gauge",
    `akash_sink_monitor_critical_alerts ${Object.values(state.active).filter((a) => a.severity === "critical").length}`,
  ];
  const gauge = (name: string, help: string, value: number | string) => {
    lines.push(
      `# HELP ${name} ${help}`,
      `# TYPE ${name} gauge`,
      `${name} ${value}`,
    );
  };
  gauge(
    "akash_sink_monitor_summary_last_success_seconds",
    "Unix timestamp of the last successfully delivered periodic summary, or zero before delivery.",
    (state.delivered.summary?.sentAt ?? 0) / 1000,
  );
  gauge(
    "akash_sink_monitor_summary_interval_seconds",
    "Configured interval between successfully delivered periodic summaries.",
    config.summaryIntervalSeconds,
  );
  const s = state.snapshot;
  if (s) {
    gauge(
      "akash_sink_client_header_age_seconds",
      "Age of the light client's latest consensus header at the last complete observation.",
      s.client.ageSeconds,
    );
    gauge(
      "akash_sink_client_header_height",
      "Latest Akash header height stored by the Solana light client.",
      s.client.height,
    );
    const lag = BigInt(s.akashHeight) - BigInt(s.client.height);
    gauge(
      "akash_sink_client_header_lag_blocks",
      "Blocks between observed Akash height and latest light-client header; idle lag is expected.",
      String(lag > 0n ? lag : 0n),
    );
    gauge(
      "akash_sink_client_trust_remaining_seconds",
      "Time remaining before trust expiry at the last complete observation.",
      Math.max(0, s.client.trustingPeriodSeconds - s.client.ageSeconds),
    );
    lines.push(
      "# HELP akash_sink_client_status Last observed light-client state, one for the matching status.",
      "# TYPE akash_sink_client_status gauge",
    );
    for (const status of ["active", "expired", "frozen"])
      lines.push(
        `akash_sink_client_status{status="${status}"} ${Number(s.client.status === status)}`,
      );
    const reporters = reporterHealth(state, config, now);
    gauge(
      "akash_sink_reporter_activity_fresh",
      "Whether the reporter history index covers the latest fresh observation.",
      Number(reporters.fresh),
    );
    gauge(
      "akash_sink_reporter_activity_coverage_seconds",
      "Seconds of indexed history available within the last two hours.",
      reporters.coverageSeconds,
    );
    if (reporters.authorized !== null)
      gauge(
        "akash_sink_reporters_authorized",
        "Members of the current on-chain reporter policy; not process liveness.",
        reporters.authorized,
      );
    if (reporters.quorum !== null)
      gauge(
        "akash_sink_reporters_quorum",
        "Required votes under the current reporter policy; in-flight transfers may use older policies.",
        reporters.quorum,
      );
    if (reporters.recentlyReported !== null)
      gauge(
        "akash_sink_reporters_recently_reported",
        "Current authorized reporters with successful reports in the last two hours; interpret with activity coverage and freshness.",
        reporters.recentlyReported,
      );
    lines.push(
      "# HELP akash_sink_amount_uakt Bridge accounting amounts in micro-AKT from the latest complete observation.",
      "# TYPE akash_sink_amount_uakt gauge",
      "# HELP akash_sink_cap_used_uakt Usage of each bridge cap in micro-AKT.",
      "# TYPE akash_sink_cap_used_uakt gauge",
      "# HELP akash_sink_cap_limit_uakt Limit of each bridge cap in micro-AKT.",
      "# TYPE akash_sink_cap_limit_uakt gauge",
    );
    for (const [label, value] of Object.entries({
      locked: s.lockedUakt,
      deposited: s.depositedUakt,
      minted: s.mintedUakt,
      supply: s.supplyUakt,
      burned: s.burnedUakt,
      refunded: s.refundedUakt,
      pending: s.pendingUakt,
      refund_pending: s.refundPendingUakt,
    }))
      lines.push(`akash_sink_amount_uakt{kind="${label}"} ${value}`);
    for (const cap of s.caps) {
      // IDs come from controlled cap keys and validated on-chain addresses.
      const key = JSON.stringify(cap.key);
      lines.push(`akash_sink_cap_used_uakt{cap=${key}} ${cap.usedUakt}`);
      lines.push(`akash_sink_cap_limit_uakt{cap=${key}} ${cap.limitUakt}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function serve(config: Config, state: () => MonitorState) {
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const current = state();
    const fresh =
      current.snapshot !== null &&
      Date.now() - Date.parse(current.snapshot.checkedAt) <
        config.staleSeconds * 1000;
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    switch (request.url) {
      case "/healthz":
        response
          .writeHead(fresh ? 200 : 503, { "Content-Type": "text/plain" })
          .end(fresh ? "fresh\n" : "stale\n");
        return;
      case "/metrics":
        response
          .writeHead(200, { "Content-Type": "text/plain; version=0.0.4" })
          .end(metrics(current, fresh, config));
        return;
      case "/status":
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            fresh,
            snapshot: current.snapshot,
            active: current.active,
            pauseImport: current.pauseImport,
            outboxPending: current.outbox.length,
            squadsUrl: squadsUrl(config),
            squadsVault: config.squadsVault,
            programId: config.programId,
            events: current.events.slice(-200),
            health: healthLines(current, config, Date.now()),
            reporterActivity: reporterHealth(current, config, Date.now()),
          }),
        );
        return;
      case "/":
        response
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(page);
        return;
      default:
        response.writeHead(404).end();
    }
  });
  server.listen(config.listenPort, config.listenHost);
  return server;
}
