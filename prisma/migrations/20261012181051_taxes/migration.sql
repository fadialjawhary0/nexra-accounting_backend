-- CreateTable
CREATE TABLE "VatStep" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameNl" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "groupNl" TEXT NOT NULL DEFAULT '',
    "groupEn" TEXT NOT NULL DEFAULT '',
    "isFiling" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VatStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VatPeriod" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "ticks" JSONB NOT NULL DEFAULT '{}',
    "completedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "deactivationReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VatPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxReturn" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "personId" TEXT,
    "taxYear" INTEGER NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "assigneeId" TEXT,
    "filedOn" DATE,
    "fileId" TEXT,
    "extensionStatus" TEXT,
    "extensionRequestedOn" DATE,
    "extensionUntil" DATE,
    "extensionSubmissionId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "deactivationReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VatStep_code_key" ON "VatStep"("code");

-- CreateIndex
CREATE INDEX "VatStep_isActive_sortOrder_idx" ON "VatStep"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "VatPeriod_kind_periodStart_isActive_idx" ON "VatPeriod"("kind", "periodStart", "isActive");

-- CreateIndex
CREATE INDEX "VatPeriod_periodEnd_completedAt_idx" ON "VatPeriod"("periodEnd", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VatPeriod_clientId_kind_periodStart_key" ON "VatPeriod"("clientId", "kind", "periodStart");

-- CreateIndex
CREATE INDEX "TaxReturn_kind_taxYear_status_idx" ON "TaxReturn"("kind", "taxYear", "status");

-- CreateIndex
CREATE INDEX "TaxReturn_clientId_kind_idx" ON "TaxReturn"("clientId", "kind");

-- CreateIndex
CREATE INDEX "TaxReturn_isActive_status_idx" ON "TaxReturn"("isActive", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TaxReturn_kind_clientId_personId_taxYear_key" ON "TaxReturn"("kind", "clientId", "personId", "taxYear");

-- AddForeignKey
ALTER TABLE "VatPeriod" ADD CONSTRAINT "VatPeriod_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturn" ADD CONSTRAINT "TaxReturn_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturn" ADD CONSTRAINT "TaxReturn_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The permission area "tax_forms" is now called "taxes" (the VAT tracker and the yearly returns replace the tax-form prototype): carry what roles and people already hold over.
UPDATE "Role"
SET "permissions" = ("permissions" - 'tax_forms') || jsonb_build_object('taxes', "permissions" -> 'tax_forms')
WHERE jsonb_exists("permissions", 'tax_forms');

UPDATE "User"
SET "permissionOverrides" = ("permissionOverrides" - 'tax_forms') || jsonb_build_object('taxes', "permissionOverrides" -> 'tax_forms')
WHERE jsonb_exists("permissionOverrides", 'tax_forms');
