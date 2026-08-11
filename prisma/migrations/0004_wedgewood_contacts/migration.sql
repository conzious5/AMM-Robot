CREATE TABLE "WedgewoodContact" (
  "id" TEXT NOT NULL,
  "sourceKey" TEXT,
  "venueName" TEXT NOT NULL,
  "contactName" TEXT,
  "teamOrRole" TEXT,
  "email" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "manuallyEdited" BOOLEAN NOT NULL DEFAULT false,
  "rawProviderPayload" JSONB,
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WedgewoodContact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WedgewoodContact_sourceKey_key" ON "WedgewoodContact"("sourceKey");
CREATE INDEX "WedgewoodContact_active_venueName_idx" ON "WedgewoodContact"("active", "venueName");
CREATE INDEX "WedgewoodContact_email_idx" ON "WedgewoodContact"("email");
