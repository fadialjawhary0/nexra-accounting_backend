-- AlterTable
ALTER TABLE "AddressBookEntry" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "ChecklistTemplate" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "ContractDocument" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Counterparty" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "DocumentType" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "ExportPreset" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Folder" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "FolderTemplate" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Holiday" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "HourEntry" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "ImportJob" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "ImportMapping" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "List" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "ListItem" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "MessageTemplate" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "OfficialForm" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "ReminderRule" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "RequiredDocument" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "SalaryStatement" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "SurchargeRule" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "TaxReturn" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "VatPeriod" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- AlterTable
ALTER TABLE "VatStep" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionId" TEXT;

-- CreateTable
CREATE TABLE "Deletion" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "deletedById" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),
    "restoredById" TEXT,

    CONSTRAINT "Deletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Deletion_entityType_entityId_idx" ON "Deletion"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Deletion_deletedAt_idx" ON "Deletion"("deletedAt");

-- CreateIndex
CREATE INDEX "AddressBookEntry_deletedAt_idx" ON "AddressBookEntry"("deletedAt");

-- CreateIndex
CREATE INDEX "AddressBookEntry_deletionId_idx" ON "AddressBookEntry"("deletionId");

-- CreateIndex
CREATE INDEX "CalendarEvent_deletedAt_idx" ON "CalendarEvent"("deletedAt");

-- CreateIndex
CREATE INDEX "CalendarEvent_deletionId_idx" ON "CalendarEvent"("deletionId");

-- CreateIndex
CREATE INDEX "ChecklistTemplate_deletedAt_idx" ON "ChecklistTemplate"("deletedAt");

-- CreateIndex
CREATE INDEX "ChecklistTemplate_deletionId_idx" ON "ChecklistTemplate"("deletionId");

-- CreateIndex
CREATE INDEX "Client_deletedAt_idx" ON "Client"("deletedAt");

-- CreateIndex
CREATE INDEX "Client_deletionId_idx" ON "Client"("deletionId");

-- CreateIndex
CREATE INDEX "Contract_deletedAt_idx" ON "Contract"("deletedAt");

-- CreateIndex
CREATE INDEX "Contract_deletionId_idx" ON "Contract"("deletionId");

-- CreateIndex
CREATE INDEX "ContractDocument_deletedAt_idx" ON "ContractDocument"("deletedAt");

-- CreateIndex
CREATE INDEX "ContractDocument_deletionId_idx" ON "ContractDocument"("deletionId");

-- CreateIndex
CREATE INDEX "Counterparty_deletedAt_idx" ON "Counterparty"("deletedAt");

-- CreateIndex
CREATE INDEX "Counterparty_deletionId_idx" ON "Counterparty"("deletionId");

-- CreateIndex
CREATE INDEX "DocumentType_deletedAt_idx" ON "DocumentType"("deletedAt");

-- CreateIndex
CREATE INDEX "DocumentType_deletionId_idx" ON "DocumentType"("deletionId");

-- CreateIndex
CREATE INDEX "Employee_deletedAt_idx" ON "Employee"("deletedAt");

-- CreateIndex
CREATE INDEX "Employee_deletionId_idx" ON "Employee"("deletionId");

-- CreateIndex
CREATE INDEX "ExportPreset_deletedAt_idx" ON "ExportPreset"("deletedAt");

-- CreateIndex
CREATE INDEX "ExportPreset_deletionId_idx" ON "ExportPreset"("deletionId");

-- CreateIndex
CREATE INDEX "Folder_deletedAt_idx" ON "Folder"("deletedAt");

-- CreateIndex
CREATE INDEX "Folder_deletionId_idx" ON "Folder"("deletionId");

-- CreateIndex
CREATE INDEX "FolderTemplate_deletedAt_idx" ON "FolderTemplate"("deletedAt");

-- CreateIndex
CREATE INDEX "FolderTemplate_deletionId_idx" ON "FolderTemplate"("deletionId");

-- CreateIndex
CREATE INDEX "FormSubmission_deletedAt_idx" ON "FormSubmission"("deletedAt");

-- CreateIndex
CREATE INDEX "FormSubmission_deletionId_idx" ON "FormSubmission"("deletionId");

-- CreateIndex
CREATE INDEX "Holiday_deletedAt_idx" ON "Holiday"("deletedAt");

-- CreateIndex
CREATE INDEX "Holiday_deletionId_idx" ON "Holiday"("deletionId");

-- CreateIndex
CREATE INDEX "HourEntry_deletedAt_idx" ON "HourEntry"("deletedAt");

-- CreateIndex
CREATE INDEX "HourEntry_deletionId_idx" ON "HourEntry"("deletionId");

