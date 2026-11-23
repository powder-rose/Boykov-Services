#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
docker compose exec -T app node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { docsStatisticsSite } from './shared/statistics.js';
const db=new DatabaseSync('/app/data/platform.sqlite',{readOnly:true});
try {
  const rows=db.prepare('SELECT period,report,generated_at,received_at FROM statistics_native_reports WHERE site_id=? AND source_host=? ORDER BY period').all(docsStatisticsSite.id,docsStatisticsSite.host);
  const recent=rows.find(r=>r.period==='24h');
  const report=recent?JSON.parse(recent.report):null;
  const complete=rows.length===4&&rows.every(r=>r.generated_at===recent?.generated_at);
  console.log(JSON.stringify({site:docsStatisticsSite.host,status:!complete?'NO_REPORT':Date.now()-Date.parse(recent.generated_at)>180000?'STALE':'CONNECTED',periods:rows.length,coverageFrom:report?.coverageFrom??null,lastReport:recent?.generated_at??null,lastDelivery:recent?.received_at??null,views24h:report?.totals.views??null,visits24h:report?.totals.visits??null}));
} finally { db.close(); }
NODE
