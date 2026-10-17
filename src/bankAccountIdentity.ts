/** Receiving-account normalization for bank polling leases and health facts. */
export function canonicalIban(value:string):string {
 let iban=value.replace(/\s/g,'').toUpperCase();
 const local=iban.match(/^(?:(\d{1,6})-)?(\d{1,10})\/(\d{4})$/);
 if(local){const bban=local[3]!+(local[1]??'').padStart(6,'0')+local[2]!.padStart(10,'0');const checksum=98-Number(BigInt(bban+'123500')%97n);iban='CZ'+String(checksum).padStart(2,'0')+bban;}
 if(!/^CZ\d{22}$/.test(iban)||BigInt((iban.slice(4)+iban.slice(0,4)).replace(/[A-Z]/g,c=>String(c.charCodeAt(0)-55)))%97n!==1n)throw Error('invalid_iban');return iban;
}
