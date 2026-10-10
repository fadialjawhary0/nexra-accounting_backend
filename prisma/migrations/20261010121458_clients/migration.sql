-- The permission area "companies" is now called "clients": carry what roles, people and files already hold over to the new key.
UPDATE "Role"
SET "permissions" = ("permissions" - 'companies') || jsonb_build_object('clients', "permissions" -> 'companies')
WHERE jsonb_exists("permissions", 'companies');

UPDATE "User"
SET "permissionOverrides" = ("permissionOverrides" - 'companies') || jsonb_build_object('clients', "permissionOverrides" -> 'companies')
WHERE jsonb_exists("permissionOverrides", 'companies');

UPDATE "StoredFile" SET "area" = 'clients' WHERE "area" = 'companies';

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "folderId" TEXT;

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalForm" TEXT,
    "kvk" TEXT,
    "vatNumber" TEXT,
    "responsibleUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "stoppedOn" DATE,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "deactivationReason" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL DEFAULT '{}',
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "searchText" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "deactivationReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPerson" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "startedOn" DATE,
    "endedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientRelation" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "templateCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UniqueFieldValue" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,

    CONSTRAINT "UniqueFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_number_key" ON "Client"("number");

-- CreateIndex
CREATE INDEX "Client_isActive_idx" ON "Client"("isActive");

-- CreateIndex
CREATE INDEX "Client_legalForm_idx" ON "Client"("legalForm");

-- CreateIndex
CREATE INDEX "Client_data_idx" ON "Client" USING GIN ("data");

-- CreateIndex
CREATE INDEX "Client_searchText_idx" ON "Client" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Person_lastName_firstName_idx" ON "Person"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "ClientPerson_personId_idx" ON "ClientPerson"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPerson_clientId_personId_role_key" ON "ClientPerson"("clientId", "personId", "role");

-- CreateIndex
CREATE INDEX "ClientRelation_toId_idx" ON "ClientRelation"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientRelation_fromId_toId_kind_key" ON "ClientRelation"("fromId", "toId", "kind");

-- CreateIndex
CREATE INDEX "Folder_clientId_parentId_idx" ON "Folder"("clientId", "parentId");

-- CreateIndex
CREATE INDEX "UniqueFieldValue_entity_recordId_idx" ON "UniqueFieldValue"("entity", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "UniqueFieldValue_entity_fieldKey_value_key" ON "UniqueFieldValue"("entity", "fieldKey", "value");

-- CreateIndex
CREATE INDEX "StoredFile_folderId_idx" ON "StoredFile"("folderId");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPerson" ADD CONSTRAINT "ClientPerson_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPerson" ADD CONSTRAINT "ClientPerson_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRelation" ADD CONSTRAINT "ClientRelation_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRelation" ADD CONSTRAINT "ClientRelation_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
