import type { Prisma } from "@prisma/client";

export const launchCutoffMarker = "[LAUNCH_CUTOFF_EXCLUDED]";

export const launchIncludedEventWhere = {
  OR: [
    { internalNotes: null },
    { NOT: { internalNotes: { contains: launchCutoffMarker } } },
  ],
} satisfies Prisma.EventWhereInput;

export function isLaunchCutoffExcluded(internalNotes: string | null | undefined) {
  return Boolean(internalNotes?.includes(launchCutoffMarker));
}
