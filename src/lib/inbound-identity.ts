import type { PersonRole } from "@prisma/client";

const paidContractorRoles = new Set<PersonRole>([
  "PHOTOGRAPHER",
  "VIDEOGRAPHER",
  "BOTH",
]);

export function isActiveInboundContractor(person: {
  role: PersonRole;
  active: boolean;
  paused: boolean;
}) {
  return person.active &&
    !person.paused &&
    paidContractorRoles.has(person.role);
}
