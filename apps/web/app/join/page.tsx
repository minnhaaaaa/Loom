import { InvitationAccept } from "@/components/invitation-accept";
export const runtime = "nodejs";
export default function Join() {
  return (
    <main className="join-page">
      <InvitationAccept />
    </main>
  );
}
