import {fioMovementId,type FioStatement} from './fio';

/** These are proof coordinates, not numeric maxima. Movement IDs are opaque.
 * idLastDownload describes the preceding bank checkpoint in documented samples;
 * idTo, when present, names the last movement of this returned selection.
 */
export interface FioCursorProof {
  committedId:string|null;
  reportedId:string|null;
  batchIds:string[];
}

export function verifyFioCursor(statement:FioStatement, previous:FioCursorProof, afterDateReset=false):FioCursorProof {
  const ids=statement.transactions.map(row=>{
    const id=fioMovementId(row.column22?.value);
    if(id===null) throw new Error('fio_unverified_movement');
    return id;
  });
  if(new Set(ids).size!==ids.length) throw new Error('fio_duplicate_statement_identity');
  const reportedId=fioMovementId(statement.info.idLastDownload);
  const known=new Set([previous.committedId,previous.reportedId,...previous.batchIds].filter((id):id is string=>id!==null));
  // A reset to a date establishes the scope independently of the old ID the
  // header may still report. Otherwise an unknown marker indicates another
  // writer or an unrecorded response, and must trigger recovery before commit.
  if(!afterDateReset && reportedId!==null && !known.has(reportedId)) {
    throw new Error('fio_cursor_drift');
  }
  const last=fioMovementId(statement.info.idTo);
  const first=fioMovementId(statement.info.idFrom);
  if((last!==null&&!ids.includes(last)) || (first!==null&&!ids.includes(first))) throw new Error('fio_cursor_not_in_statement');
  // Every current row must be imported before committing this returned proof.
  // Never advance to an arbitrary reported marker after a date reset.
  const provenReported=reportedId!==null && (previous.batchIds.includes(reportedId)||ids.includes(reportedId)||reportedId===previous.committedId);
  return {committedId:last??(provenReported?reportedId:previous.committedId),reportedId,batchIds:ids};
}
