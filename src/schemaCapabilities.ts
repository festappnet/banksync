const capabilities = {
 '10': {bankFacts:false,recovery:false}, '11': {bankFacts:true,recovery:false},
 '12': {bankFacts:true,recovery:false}, '13': {bankFacts:true,recovery:true},
 '14': {bankFacts:true,recovery:true},
} as const;
export const SUPPORTED_SCHEMA_VERSIONS=Object.keys(capabilities);
export function schemaCapabilities(version:string|undefined){
 return capabilities[version as keyof typeof capabilities]??capabilities['10'];
}
