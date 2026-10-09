#!/usr/bin/env bash
# Bootstraps chat_search_db: creates the chat_search schema, the three
# Security roles from PLAN.md ("Security roles" under "PostgreSQL search
# schema"), and default grants for objects the migration owner creates later.
#
# Runs once via docker-entrypoint-initdb.d against a fresh
# search_chat_search_pgdata volume, connected as the bootstrap superuser
# ($POSTGRES_USER / $POSTGRES_DB, set in search/compose.yml). Nothing in
# chat_search_db is ever reached by the app as that bootstrap superuser -
# see search/README.md "Credentials".
#
# What this script deliberately does NOT do (track 4's job - the migrations
# in packages/api or packages/data-schemas that create
# chat_search.{documents,embeddings,outbox,watermark}):
#   - create any table (documents/embeddings/outbox/watermark)
#   - GRANT chat_search_reader SELECT on documents/embeddings (do this per
#     table, right after CREATE TABLE, running as chat_search_owner)
#   - ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY + CREATE POLICY
#     (forced RLS can only be applied to tables that exist)
#   - grant chat_search_reader anything on outbox/watermark - the deny-by-
#     default posture below already satisfies "reader gets no grants on
#     outbox or watermark" as long as track 4 never adds a GRANT for it.
set -euo pipefail

: "${CHAT_SEARCH_OWNER_PASSWORD:?CHAT_SEARCH_OWNER_PASSWORD must be set (see search/.env.example)}"
: "${CHAT_SEARCH_WRITER_PASSWORD:?CHAT_SEARCH_WRITER_PASSWORD must be set (see search/.env.example)}"
: "${CHAT_SEARCH_READER_PASSWORD:?CHAT_SEARCH_READER_PASSWORD must be set (see search/.env.example)}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'PSQL'
-- Passwords come from the container environment via psql's backtick shell
-- exec (runs in the postgres image's own shell, not bash string
-- interpolation), then :'var' asks psql to SQL-quote the literal safely.
--
-- NOTE: :'var' substitution does not happen inside dollar-quoted DO $$ ... $$
-- blocks (psql's lexer treats them as opaque), so idempotency below uses
-- \gset + \if/\else/\endif client-side metacommands instead of a DO block,
-- keeping every password-bearing CREATE/ALTER ROLE at the top level.
\set owner_password `echo "$CHAT_SEARCH_OWNER_PASSWORD"`
\set writer_password `echo "$CHAT_SEARCH_WRITER_PASSWORD"`
\set reader_password `echo "$CHAT_SEARCH_READER_PASSWORD"`

-- Migration owner: schema changes only. Owns the schema and every object in
-- it, but is not superuser and cannot create roles/databases.
SELECT COUNT(*) = 0 AS need_owner FROM pg_roles WHERE rolname = 'chat_search_owner' \gset
\if :need_owner
CREATE ROLE chat_search_owner LOGIN PASSWORD :'owner_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
\else
ALTER ROLE chat_search_owner PASSWORD :'owner_password';
\endif
COMMENT ON ROLE chat_search_owner IS
  'chat_search migration owner (track 4 DDL only) - interactive/CI use, never a request-path DSN.';

-- Projection writer: documents/embeddings/outbox/watermark DML. Used only
-- by the lease-held projector/reconciler/outbox consumer, never by request
-- pods (CHAT_SEARCH_WRITER_URL, not CHAT_SEARCH_DATABASE_URL).
SELECT COUNT(*) = 0 AS need_writer FROM pg_roles WHERE rolname = 'chat_search_writer' \gset
\if :need_writer
CREATE ROLE chat_search_writer LOGIN PASSWORD :'writer_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
\else
ALTER ROLE chat_search_writer PASSWORD :'writer_password';
\endif
COMMENT ON ROLE chat_search_writer IS
  'chat_search projection writer (projector/outbox consumer/sweep) - CHAT_SEARCH_WRITER_URL.';

-- Request reader: forced RLS, request-path DSN (CHAT_SEARCH_DATABASE_URL).
-- Not superuser, not the table owner, not BYPASSRLS - the weekend leak gate
-- in PLAN.md asserts exactly this. No grants on outbox/watermark, ever.
SELECT COUNT(*) = 0 AS need_reader FROM pg_roles WHERE rolname = 'chat_search_reader' \gset
\if :need_reader
CREATE ROLE chat_search_reader LOGIN PASSWORD :'reader_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
\else
ALTER ROLE chat_search_reader PASSWORD :'reader_password';
\endif
ALTER ROLE chat_search_reader SET row_security = on;
COMMENT ON ROLE chat_search_reader IS
  'chat_search forced-RLS request reader - CHAT_SEARCH_DATABASE_URL. No outbox/watermark grants.';

-- Schema, owned by the migration owner.
CREATE SCHEMA IF NOT EXISTS chat_search AUTHORIZATION chat_search_owner;

-- Deny-by-default: revoke whatever PUBLIC would otherwise inherit, then
-- grant back only what each role needs. No role here gets anything on the
-- `public` schema either.
REVOKE ALL ON SCHEMA chat_search FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA chat_search TO chat_search_writer;
GRANT USAGE ON SCHEMA chat_search TO chat_search_reader;

-- All three roles resolve unqualified names (`vector(1024)`, bare table
-- names in migrations) against chat_search first - verified empirically:
-- USAGE on a schema is not enough for bare `vector(...)` type references,
-- PostgreSQL only consults search_path. `public` stays second (not dropped)
-- so built-in types/functions there remain reachable unqualified.
ALTER ROLE chat_search_owner SET search_path = chat_search, public;
ALTER ROLE chat_search_writer SET search_path = chat_search, public;
ALTER ROLE chat_search_reader SET search_path = chat_search, public;

-- pgvector, scoped to the chat_search schema per the search_path above.
CREATE EXTENSION IF NOT EXISTS vector SCHEMA chat_search;
-- pg_trgm backs the trigram search arm in PLAN.md's PostgreSQL search
-- schema; installing it now saves track 4 a superuser round trip.
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA chat_search;

-- Default grants for whatever chat_search_owner creates from here on
-- (documents, embeddings, outbox, watermark - track 4's migrations): the
-- writer gets full DML plus sequence usage automatically, so track 4 does
-- not need to hand-grant the writer role per table.
ALTER DEFAULT PRIVILEGES FOR ROLE chat_search_owner IN SCHEMA chat_search
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chat_search_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE chat_search_owner IN SCHEMA chat_search
  GRANT USAGE, SELECT ON SEQUENCES TO chat_search_writer;

-- Deliberately no default privilege grant for chat_search_reader: Postgres
-- denies by default, which is exactly "no grants on outbox or watermark".
-- Track 4 must explicitly GRANT SELECT to chat_search_reader on
-- chat_search.documents and chat_search.embeddings only, immediately after
-- creating each table, in the same migration that applies FORCE ROW LEVEL
-- SECURITY and the tenant/user RLS policy.
PSQL

echo "chat-search-roles: chat_search schema + roles (owner/writer/reader) ready."
