BEGIN;
CREATE TABLE cloak.binance_payments(
 order_id text PRIMARY KEY REFERENCES cloak.orders(id),receiver_uid text NOT NULL,
 due_cents integer NOT NULL CHECK(due_cents>0),quote_source text NOT NULL,quote_at bigint NOT NULL,
 claim_transaction_id text,submitted_at bigint,confirmed_transaction_id text UNIQUE,
 received_cents integer,reviewer text,evidence_ref text,confirmed_at bigint
);
ALTER TABLE cloak.binance_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cloak.binance_payments FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON cloak.binance_payments FROM %I',r);
  END IF;
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON cloak.binance_payments TO cloak_app;
CREATE POLICY server_only ON cloak.binance_payments TO cloak_app USING(true) WITH CHECK(true);
COMMIT;
