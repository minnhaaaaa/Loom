import { randomUUID } from 'node:crypto';
import { openConnection } from '@loom/db-exasol';
const connection=await openConnection();
const id=randomUUID();
try {
  const [{VALUE}]=await connection.session.query('SELECT CAST(? AS DECIMAL(18,0)) AS VALUE FROM DUAL',[42]);
  if(Number(VALUE)!==42) throw new Error('Prepared binding failed.');
  await connection.session.execute('INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)',[id,'Rollback check']);
  let duplicateRejected=false;
  try { await connection.session.execute('INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)',[id,'Duplicate must fail']); }
  catch { duplicateRejected=true; }
  await connection.rollback();
  if(!duplicateRejected) throw new Error('Enabled primary key did not reject a duplicate.');
  const rows=await connection.session.query('SELECT ID FROM WORKSPACES WHERE ID = ?',[id]);
  if(rows.length) throw new Error('Rollback left a row behind.');
  const [mapping]=await connection.session.query("SELECT CAST(? AS TIMESTAMP) AS UTC_VALUE, CAST(? AS DECIMAL(18,0)) AS EXACT_VALUE, CAST(? AS VARCHAR(10)) AS EMPTY_VALUE FROM DUAL",['2026-10-21 12:00:00.123','9007199254740991','']);
  if(Number(mapping.EXACT_VALUE)!==9007199254740991 || mapping.EMPTY_VALUE!==null) throw new Error('Unexpected scalar mapping.');
  console.log(JSON.stringify({ok:true,checks:['TLS connection','prepared bindings','enabled primary key','rollback','exact numeric and empty-string mapping'],timestamp:mapping.UTC_VALUE},null,2));
} catch(error) { await connection.rollback().catch(()=>undefined); console.error(error instanceof Error ? error.message : 'Exasol check failed.'); process.exitCode=1; }
finally { await connection.close(); }
