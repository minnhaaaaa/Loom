import { currentAccount, endpoint } from "@/server/http";
export const runtime = "nodejs";
export const GET = endpoint(async () => currentAccount());
