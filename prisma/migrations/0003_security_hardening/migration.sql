BEGIN;

ALTER TABLE "Administrator"
ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AuthenticationAttempt" (
  "id" TEXT NOT NULL,
  "identityHash" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "successful" BOOLEAN NOT NULL DEFAULT false,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthenticationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuthenticationAttempt_kind_identityHash_attemptedAt_idx"
ON "AuthenticationAttempt"("kind", "identityHash", "attemptedAt");

CREATE INDEX "AuthenticationAttempt_attemptedAt_idx"
ON "AuthenticationAttempt"("attemptedAt");

COMMIT;
