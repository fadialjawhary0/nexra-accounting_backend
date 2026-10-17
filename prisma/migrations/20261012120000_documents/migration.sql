-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "isCurrent" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "previewKey" TEXT,
ADD COLUMN     "rootId" TEXT,
ADD COLUMN     "validUntil" DATE,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "DocumentType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameNl" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'client',
    "validity" TEXT NOT NULL DEFAULT 'none',
    "validityMonths" INTEGER,
    "validityField" TEXT,
    "warnDays" INTEGER,
    "versioned" BOOLEAN NOT NULL DEFAULT false,
    "personal" BOOLEAN NOT NULL DEFAULT false,
    "folderCode" TEXT,
    "namePattern" TEXT NOT NULL DEFAULT '',
    "keywords" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FolderTemplate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "parentCode" TEXT,
    "nameNl" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FolderTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequiredDocument" (
    "id" TEXT NOT NULL,
    "typeCode" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "condition" JSONB,
    "note" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RequiredDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLink" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentText" (
    "fileId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "searchText" TEXT NOT NULL DEFAULT '',
    "pages" INTEGER,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentText_pkey" PRIMARY KEY ("fileId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_code_key" ON "DocumentType"("code");

-- CreateIndex
CREATE INDEX "DocumentType_isActive_sortOrder_idx" ON "DocumentType"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "FolderTemplate_code_key" ON "FolderTemplate"("code");

-- CreateIndex
CREATE INDEX "RequiredDocument_scope_isActive_idx" ON "RequiredDocument"("scope", "isActive");

-- CreateIndex
CREATE INDEX "DocumentLink_entityType_entityId_idx" ON "DocumentLink"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLink_fileId_entityType_entityId_key" ON "DocumentLink"("fileId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "DocumentText_searchText_idx" ON "DocumentText" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "StoredFile_clientId_isActive_idx" ON "StoredFile"("clientId", "isActive");

-- CreateIndex
CREATE INDEX "StoredFile_rootId_idx" ON "StoredFile"("rootId");

-- CreateIndex
CREATE INDEX "StoredFile_validUntil_idx" ON "StoredFile"("validUntil");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FolderTemplate" ADD CONSTRAINT "FolderTemplate_parentCode_fkey" FOREIGN KEY ("parentCode") REFERENCES "FolderTemplate"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequiredDocument" ADD CONSTRAINT "RequiredDocument_typeCode_fkey" FOREIGN KEY ("typeCode") REFERENCES "DocumentType"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentText" ADD CONSTRAINT "DocumentText_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Data: the two pick-lists that became tables, and what the files already know.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

-- The standard folders of a client (list `client_folder`) become the folder template; names, order and switched-off folders are kept.
INSERT INTO "FolderTemplate" ("id", "code", "parentCode", "nameNl", "nameEn", "sortOrder", "isActive", "isSystem", "updatedAt")
SELECT 'ft_' || li."code", li."code", NULL, li."nameNl", li."nameEn", li."sortOrder", li."isActive", li."isSystem", CURRENT_TIMESTAMP
FROM "ListItem" li JOIN "List" l ON l."id" = li."listId"
WHERE l."key" = 'client_folder';

-- The document types (list `document_type`) become DocumentType rows; the types the import and the generators know get their rules.
INSERT INTO "DocumentType" ("id", "code", "nameNl", "nameEn", "scope", "validity", "validityMonths", "validityField", "warnDays", "versioned", "personal", "folderCode", "namePattern", "sortOrder", "isActive", "isSystem", "updatedAt")
SELECT
  'dt_' || li."code", li."code", li."nameNl", li."nameEn",
  COALESCE(k."scope", 'any'), COALESCE(k."validity", 'none'), k."months", k."field", k."warn",
  COALESCE(k."versioned", false), COALESCE(k."personal", false), k."folder", COALESCE(k."pattern", ''),
  li."sortOrder", li."isActive", li."isSystem" OR k."code" IS NOT NULL, CURRENT_TIMESTAMP
FROM "ListItem" li
JOIN "List" l ON l."id" = li."listId"
LEFT JOIN (VALUES
  ('id_document',      'worker', 'field', NULL::int, 'id_expiry',     NULL::int, true,  true,  NULL,             '{worker} - {type}'),
  ('residence_permit', 'worker', 'field', NULL::int, 'permit_expiry', NULL::int, true,  true,  NULL,             '{worker} - {type}'),
  ('kvk_extract',      'client', 'age',   3,         NULL,            14,        true,  false, 'company_data',   '{number} - {type} {date}'),
  ('contract',         'worker', 'none',  NULL::int, NULL,            NULL::int, false, false, NULL,             '{worker} - {type} {date}'),
  ('staffing_invoice', 'client', 'none',  NULL::int, NULL,            NULL::int, false, false, 'hours_invoices', ''),
  ('invoice',          'client', 'none',  NULL::int, NULL,            NULL::int, false, false, 'hours_invoices', ''),
  ('timesheet',        'any',    'none',  NULL::int, NULL,            NULL::int, false, false, 'hours_invoices', ''),
  ('payslip',          'worker', 'none',  NULL::int, NULL,            NULL::int, false, false, NULL,             '{worker} - {type} {date}'),
  ('letter',           'any',    'none',  NULL::int, NULL,            NULL::int, false, false, NULL,             ''),
  ('tax_return',       'client', 'none',  NULL::int, NULL,            NULL::int, false, false, 'taxes',          ''),
  ('inspection',       'client', 'none',  NULL::int, NULL,            NULL::int, false, false, 'inspections',    ''),
  ('g_account',        'client', 'none',  NULL::int, NULL,            NULL::int, false, false, 'g_account',      '{number} - {type} {date}'),
  ('form',             'client', 'none',  NULL::int, NULL,            NULL::int, false, false, 'forms',          ''),
  ('other',            'any',    'none',  NULL::int, NULL,            NULL::int, false, false, NULL,             '')
) AS k("code", "scope", "validity", "months", "field", "warn", "versioned", "personal", "folder", "pattern") ON k."code" = li."code"
WHERE l."key" = 'document_type';

DELETE FROM "List" WHERE "key" IN ('client_folder', 'document_type');

-- Every document says which client it belongs to: its folder, else its client, else its worker's client.
UPDATE "StoredFile" f SET "clientId" = fo."clientId" FROM "Folder" fo WHERE f."folderId" = fo."id" AND f."clientId" IS NULL;
UPDATE "StoredFile" f SET "clientId" = c."id" FROM "Client" c WHERE f."entityType" = 'client' AND f."entityId" = c."id" AND f."clientId" IS NULL;
UPDATE "StoredFile" f SET "clientId" = e."clientId" FROM "Employee" e WHERE f."entityType" = 'employee' AND f."entityId" = e."id" AND f."clientId" IS NULL;

-- What the files the system made are: contracts, letters, invoices and payslips-like statements.
UPDATE "StoredFile" f SET "docType" = 'contract' WHERE f."purpose" IN ('contract_scan', 'contract_document') AND f."docType" IS NULL;
UPDATE "StoredFile" f SET "docType" = 'letter' FROM "ContractDocument" d WHERE d."kind" = 'letter' AND (d."fileId" = f."id" OR d."pdfFileId" = f."id");
UPDATE "StoredFile" f SET "docType" = CASE WHEN i."direction" = 'incoming' THEN 'staffing_invoice' ELSE 'invoice' END FROM "Invoice" i WHERE (i."fileId" = f."id" OR i."pdfFileId" = f."id") AND f."docType" IS NULL;
UPDATE "StoredFile" f SET "docType" = 'invoice' WHERE f."purpose" = 'invoice_document' AND f."docType" IS NULL;
UPDATE "StoredFile" f SET "docType" = 'payslip' WHERE f."purpose" = 'salary_statement' AND f."docType" IS NULL;

-- Staff can open the Documents page (they already see the clients' files they may open).
UPDATE "Role" SET "permissions" = "permissions" || '{"documents": ["view"]}'::jsonb WHERE "key" = 'medewerker' AND NOT ("permissions" ? 'documents');
