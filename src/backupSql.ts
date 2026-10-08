import type {D1Database} from '@cloudflare/workers-types';

function sqlValue(value:unknown):string {
  if(value===null||value===undefined)return 'NULL';
  if(typeof value==='number')return Number.isFinite(value)?String(value):'NULL';
  if(typeof value==='boolean')return value?'1':'0';
  return `'${String(value).replace(/'/g,"''")}'`;
}

export interface SqlDumpPlan {version:string;tables:{name:string;high_water:number|null;n:number}[];sequences:{name:string;seq:number}[];}
export async function prepareSqlDump(db:D1Database,tables:readonly string[]):Promise<SqlDumpPlan> {
  const version=await db.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
  const active=tables.filter(table=>!(Number(version?.value??0)<11&&['bank_recovery_batches','authenticated_email_spool'].includes(table))
    &&!(Number(version?.value??0)<12&&['physical_accounts','account_aliases','payment_reference_grants','payment_references','payment_reference_conflicts'].includes(table))
    &&!(Number(version?.value??0)<13&&table==='fio_poll_cursors'));
  const queries=active.map(table=>db.prepare(`SELECT MAX(rowid) AS high_water,COUNT(*) AS n FROM ${table}${table==='schema_meta'?" WHERE key NOT IN ('backup_maintenance_owner','api_sync_lease_until')":''}`));
  const snapshot=await db.batch([...queries,db.prepare('SELECT name,seq FROM sqlite_sequence')]);
  return {version:version?.value??'unknown',tables:active.map((name,i)=>({name,...snapshot[i]!.results[0] as {high_water:number|null;n:number}})),
    sequences:(snapshot[active.length]!.results as {name:string;seq:number}[]).filter(row=>active.includes(row.name))};
}

/** One serializer for local dumps and streaming production backups. */
export async function* sqlDumpChunks(db:D1Database,tables:readonly string[],rowCounts:Record<string,number>,provided?:SqlDumpPlan):AsyncGenerator<string> {
  const plan=provided??await prepareSqlDump(db,tables);
  yield `-- banksync backup ${new Date().toISOString()}\n-- schema_version=${plan.version}\n-- restore: re-apply migrations then load this file\n\n`;
  for(const bounds of plan.tables) {
    const table=bounds.name;rowCounts[table]=0;
    const filter=table==='schema_meta'?" AND key NOT IN ('backup_maintenance_owner','api_sync_lease_until')":'';
    if(!bounds.n)continue;
    const info=await db.prepare(`PRAGMA table_info(${table})`).all<{name:string}>();
    const cols=info.results.map(row=>row.name),quoted=cols.map(name=>`"${name.replace(/"/g,'""')}"`);
    const size=quoted.map(name=>`COALESCE(LENGTH(CAST(${name} AS BLOB)),0)`).join('+');
    yield `-- ${table} (${bounds.n} rows)\n`;
    let after=0;
    while(after<bounds.high_water!) {
      const sizes=await db.prepare(`SELECT rowid AS position,${size} AS bytes FROM ${table} WHERE rowid>? AND rowid<=?${filter} ORDER BY rowid LIMIT 500`).bind(after,bounds.high_water).all<{position:number;bytes:number}>();
      if(!sizes.results.length)break;
      let bytes=0,end=after;
      for(const row of sizes.results){if(end!==after&&bytes+row.bytes>1024*1024)break;bytes+=row.bytes;end=row.position;}
      const page=await db.prepare(`SELECT * FROM ${table} WHERE rowid>? AND rowid<=?${filter} ORDER BY rowid`).bind(after,end).all<Record<string,unknown>>();
      const insert=table==='schema_meta'?'INSERT OR REPLACE INTO':'INSERT INTO';
      for(const row of page.results) {
        const values=cols.map(col=>sqlValue(table==='physical_accounts'&&col==='allocation_enabled'?0:row[col])).join(', ');
        const line=`${insert} ${table} (${cols.join(', ')}) VALUES (${values});\n`;
        // Preserve surrogate pairs when splitting UTF-8 input for encryption.
        for(let start=0;start<line.length;) {
          let stop=Math.min(start+65536,line.length);
          if(stop<line.length&&line.charCodeAt(stop-1)>=0xd800&&line.charCodeAt(stop-1)<=0xdbff)stop--;
          yield line.slice(start,stop);start=stop;
        }
        rowCounts[table]!++;
      }
      after=end;
    }
    yield '\n';
  }
  // Deleted AUTOINCREMENT rows must never cause financial IDs to be reused.
  for(const row of plan.sequences){
    if(!Number.isSafeInteger(row.seq)||row.seq<0)throw new Error('unsafe_backup_sequence');
    yield `INSERT INTO sqlite_sequence(name,seq) SELECT ${sqlValue(row.name)},${row.seq} WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=${sqlValue(row.name)});\n`;
    yield `UPDATE sqlite_sequence SET seq=MAX(seq,${row.seq}) WHERE name=${sqlValue(row.name)};\n`;
  }

}
