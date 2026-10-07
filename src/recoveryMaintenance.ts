import type {D1Database} from '@cloudflare/workers-types';
export async function recoveryMaintenanceEnabled(db:D1Database):Promise<boolean> {
  const row=await db.prepare("SELECT value FROM schema_meta WHERE key='recovery_maintenance'").first<{value:string}>();
  return row?.value==='on';
}
/** Include in the actual write, so an invocation started before maintenance
 * cannot write a new fact after the operator begins draining the writers. */
export const RECOVERY_WRITES_ALLOWED="NOT EXISTS (SELECT 1 FROM schema_meta WHERE key='recovery_maintenance' AND value='on')";
