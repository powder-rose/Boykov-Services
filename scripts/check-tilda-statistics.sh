#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
docker compose exec -T app node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/app/data/platform.sqlite',{readOnly:true});
try {
  for (const host of ['boykovgroup.ru','elektrolaboratoriya-techotchet.ru']) {
    const site=db.prepare('SELECT id,delivery_mode FROM sales_sites WHERE host=?').get(host);
    if (!site || site.delivery_mode!=='tilda') { console.log(JSON.stringify({site:host,status:'SOURCE_NOT_CONFIGURED'})); continue; }
    const state=db.prepare('SELECT first_at,last_at FROM statistics_tilda_state WHERE site_id=? AND host=?').get(site.id,host);
    const counts=db.prepare('SELECT COUNT(*) views,COALESCE(SUM(visit),0) visits FROM statistics_tilda_views WHERE site_id=? AND host=? AND at>=?').get(site.id,host,Date.now()-86400000);
    console.log(JSON.stringify({site:host,status:state?'CONNECTED':'NO_EVENTS',coverageFrom:state?new Date(state.first_at).toISOString():null,lastView:state?new Date(state.last_at).toISOString():null,views24h:state?counts.views:null,visits24h:state?counts.visits:null}));
  }
} finally { db.close(); }
NODE
