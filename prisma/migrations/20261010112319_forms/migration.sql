-- CreateTable
CREATE TABLE "FormDefinition" (
    "entity" TEXT NOT NULL,
    "live" JSONB NOT NULL,
    "draft" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT,
    "draftUpdatedAt" TIMESTAMP(3),
    "draftUpdatedById" TEXT,

    CONSTRAINT "FormDefinition_pkey" PRIMARY KEY ("entity")
);

-- CreateTable
CREATE TABLE "FormRevision" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "doc" JSONB NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT,

    CONSTRAINT "FormRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FormRevision_entity_revision_key" ON "FormRevision"("entity", "revision");

-- AddForeignKey
ALTER TABLE "FormRevision" ADD CONSTRAINT "FormRevision_entity_fkey" FOREIGN KEY ("entity") REFERENCES "FormDefinition"("entity") ON DELETE CASCADE ON UPDATE CASCADE;
