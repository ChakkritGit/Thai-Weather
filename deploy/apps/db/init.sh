#!/bin/sh
# First start of apps-db only (docker-entrypoint-initdb.d). Passwords come from db.env.
# Roles mirror Supabase's, so the expenses schema, its RLS policies and PostgREST behave as they did there:
#   anon / authenticated / service_role (no login; PostgREST switches to them per request)
#   authenticator (PostgREST's login, may become those roles)    portfolio (Prisma's login)
#   calorieflow (CalorieFlow's login, owns its database)
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password '${AUTHENTICATOR_PASSWORD}';
grant anon, authenticated, service_role to authenticator;
create role portfolio login password '${PORTFOLIO_PASSWORD}';
create database expenses;
create database portfolio owner portfolio;
SQL
# CalorieFlow came later (2026-10-25): a bundle made before it has no CALORIEFLOW_PASSWORD in db.env
if [ -n "${CALORIEFLOW_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
create role calorieflow login password '${CALORIEFLOW_PASSWORD}';
create database calorieflow owner calorieflow;
SQL
fi
