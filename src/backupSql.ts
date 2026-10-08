import type {D1Database} from '@cloudflare/workers-types';

function sqlValue(value:unknown):string {
  if(value===null||value===undefined)return 'NULL';
  if(typeof value==='number')return Number.isFinite(value)?String(value):'NULL';
  if(typeof value==='boolean')return value?'1':'0';
  return `'${String(value).replace(/'/g,"''")}'`;
}

/** One serializer for local dumps and streaming production backups. */
export async function* sqlDumpChunks(db:D1Database,tables:readonly string[],rowCounts:Record<string,number>):AsyncGenerator<string> {
  const version=await db.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{value:string}>();
  yield `-- banksync backup ${new Date().toISOString()}\n-- schema_version=${version?.value??'unknown'}\n-- restore: re-apply migrations then load this file\n\n`;
  for(const table of tables) {
    if(Number(version?.value??0)<11&&['bank_recovery_batches','authenticated_email_spool'].includes(table))continue;
    if(Number(version?.value??0)<12&&['physical_accounts','account_aliases','payment_reference_grants','payment_references','payment_reference_conflicts'].includes(table))continue;
    if(Number(version?.value??0)<13&&table==='fio_poll_cursors')continue;
    rowCounts[table]=0;
    const filter=table==='schema_meta'?" AND key NOT IN ('backup_maintenance_owner','api_sync_lease_until')":'';
    const bounds=await db.prepare(`SELECT MAX(rowid) AS high_water,COUNT(*) AS n FROM ${table} WHERE 1=1${filter}`).first<{high_water:number|null;n:number}>();
    if(!bounds?.n)continue;
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
}
