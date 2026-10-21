import { z } from 'zod';
import { details } from '@/server/desk';
import { endpoint, requireActor } from '@/server/http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{id:string}>}) {
  const params=await context.params;
  return endpoint(async()=>details(await requireActor(),z.uuid().parse(params.id)))(request);
}