-- CreateIndex
CREATE INDEX "ImportJob_deletedAt_idx" ON "ImportJob"("deletedAt");

-- CreateIndex
CREATE INDEX "ImportJob_deletionId_idx" ON "ImportJob"("deletionId");

-- CreateIndex
CREATE INDEX "ImportMapping_deletedAt_idx" ON "ImportMapping"("deletedAt");

-- CreateIndex
CREATE INDEX "ImportMapping_deletionId_idx" ON "ImportMapping"("deletionId");

-- CreateIndex
CREATE INDEX "Inspection_deletedAt_idx" ON "Inspection"("deletedAt");

-- CreateIndex
CREATE INDEX "Inspection_deletionId_idx" ON "Inspection"("deletionId");

-- CreateIndex
CREATE INDEX "Invoice_deletedAt_idx" ON "Invoice"("deletedAt");

-- CreateIndex
CREATE INDEX "Invoice_deletionId_idx" ON "Invoice"("deletionId");

-- CreateIndex
CREATE INDEX "List_deletedAt_idx" ON "List"("deletedAt");

-- CreateIndex
CREATE INDEX "List_deletionId_idx" ON "List"("deletionId");

-- CreateIndex
CREATE INDEX "ListItem_deletedAt_idx" ON "ListItem"("deletedAt");

-- CreateIndex
CREATE INDEX "ListItem_deletionId_idx" ON "ListItem"("deletionId");

-- CreateIndex
CREATE INDEX "MessageTemplate_deletedAt_idx" ON "MessageTemplate"("deletedAt");

-- CreateIndex
CREATE INDEX "MessageTemplate_deletionId_idx" ON "MessageTemplate"("deletionId");

-- CreateIndex
CREATE INDEX "OfficialForm_deletedAt_idx" ON "OfficialForm"("deletedAt");

-- CreateIndex
CREATE INDEX "OfficialForm_deletionId_idx" ON "OfficialForm"("deletionId");

-- CreateIndex
CREATE INDEX "ReminderRule_deletedAt_idx" ON "ReminderRule"("deletedAt");

-- CreateIndex
CREATE INDEX "ReminderRule_deletionId_idx" ON "ReminderRule"("deletionId");

-- CreateIndex
CREATE INDEX "RequiredDocument_deletedAt_idx" ON "RequiredDocument"("deletedAt");

-- CreateIndex
CREATE INDEX "RequiredDocument_deletionId_idx" ON "RequiredDocument"("deletionId");

-- CreateIndex
CREATE INDEX "Role_deletedAt_idx" ON "Role"("deletedAt");

-- CreateIndex
CREATE INDEX "Role_deletionId_idx" ON "Role"("deletionId");

-- CreateIndex
CREATE INDEX "SalaryStatement_deletedAt_idx" ON "SalaryStatement"("deletedAt");

-- CreateIndex
CREATE INDEX "SalaryStatement_deletionId_idx" ON "SalaryStatement"("deletionId");

-- CreateIndex
CREATE INDEX "StoredFile_deletedAt_idx" ON "StoredFile"("deletedAt");

-- CreateIndex
CREATE INDEX "StoredFile_deletionId_idx" ON "StoredFile"("deletionId");

-- CreateIndex
CREATE INDEX "SurchargeRule_deletedAt_idx" ON "SurchargeRule"("deletedAt");

-- CreateIndex
CREATE INDEX "SurchargeRule_deletionId_idx" ON "SurchargeRule"("deletionId");

-- CreateIndex
CREATE INDEX "Task_deletedAt_idx" ON "Task"("deletedAt");

-- CreateIndex
CREATE INDEX "Task_deletionId_idx" ON "Task"("deletionId");

-- CreateIndex
CREATE INDEX "TaxReturn_deletedAt_idx" ON "TaxReturn"("deletedAt");

-- CreateIndex
CREATE INDEX "TaxReturn_deletionId_idx" ON "TaxReturn"("deletionId");

-- CreateIndex
CREATE INDEX "Template_deletedAt_idx" ON "Template"("deletedAt");

-- CreateIndex
CREATE INDEX "Template_deletionId_idx" ON "Template"("deletionId");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE INDEX "User_deletionId_idx" ON "User"("deletionId");

-- CreateIndex
CREATE INDEX "VatPeriod_deletedAt_idx" ON "VatPeriod"("deletedAt");

-- CreateIndex
CREATE INDEX "VatPeriod_deletionId_idx" ON "VatPeriod"("deletionId");

-- CreateIndex
CREATE INDEX "VatStep_deletedAt_idx" ON "VatStep"("deletedAt");

-- CreateIndex
CREATE INDEX "VatStep_deletionId_idx" ON "VatStep"("deletionId");

