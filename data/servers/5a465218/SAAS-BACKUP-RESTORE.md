# SaaS Global Backup & Restore

Backup is event-based and global (one ZIP for all SaaS tenants).

## Automatic triggers
- SaaS database changes (wallet, deposits, purchases, tenants, admins, settings).
- Persistent tenant data changes detected every few seconds.
- Tenant creation is awaited and cannot silently skip backup.
- Session and stock/config changes under tenant runtime are included.
- Volatile logs, runtime/cache/tmp/backups folders do not trigger backups.

## Destination
- If no custom backup bot is configured: the main SaaS bot sends to `SAAS_OWNER_ID`.
- If a custom backup bot is configured: it is used as the primary destination.
- If the custom bot fails, the system automatically falls back to the main SaaS bot and alerts the owner.

## Restore
Owner-only restore accepts `telegram-saas-backup-*.zip`, validates the archive and manifest, restores SaaS data and tenant persistent runtime, then restarts the SaaS process.
