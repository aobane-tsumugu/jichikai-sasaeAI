/** ファイルやDBへ書かず、区の写しから復元用SQLを作る。 */
export function snapshotToSql(snapshot: unknown): { sql: string; statements: number; referenceUpdates: number };
