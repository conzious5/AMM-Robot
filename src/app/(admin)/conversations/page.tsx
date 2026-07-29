import { db } from "@/lib/db";
import { communicationChannelLabel } from "@/lib/channels";
import { DataTable } from "@/components/DataTable";

export default async function Page() {
  const data = await db.conversation.findMany({
    include: { person: true, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { lastMessageAt: "desc" },
  });
  return (
    <>
      <h1>Conversations</h1>
      <DataTable
        columns={["Person", "Communication", "Latest message", "Status", "Attention"]}
        rows={data.map(conversation => [
          conversation.person.displayName,
          communicationChannelLabel(conversation.channel),
          conversation.messages[0]?.textContent ?? "No messages",
          conversation.status,
          conversation.needsAttention ? <span className="danger" key="attention">Needs attention</span> : "—",
        ])}
      />
    </>
  );
}
