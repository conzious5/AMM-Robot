export function communicationChannelLabel(channel: string) {
  if (channel === "SMS") return "Text message";
  if (channel === "EMAIL") return "Email";
  return channel.replaceAll("_", " ").toLowerCase();
}
