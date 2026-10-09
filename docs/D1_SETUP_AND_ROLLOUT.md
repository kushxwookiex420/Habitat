# Cloudflare D1 setup and safe rollout

This runbook is for the D1 repository foundation in this branch. It does **not** mean production task routes already use D1.

## Required configuration

Create a Cloudflare D1 database in the account that owns Habitat. Keep these values in Render's private environment-variable settings, never in GitHub files or chat logs:

- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account identifier.
- `HABITAT_D1_DATABASE_ID`: identifier of the new D1 database.
- `HABITAT_D1_API_TOKEN`: a narrowly scoped Cloudflare API token with permission to query that D1 database.

The existing `CLOUDFLARE_API_TOKEN` used for Workers AI is a separate credential and must not automatically be reused as the D1 token. Use least privilege and rotate any token that was exposed in a public or shared context.

## Schema

Apply `migrations/0001_habitat_tasks.sql` to the new D1 database using the Cloudflare dashboard or Wrangler. The repository's `initialize()` method also creates the table and index idempotently, but the current production server does not call it.

## Safe rollout gates

Do not declare task persistence active until all of these are true:

1. The D1 repository tests pass in GitHub Actions.
2. Production task create/get/list/update/delete routes are explicitly wired to the repository.
3. Startup hydration/recovery is implemented, and the server does not accept task requests before recovery completes.
4. Storage health reports the configured adapter accurately and fails closed if D1 is configured but unreachable; it must not silently claim durability while falling back to process memory.
5. A real D1-backed task survives a Render restart and can be read back.
6. Task dispatch has duplicate-execution protection so recovering a task cannot accidentally repeat an external publishing action.

Until then, the in-memory task map is still the production store. This foundation alone does not make task history durable.
