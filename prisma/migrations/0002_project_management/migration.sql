ALTER TYPE "AdminRole" ADD VALUE IF NOT EXISTS 'PROJECT_MANAGER';

CREATE TYPE "EventReadinessStatus" AS ENUM ('READY', 'WAITING_FOR_CONFIRMATION', 'AT_RISK', 'INCOMPLETE', 'CHANGED_SINCE_CONFIRMATION', 'CANCELLED');
CREATE TYPE "OperationalAlertStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "OperationalTaskStatus" AS ENUM ('NOT_ACTIVE', 'OPEN', 'DUE_SOON', 'OVERDUE', 'COMPLETED', 'DELETED', 'UNKNOWN');
CREATE TYPE "OperationalTaskSource" AS ENUM ('VSCO_API', 'VSCO_AUTOMATION_WEBHOOK', 'AMM_CALCULATED', 'MANUAL_PROJECT_MANAGER');
CREATE TYPE "ProjectManagerNotificationStatus" AS ENUM ('PLANNED', 'SENT', 'FAILED', 'SUPPRESSED');

ALTER TABLE "Administrator"
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "dailyBriefEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dailyBriefTime" TEXT NOT NULL DEFAULT '08:00',
  ADD COLUMN "notificationChannel" "PreferredChannel" NOT NULL DEFAULT 'EMAIL';

ALTER TABLE "Event"
  ADD COLUMN "readinessStatus" "EventReadinessStatus" NOT NULL DEFAULT 'INCOMPLETE',
  ADD COLUMN "readinessReasons" JSONB,
  ADD COLUMN "readinessCalculatedAt" TIMESTAMP(3),
  ADD COLUMN "administrativeUrl" TEXT,
  ADD COLUMN "internalNotes" TEXT;

ALTER TABLE "Assignment" ADD COLUMN "internalNotes" TEXT;

CREATE TABLE "RequiredRoleRule" (
  "id" TEXT NOT NULL,
  "jobType" TEXT NOT NULL,
  "role" "AssignmentRole" NOT NULL,
  "requiredCount" INTEGER NOT NULL DEFAULT 1,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RequiredRoleRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationalTask" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "source" "OperationalTaskSource" NOT NULL,
  "externalTaskId" TEXT,
  "externalTaskListId" TEXT,
  "eventId" TEXT,
  "vscoJobId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "workflowStage" TEXT,
  "assignedVscoUserId" TEXT,
  "assignedLocalAdministratorId" TEXT,
  "dueAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "status" "OperationalTaskStatus" NOT NULL DEFAULT 'UNKNOWN',
  "priority" TEXT,
  "criticalForReadiness" BOOLEAN NOT NULL DEFAULT false,
  "rawProviderPayload" JSONB,
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperationalTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationalAlert" (
  "id" TEXT NOT NULL,
  "eventId" TEXT,
  "assignmentId" TEXT,
  "personId" TEXT,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "recommendedAction" TEXT,
  "status" "OperationalAlertStatus" NOT NULL DEFAULT 'OPEN',
  "deduplicationKey" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperationalAlert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderCapability" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "supported" BOOLEAN NOT NULL,
  "evidence" TEXT NOT NULL,
  "details" JSONB,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderCapability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectManagerNotification" (
  "id" TEXT NOT NULL,
  "administratorId" TEXT NOT NULL,
  "eventId" TEXT,
  "type" TEXT NOT NULL,
  "channel" "Channel" NOT NULL,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "status" "ProjectManagerNotificationStatus" NOT NULL DEFAULT 'PLANNED',
  "deduplicationKey" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "failureReason" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectManagerNotification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectManagerDailyBrief" (
  "id" TEXT NOT NULL,
  "administratorId" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "deduplicationKey" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectManagerDailyBrief_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RequiredRoleRule_jobType_role_key" ON "RequiredRoleRule"("jobType", "role");
CREATE UNIQUE INDEX "OperationalTask_provider_externalTaskId_key" ON "OperationalTask"("provider", "externalTaskId");
CREATE INDEX "OperationalTask_eventId_status_idx" ON "OperationalTask"("eventId", "status");
CREATE INDEX "OperationalTask_assignedLocalAdministratorId_status_idx" ON "OperationalTask"("assignedLocalAdministratorId", "status");
CREATE UNIQUE INDEX "OperationalAlert_deduplicationKey_key" ON "OperationalAlert"("deduplicationKey");
CREATE INDEX "OperationalAlert_status_severity_idx" ON "OperationalAlert"("status", "severity");
CREATE INDEX "OperationalAlert_eventId_status_idx" ON "OperationalAlert"("eventId", "status");
CREATE UNIQUE INDEX "ProviderCapability_provider_capability_key" ON "ProviderCapability"("provider", "capability");
CREATE UNIQUE INDEX "ProjectManagerNotification_deduplicationKey_key" ON "ProjectManagerNotification"("deduplicationKey");
CREATE INDEX "ProjectManagerNotification_administratorId_status_idx" ON "ProjectManagerNotification"("administratorId", "status");
CREATE UNIQUE INDEX "ProjectManagerDailyBrief_deduplicationKey_key" ON "ProjectManagerDailyBrief"("deduplicationKey");

ALTER TABLE "OperationalTask" ADD CONSTRAINT "OperationalTask_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OperationalTask" ADD CONSTRAINT "OperationalTask_assignedLocalAdministratorId_fkey" FOREIGN KEY ("assignedLocalAdministratorId") REFERENCES "Administrator"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OperationalAlert" ADD CONSTRAINT "OperationalAlert_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OperationalAlert" ADD CONSTRAINT "OperationalAlert_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OperationalAlert" ADD CONSTRAINT "OperationalAlert_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectManagerNotification" ADD CONSTRAINT "ProjectManagerNotification_administratorId_fkey" FOREIGN KEY ("administratorId") REFERENCES "Administrator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectManagerNotification" ADD CONSTRAINT "ProjectManagerNotification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectManagerDailyBrief" ADD CONSTRAINT "ProjectManagerDailyBrief_administratorId_fkey" FOREIGN KEY ("administratorId") REFERENCES "Administrator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
