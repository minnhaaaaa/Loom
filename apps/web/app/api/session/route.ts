import { z } from 'zod';
import { endSession, endpoint, jsonBody, startSession } from '@/server/http';
export const runtime='nodejs';
export const POST=endpoint(async request=>{const {userId}=z.object({userId:z.uuid()}).strict().parse(await jsonBody(request));await startSession(userId);return {ok:true};},true);
export const DELETE=endpoint(async()=>{await endSession();return {ok:true};},true);
