---
title: Database
summary: Embedded PGlite vs Docker Postgres vs hosted
---

Paperclip uses PostgreSQL via Drizzle ORM. There are three ways to run the database.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.paperclip/instances/default/db/` for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.paperclip/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Set the connection string:

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Push the schema:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted provider like [Supabase](https://supabase.com/).

1. Create a project at [database.new](https://database.new)
2. Copy the connection string from Project Settings > Database
3. Set `DATABASE_URL` in your `.env`

Use the **direct connection** (port 5432) for migrations and the **pooled connection** (port 6543) for the application.

If your transaction-mode pooler does not support protocol-level named prepared statements, disable them via the environment:

```sh
DATABASE_PREPARED_STATEMENTS=false
```

For a direct connection or a pooler that supports named prepared statements,
`DATABASE_PREPARED_STATEMENTS=true` also prepares parameterized ORM queries and
queries inside transactions and reserved or dedicated connections. Check the
provider's configuration before you enable it. Preparation caches statement
metadata, not query results. Unset preserves the existing ORM behavior and the
driver default for tagged SQL. Explicit per-query options still apply.

Related optional client tuning: `DATABASE_POOL_MAX`, `DATABASE_IDLE_TIMEOUT_SECONDS`, `DATABASE_CONNECT_TIMEOUT_SECONDS`, `DATABASE_MAX_LIFETIME_SECONDS`, `DATABASE_APPLICATION_NAME`, `DATABASE_DEDICATED_POOL_MAX`, `DATABASE_DEDICATED_WAIT_TIMEOUT_SECONDS`. Driver defaults apply when unset, except that idle pooled connections close after 60 seconds (`DATABASE_IDLE_TIMEOUT_SECONDS=0` keeps them open) and the pool reports `application_name=paperclip`. See [Connection pool settings](#connection-pool-settings).

## Connection Pool Settings

The server opens one postgres.js pool for its own queries (and a second one when `DATABASE_MIGRATION_URL` points at a different connection). Every setting is optional:

| Variable | Default | Effect |
|----------|---------|--------|
| `DATABASE_POOL_MAX` | `10` (driver) | Maximum pooled connections. |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | `60` | Close a pooled connection after this much idle time. `0` keeps idle connections open forever (the driver default). |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `30` (driver) | Give up on a connection attempt after this long. |
| `DATABASE_MAX_LIFETIME_SECONDS` | 30–60 min, randomized (driver) | Recycle a pooled connection once it is this old. |
| `DATABASE_APPLICATION_NAME` | `paperclip` | Value of `application_name` in `pg_stat_activity`, so you can find Paperclip's backends: `SELECT * FROM pg_stat_activity WHERE application_name = 'paperclip';` |
| `DATABASE_PREPARED_STATEMENTS` | Unset | `true` opts parameterized ORM queries into preparation. `false` disables preparation. Use `false` when the pooler does not support named statements. Unset preserves existing behavior. |
| `DATABASE_DEDICATED_POOL_MAX` | `16` | Most dedicated single-connection clients (`application_name=paperclip-workspace-finalization-lock`) open at once for advisory-lock holders. Further holders queue instead of connecting. Minimum `4`. |
| `DATABASE_DEDICATED_WAIT_TIMEOUT_SECONDS` | `120` | How long a queued holder waits for a dedicated connection before failing with `dedicated_connection_wait_timeout`. `0` waits indefinitely. |

The server ends its pools during shutdown (SIGINT/SIGTERM) and when startup fails after the pool was opened, so a restarting server does not leave idle backends behind.

### Connection budget

Each server process has a fixed ceiling on the PostgreSQL connections it holds at once, and logs it at startup:

```
Database connection budget: at most 30 connections from this process
```

The structured log fields `databaseConnectionBudget` (the total) and `databaseConnectionPools` (the per-pool split) carry the same numbers. The total is:

| Pool (`application_name`) | Connections |
|---------------------------|-------------|
| Main pool (`DATABASE_APPLICATION_NAME`) | `DATABASE_POOL_MAX` (default 10) |
| `paperclip-controller-lease` | 2 |
| `paperclip-runner-checkpoint` | 3 |
| `paperclip-file-storage` | 2 |
| Owned listener | 1 |
| `paperclip-workspace-finalization-lock` (dedicated) | `DATABASE_DEDICATED_POOL_MAX` (default 16) |
| `paperclip-deployment-notifications` | 1 |
| Plugin migration pool, only when `DATABASE_MIGRATION_URL` differs from `DATABASE_URL` | its main pool size |

With the defaults that is 35; with `DATABASE_POOL_MAX=5` it is 30. Set the role's connection limit (or PostgreSQL `max_connections`) to at least the logged budget times the number of server processes that can run at once (a rolling update briefly runs two), plus headroom for migrations, operators and other clients. Startup checks (migration inspection, data-directory probes) and a running database backup each use one more short-lived connection.

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.
