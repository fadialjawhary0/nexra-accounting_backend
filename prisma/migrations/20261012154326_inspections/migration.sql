-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "periodFrom" DATE,
ADD COLUMN     "periodTo" DATE;

-- CreateTable
CREATE TABLE "ChecklistTemplate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameNl" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "descriptionNl" TEXT NOT NULL DEFAULT '',
    "descriptionEn" TEXT NOT NULL DEFAULT '',
    "inspectionTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "sections" JSONB NOT NULL DEFAULT '[]',
    "items" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "outcome" TEXT,
    "inspectorName" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL DEFAULT '',
    "date" DATE NOT NULL,
    "periodFrom" DATE,
    "periodTo" DATE,
    "responseDue" DATE,
    "versionId" TEXT,
    "assigneeId" TEXT,
    "findings" TEXT NOT NULL DEFAULT '',
    "requestText" TEXT NOT NULL DEFAULT '',
    "folderId" TEXT,
    "closedOn" DATE,
    "snapshot" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "deactivationReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "searchText" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionItem" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "code" TEXT,
    "label" TEXT NOT NULL DEFAULT '',
    "decision" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "dueDate" DATE,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionItemFile" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionItemFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionFollowUp" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "dueDate" DATE,
    "doneOn" DATE,
    "assigneeId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionHandover" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "toName" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "manifest" JSONB NOT NULL DEFAULT '{}',
    "bsnAccepted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionHandover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistTemplate_code_key" ON "ChecklistTemplate"("code");

-- CreateIndex
CREATE INDEX "ChecklistTemplate_isActive_sortOrder_idx" ON "ChecklistTemplate"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "ChecklistVersion_templateId_status_idx" ON "ChecklistVersion"("templateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistVersion_templateId_version_key" ON "ChecklistVersion"("templateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_number_key" ON "Inspection"("number");

-- CreateIndex
CREATE INDEX "Inspection_clientId_date_idx" ON "Inspection"("clientId", "date");

-- CreateIndex
CREATE INDEX "Inspection_status_date_idx" ON "Inspection"("status", "date");

-- CreateIndex
CREATE INDEX "Inspection_isActive_date_idx" ON "Inspection"("isActive", "date");

-- CreateIndex
CREATE INDEX "Inspection_date_idx" ON "Inspection"("date");

-- CreateIndex
CREATE INDEX "Inspection_searchText_idx" ON "Inspection" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "InspectionItem_inspectionId_idx" ON "InspectionItem"("inspectionId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionItem_inspectionId_code_key" ON "InspectionItem"("inspectionId", "code");

-- CreateIndex
CREATE INDEX "InspectionItemFile_fileId_idx" ON "InspectionItemFile"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionItemFile_itemId_fileId_key" ON "InspectionItemFile"("itemId", "fileId");

-- CreateIndex
CREATE INDEX "InspectionFollowUp_inspectionId_idx" ON "InspectionFollowUp"("inspectionId");

-- CreateIndex
CREATE INDEX "InspectionFollowUp_doneOn_dueDate_idx" ON "InspectionFollowUp"("doneOn", "dueDate");

-- CreateIndex
CREATE INDEX "InspectionHandover_inspectionId_at_idx" ON "InspectionHandover"("inspectionId", "at");

-- AddForeignKey
ALTER TABLE "ChecklistVersion" ADD CONSTRAINT "ChecklistVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ChecklistVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionItem" ADD CONSTRAINT "InspectionItem_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionItemFile" ADD CONSTRAINT "InspectionItemFile_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InspectionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionItemFile" ADD CONSTRAINT "InspectionItemFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionFollowUp" ADD CONSTRAINT "InspectionFollowUp_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionHandover" ADD CONSTRAINT "InspectionHandover_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
