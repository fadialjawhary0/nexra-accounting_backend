-- AlterTable
ALTER TABLE "PeriodLock" ADD COLUMN     "invoiceId" TEXT;

-- CreateTable
CREATE TABLE "Counterparty" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kvk" TEXT,
    "vatNumber" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "searchText" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "deactivationReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'invoice',
    "clientId" TEXT NOT NULL,
    "counterpartyId" TEXT,
    "otherClientId" TEXT,
    "number" TEXT,
    "invoiceDate" DATE,
    "dueDate" DATE,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "vatPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "vatShifted" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gAccountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "gAccountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paidOn" DATE,
    "locale" TEXT NOT NULL DEFAULT 'nl',
    "note" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL DEFAULT '{}',
    "searchText" TEXT NOT NULL DEFAULT '',
    "fileId" TEXT,
    "pdfFileId" TEXT,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "creditOfId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "issuedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'hours',
    "employeeId" TEXT,
    "rawName" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "fromDate" DATE,
    "toDate" DATE,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "rate" DECIMAL(10,2),
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceCounter" (
    "clientId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("clientId","year")
);

-- CreateIndex
CREATE INDEX "Counterparty_isActive_idx" ON "Counterparty"("isActive");

-- CreateIndex
CREATE INDEX "Counterparty_kvk_idx" ON "Counterparty"("kvk");

-- CreateIndex
CREATE INDEX "Counterparty_searchText_idx" ON "Counterparty" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Invoice_clientId_direction_status_idx" ON "Invoice"("clientId", "direction", "status");

-- CreateIndex
CREATE INDEX "Invoice_counterpartyId_idx" ON "Invoice"("counterpartyId");

-- CreateIndex
CREATE INDEX "Invoice_otherClientId_idx" ON "Invoice"("otherClientId");

-- CreateIndex
CREATE INDEX "Invoice_periodFrom_periodTo_idx" ON "Invoice"("periodFrom", "periodTo");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_creditOfId_idx" ON "Invoice"("creditOfId");

-- CreateIndex
CREATE INDEX "Invoice_searchText_idx" ON "Invoice" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_sortOrder_idx" ON "InvoiceLine"("invoiceId", "sortOrder");

-- CreateIndex
CREATE INDEX "InvoiceLine_employeeId_fromDate_toDate_idx" ON "InvoiceLine"("employeeId", "fromDate", "toDate");

-- CreateIndex
CREATE INDEX "PeriodLock_invoiceId_idx" ON "PeriodLock"("invoiceId");

-- AddForeignKey
ALTER TABLE "PeriodLock" ADD CONSTRAINT "PeriodLock_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_otherClientId_fkey" FOREIGN KEY ("otherClientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_creditOfId_fkey" FOREIGN KEY ("creditOfId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The permission area "invoice_ocr" is now called "invoices" (the invoice screens replace the invoice-reading prototype): carry what roles and people already hold over.
UPDATE "Role"
SET "permissions" = ("permissions" - 'invoice_ocr') || jsonb_build_object('invoices', "permissions" -> 'invoice_ocr')
WHERE jsonb_exists("permissions", 'invoice_ocr');

UPDATE "User"
SET "permissionOverrides" = ("permissionOverrides" - 'invoice_ocr') || jsonb_build_object('invoices', "permissionOverrides" -> 'invoice_ocr')
WHERE jsonb_exists("permissionOverrides", 'invoice_ocr');

-- An invoice has exactly one other party: a company that is not a client, or another client of the office.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_one_other_party_check" CHECK ((("counterpartyId" IS NOT NULL)::int + ("otherClientId" IS NOT NULL)::int) = 1);

-- The direction and the kind come from fixed sets (the program logic depends on them).
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_direction_check" CHECK ("direction" IN ('incoming', 'outgoing'));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_kind_check" CHECK ("kind" IN ('invoice', 'credit'));
