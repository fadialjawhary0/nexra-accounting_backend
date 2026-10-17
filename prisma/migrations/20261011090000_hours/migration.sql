-- CreateTable
CREATE TABLE "HourEntry" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "rate" DECIMAL(10,2),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HourEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurchargeRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "percent" DECIMAL(6,2),
    "amountPerHour" DECIMAL(10,2),
    "clientId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurchargeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodLock" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "statementId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeriodLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryStatement" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'final',
    "totalMinutes" INTEGER NOT NULL,
    "daysCount" INTEGER NOT NULL,
    "baseAmount" DECIMAL(12,2) NOT NULL,
    "surchargeAmount" DECIMAL(12,2) NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "allowancePercent" DECIMAL(5,2) NOT NULL,
    "allowanceAmount" DECIMAL(12,2) NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "vacationMinutes" INTEGER NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "locale" TEXT NOT NULL DEFAULT 'nl',
    "note" TEXT NOT NULL DEFAULT '',
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "fileId" TEXT,
    "pdfFileId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "SalaryStatement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HourEntry_employeeId_date_idx" ON "HourEntry"("employeeId", "date");

-- CreateIndex
CREATE INDEX "HourEntry_clientId_date_idx" ON "HourEntry"("clientId", "date");

-- CreateIndex
CREATE INDEX "HourEntry_date_idx" ON "HourEntry"("date");

-- CreateIndex
CREATE INDEX "SurchargeRule_isActive_kind_idx" ON "SurchargeRule"("isActive", "kind");

-- CreateIndex
CREATE INDEX "SurchargeRule_clientId_idx" ON "SurchargeRule"("clientId");

-- CreateIndex
CREATE INDEX "PeriodLock_employeeId_fromDate_toDate_idx" ON "PeriodLock"("employeeId", "fromDate", "toDate");

-- CreateIndex
CREATE INDEX "PeriodLock_statementId_idx" ON "PeriodLock"("statementId");

-- CreateIndex
CREATE INDEX "SalaryStatement_employeeId_periodFrom_idx" ON "SalaryStatement"("employeeId", "periodFrom");

-- CreateIndex
CREATE INDEX "SalaryStatement_clientId_periodFrom_idx" ON "SalaryStatement"("clientId", "periodFrom");

-- CreateIndex
CREATE INDEX "SalaryStatement_status_periodFrom_idx" ON "SalaryStatement"("status", "periodFrom");

-- AddForeignKey
ALTER TABLE "HourEntry" ADD CONSTRAINT "HourEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HourEntry" ADD CONSTRAINT "HourEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurchargeRule" ADD CONSTRAINT "SurchargeRule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodLock" ADD CONSTRAINT "PeriodLock_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodLock" ADD CONSTRAINT "PeriodLock_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "SalaryStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryStatement" ADD CONSTRAINT "SalaryStatement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryStatement" ADD CONSTRAINT "SalaryStatement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
