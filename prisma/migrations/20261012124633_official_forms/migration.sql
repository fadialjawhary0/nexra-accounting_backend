-- CreateTable
CREATE TABLE "AddressBookEntry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department" TEXT NOT NULL DEFAULT '',
    "street" TEXT NOT NULL DEFAULT '',
    "houseNumber" TEXT NOT NULL DEFAULT '',
    "houseNumberSuffix" TEXT NOT NULL DEFAULT '',
    "box" TEXT NOT NULL DEFAULT '',
    "boxKind" TEXT NOT NULL DEFAULT 'po_box',
    "postalCode" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT 'NL',
    "category" TEXT NOT NULL DEFAULT 'other',
    "note" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "searchText" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "AddressBookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficialForm" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameNl" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "descriptionNl" TEXT NOT NULL DEFAULT '',
    "descriptionEn" TEXT NOT NULL DEFAULT '',
    "authorityCode" TEXT NOT NULL DEFAULT '',
    "officialUrl" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT 'client',
    "periodKind" TEXT NOT NULL DEFAULT 'none',
    "recipientId" TEXT,
    "followUpDays" INTEGER,
    "warnWhenPending" BOOLEAN NOT NULL DEFAULT false,
    "docType" TEXT NOT NULL DEFAULT 'form',
    "folderCode" TEXT,
    "namePattern" TEXT NOT NULL DEFAULT '{type}_{number}_{date}',
    "flatten" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficialForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficialFormVersion" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 1,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "mapping" JSONB NOT NULL DEFAULT '[]',
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficialFormVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "employeeId" TEXT,
    "personId" TEXT,
    "periodStart" DATE,
    "periodEnd" DATE,
    "fileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "preparedOn" DATE NOT NULL,
    "sentOn" DATE,
    "doneOn" DATE,
    "followUpOn" DATE,
    "recipientId" TEXT,
    "recipientText" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "values" JSONB NOT NULL DEFAULT '{}',
    "hasPersonalData" BOOLEAN NOT NULL DEFAULT false,
    "usedAi" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "deactivationReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "searchText" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AddressBookEntry_isActive_category_idx" ON "AddressBookEntry"("isActive", "category");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialForm_code_key" ON "OfficialForm"("code");

-- CreateIndex
CREATE INDEX "OfficialForm_isActive_sortOrder_idx" ON "OfficialForm"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialFormVersion_fileId_key" ON "OfficialFormVersion"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialFormVersion_formId_version_key" ON "OfficialFormVersion"("formId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FormSubmission_fileId_key" ON "FormSubmission"("fileId");

-- CreateIndex
CREATE INDEX "FormSubmission_clientId_isActive_idx" ON "FormSubmission"("clientId", "isActive");

-- CreateIndex
CREATE INDEX "FormSubmission_formId_status_idx" ON "FormSubmission"("formId", "status");

-- CreateIndex
CREATE INDEX "FormSubmission_status_followUpOn_idx" ON "FormSubmission"("status", "followUpOn");

-- CreateIndex
CREATE INDEX "FormSubmission_preparedOn_idx" ON "FormSubmission"("preparedOn");

-- AddForeignKey
ALTER TABLE "OfficialForm" ADD CONSTRAINT "OfficialForm_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "AddressBookEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialFormVersion" ADD CONSTRAINT "OfficialFormVersion_formId_fkey" FOREIGN KEY ("formId") REFERENCES "OfficialForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "OfficialForm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "OfficialFormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "AddressBookEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Staff can open the library and the log of sent forms and fill a form in (changing the library and the address book stays with the owner).
UPDATE "Role" SET "permissions" = "permissions" || '{"official_forms": ["view", "create"]}'::jsonb WHERE "key" = 'medewerker' AND NOT ("permissions" ? 'official_forms');
