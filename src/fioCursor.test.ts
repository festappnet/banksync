import {describe,it,expect} from 'vitest';
import {verifyFioCursor,type FioCursorProof} from './fioCursor';
import type {FioStatement} from './fio';
const empty:FioCursorProof={committedId:null,reportedId:null,batchIds:[]};
function statement(ids:string[],info:Record<string,unknown>):FioStatement {
  return {info,transactions:ids.map(id=>({column22:{value:id}}))};
}
describe('Fio checkpoint proof',()=>{
  it('uses the bank selection endpoint without assuming ID or array ordering',()=>{
    expect(verifyFioCursor(statement(['999','10','500'],{idLastDownload:'1',idFrom:'999',idTo:'10'}),empty,true))
      .toEqual({committedId:'10',reportedId:'1',batchIds:['999','10','500']});
  });
  it('confirms the preceding imported response when /last supplies no idTo',()=>{
    const first=verifyFioCursor(statement(['100','101'],{idLastDownload:'90',idTo:null}),empty,true);
    expect(first.committedId).toBeNull();
    const second=verifyFioCursor(statement(['102'],{idLastDownload:'101',idTo:null}),first);
    expect(second.committedId).toBe('101');
    expect(verifyFioCursor(statement([],{idLastDownload:'102'}),second).committedId).toBe('102');
  });
  it('does not turn an unproven old header into the date-bootstrap recovery anchor',()=>{
    const first=verifyFioCursor(statement([],{idLastDownload:'90'}),empty,true);
    expect(first.committedId).toBeNull();
    expect(verifyFioCursor(statement([],{idLastDownload:'90'}),first).committedId).toBeNull();
  });
  it('detects another cursor writer before accepting an apparently valid end ID',()=>{
    const previous={committedId:'100',reportedId:'90',batchIds:['100']};
    expect(()=>verifyFioCursor(statement(['202'],{idLastDownload:'201',idTo:'202'}),previous)).toThrow('fio_cursor_drift');
  });
  it('rejects malformed endpoints, duplicate rows and rounded IDs',()=>{
    expect(()=>verifyFioCursor(statement(['100'],{idTo:'101'}),empty,true)).toThrow('fio_cursor_not_in_statement');
    expect(()=>verifyFioCursor(statement(['100','100'],{}),empty,true)).toThrow('fio_duplicate_statement_identity');
    expect(()=>verifyFioCursor({info:{},transactions:[{column22:{value:9007199254740992}}]},empty,true)).toThrow('unsafe_fio_identity');
  });
  it('preserves IDs larger than the JS integer range as exact text',()=>{
    expect(verifyFioCursor(statement(['9007199254740993'],{idTo:'9007199254740993'}),empty,true).committedId).toBe('9007199254740993');
  });
});
