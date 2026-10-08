import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {D1Database,D1PreparedStatement,D1Result} from '@cloudflare/workers-types';

export function operationsDb(version = 13) {
  const sqlite = new Database(':memory:');
  const files = ['0001_schema.sql','0010_security_hardening.sql','0011_complete_bank_facts.sql','0012_payment_references.sql','0013_recovery_operations.sql'];
  for (const file of files) {
    if (Number(file.slice(0,4)) > version) break;
    sqlite.exec(readFileSync(resolve(__dirname,'../migrations',file),'utf8'));
  }
  const runs = new WeakMap<D1PreparedStatement,()=>D1Result<Record<string,unknown>>>();
  const result = (changes=0,results:Record<string,unknown>[]=[],lastRowId=0):D1Result<Record<string,unknown>> => ({success:true,results,meta:{changes,last_row_id:lastRowId,duration:0,size_after:Number(sqlite.pragma('page_count',{simple:true}))*Number(sqlite.pragma('page_size',{simple:true})),rows_read:results.length,rows_written:changes,changed_db:changes>0}});
  function prepare(sql:string):D1PreparedStatement {
    let args:unknown[]=[];
    const statement = {
      bind(...values:unknown[]) {args=values;return statement;},
      async first<T>() {return (sqlite.prepare(sql).get(...args) ?? null) as T|null;},
      async all<T>() {return result(0,sqlite.prepare(sql).all(...args) as Record<string,unknown>[]) as D1Result<T>;},
      async run() {return runs.get(statement)!();},
    } as D1PreparedStatement;
    runs.set(statement,()=>{const prepared=sqlite.prepare(sql);if(prepared.reader)return result(0,prepared.all(...args) as Record<string,unknown>[]);const info=prepared.run(...args);return result(info.changes,[],Number(info.lastInsertRowid));});
    return statement;
  }
  const db = {prepare,async batch(statements:D1PreparedStatement[]) {
    return sqlite.transaction(()=>statements.map(statement=>runs.get(statement)!()))();
  }} as D1Database;
  return {db,sqlite};
}
