import type {D1Database} from '@cloudflare/workers-types';
export async function recoveryMaintenanceEnabled(db:D1Database):Promise<boolean> {
  const row=await db.prepare("SELECT value FROM schema_meta WHERE key='recovery_maintenance'").first<{value:string}>();
  const owner=await db.prepare("SELECT value FROM schema_meta WHERE key='backup_maintenance_owner'").first<{value:string}>();
  if(owner){
    let expired=false;
    try{const lease=JSON.parse(owner.value) as {expiresAt?:string};expired=typeof lease.expiresAt==='string'&&Date.parse(lease.expiresAt)<=Date.now();}catch{/* Preserve unrecognized/manual state. */}
    if(expired){
      await db.prepare("UPDATE schema_meta SET value='off' WHERE key='recovery_maintenance' AND EXISTS(SELECT 1 FROM schema_meta WHERE key='backup_maintenance_owner' AND value=?)").bind(owner.value).run();
      await db.prepare("DELETE FROM schema_meta WHERE key='backup_maintenance_owner' AND value=?").bind(owner.value).run();
      return (await db.prepare("SELECT value FROM schema_meta WHERE key='recovery_maintenance'").first<{value:string}>())?.value==='on';
    }
  }
  return row?.value==='on';
}
/** Include in the actual write, so an invocation started before maintenance
 * cannot write a new fact after the operator begins draining the writers. */
export const RECOVERY_WRITES_ALLOWED="NOT EXISTS (SELECT 1 FROM schema_meta WHERE key='recovery_maintenance' AND value='on')";
