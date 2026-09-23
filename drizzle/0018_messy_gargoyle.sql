CREATE TABLE "opening_balance_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" "product" NOT NULL,
	"trend_date" date NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "opening_balance_daily_uq" ON "opening_balance_daily" USING btree ("product","trend_date");