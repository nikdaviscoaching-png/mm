CREATE TABLE IF NOT EXISTS mm_market(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mm_market_listing(provider TEXT NOT NULL,listing_id TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(provider,listing_id),UNIQUE(provider,item_id));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mm_market_lease(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires REAL NOT NULL);
