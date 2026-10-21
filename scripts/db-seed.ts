import { personas, workspaceId, secondWorkspaceId } from '@loom/contracts';
import { sampleRequests } from '../packages/contracts/src/fixtures';
import { sqlTimestamp, writeDatabase } from '@loom/db-exasol';
try {
  await writeDatabase(async sql=>{
    const rows=await sql.query('SELECT ID FROM WORKSPACES WHERE ID = ?',[workspaceId]);
    if(rows.length) { console.log('Synthetic workspace already exists; no records changed.'); return; }
    for(const [id,name] of [[workspaceId,'Analytics desk'],[secondWorkspaceId,'Isolation fixture']]) {
      await sql.execute('INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)',[id,name]);
      for(const p of personas) await sql.execute('INSERT INTO MEMBERSHIPS (WORKSPACE_ID,USER_ID,NAME,ROLE,ACTIVE) VALUES (?,?,?,?,TRUE)',[id,p.id,p.name,p.role]);
    }
    for(const r of sampleRequests) {
      await sql.execute('INSERT INTO REQUESTS (WORKSPACE_ID,ID,REQUESTER_ID,TITLE,BUSINESS_QUESTION,REPORTING_PERIOD,DATASET,OWNER_ID,PRIORITY,STATUS,DUE_AT,VERSION,CREATED_AT,UPDATED_AT) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[r.workspaceId,r.id,r.requesterId,r.title,r.businessQuestion,r.reportingPeriod||null,r.dataset||null,r.ownerId,r.priority,r.status,r.dueAt,r.version,sqlTimestamp(r.createdAt),sqlTimestamp(r.updatedAt)]);
      await sql.execute('INSERT INTO REQUEST_EVENTS (WORKSPACE_ID,ID,REQUEST_ID,ACTOR_ID,ACTION,VERSION,STATUS,SNAPSHOT_JSON,CREATED_AT) VALUES (?,?,?,?,?,?,?,?,?)',[workspaceId,r.id,r.id,r.requesterId,'seeded',1,r.status,JSON.stringify(r),sqlTimestamp(r.createdAt)]);
    }
  });
  console.log('Synthetic fixtures ready.');
} catch(error) { console.error(error instanceof Error ? error.message : 'Seed failed.'); process.exitCode=1; }
