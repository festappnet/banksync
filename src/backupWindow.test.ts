import {describe,it,expect} from 'vitest';
import {operationsDb} from './operationsTestSupport';
import {acquireBackupWindow} from './backupWindow';
import {recoveryMaintenanceEnabled} from './recoveryMaintenance';

describe('backup maintenance ownership',()=>{
  it('serializes backups and releases only its own window',async()=>{
    const {db,sqlite}=operationsDb();
    const release=await acquireBackupWindow(db);expect(release).not.toBeNull();
    expect(await recoveryMaintenanceEnabled(db)).toBe(true);
    expect(await acquireBackupWindow(db)).toBeNull();
    await release!.release();expect(await recoveryMaintenanceEnabled(db)).toBe(false);
    expect(sqlite.prepare("SELECT value FROM schema_meta WHERE key='backup_maintenance_owner'").get()).toBeUndefined();
  });
  it('preserves a manual migration window and a replacement owner',async()=>{
    const {db,sqlite}=operationsDb();
    sqlite.exec("INSERT INTO schema_meta(key,value) VALUES('recovery_maintenance','on')");
    expect(await acquireBackupWindow(db)).toBeNull();expect(await recoveryMaintenanceEnabled(db)).toBe(true);
    sqlite.exec("UPDATE schema_meta SET value='off' WHERE key='recovery_maintenance'");
    const release=await acquireBackupWindow(db);
    sqlite.prepare("UPDATE schema_meta SET value=? WHERE key='backup_maintenance_owner'").run(JSON.stringify({token:'replacement',expiresAt:'2099-01-01T00:00:00Z'}));
    await release!.release();expect(await recoveryMaintenanceEnabled(db)).toBe(true);
  });
  it('expires a crashed backup without expiring manual maintenance',async()=>{
    const {db,sqlite}=operationsDb();
    sqlite.exec("INSERT INTO schema_meta(key,value) VALUES('recovery_maintenance','on')");
    sqlite.prepare("INSERT INTO schema_meta(key,value) VALUES('backup_maintenance_owner',?)").run(JSON.stringify({token:'dead',expiresAt:'2000-01-01T00:00:00Z'}));
    expect(await recoveryMaintenanceEnabled(db)).toBe(false);
    sqlite.exec("UPDATE schema_meta SET value='on' WHERE key='recovery_maintenance'");
    expect(await recoveryMaintenanceEnabled(db)).toBe(true);
  });
});
