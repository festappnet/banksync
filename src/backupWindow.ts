import type {D1Database} from '@cloudflare/workers-types';
import {recoveryMaintenanceEnabled} from './recoveryMaintenance';

/** A crashed backup cannot leave recovery paused indefinitely. Manual windows
 * have no backup owner and are never automatically expired. */
export async function acquireBackupWindow(db:D1Database):Promise<(()=>Promise<void>)|null> {
  if(await recoveryMaintenanceEnabled(db))return null;
  const owner=JSON.stringify({token:crypto.randomUUID(),expiresAt:new Date(Date.now()+15*60000).toISOString()});
  const claim=await db.prepare(`INSERT INTO schema_meta(key,value) SELECT 'backup_maintenance_owner',?
    WHERE NOT EXISTS(SELECT 1 FROM schema_meta WHERE key='recovery_maintenance' AND value='on')
    ON CONFLICT(key) DO NOTHING`).bind(owner).run();
  if(!claim.meta.changes)return null;
  const marker=await db.prepare(`INSERT INTO schema_meta(key,value) SELECT 'recovery_maintenance','on'
    WHERE EXISTS(SELECT 1 FROM schema_meta WHERE key='backup_maintenance_owner' AND value=?)
    AND NOT EXISTS(SELECT 1 FROM schema_meta WHERE key='recovery_maintenance' AND value='on')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(owner).run();
  if(!marker.meta.changes){await db.prepare("DELETE FROM schema_meta WHERE key='backup_maintenance_owner' AND value=?").bind(owner).run();return null;}
  return async()=>{
    await db.prepare("UPDATE schema_meta SET value='off' WHERE key='recovery_maintenance' AND EXISTS(SELECT 1 FROM schema_meta WHERE key='backup_maintenance_owner' AND value=?)").bind(owner).run();
    await db.prepare("DELETE FROM schema_meta WHERE key='backup_maintenance_owner' AND value=?").bind(owner).run();
  };
}

export async function drainRecoveryWriters(db:D1Database):Promise<void> {
  const version=await db.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
  for(let attempt=0;attempt<=130;attempt++) {
    const bank=Number(version?.value??0)>=11?await db.prepare("SELECT COUNT(*) AS n FROM bank_poll_leases WHERE datetime(lease_until)>datetime('now')").first<{n:number}>():{n:0};
    const email=Number(version?.value??0)>=13?await db.prepare("SELECT COUNT(*) AS n FROM authenticated_email_spool WHERE state='pending' AND datetime(claim_until)>datetime('now')").first<{n:number}>():{n:0};
    if(!bank?.n&&!email?.n)return;
    if(attempt===130)throw new Error('backup_recovery_writers_did_not_drain');
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
}
