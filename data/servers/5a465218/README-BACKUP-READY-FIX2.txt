V12 Backup Ready Fix 2

Fixes:
- Removed dependency on host `zip` CLI; global backups are now built as standard ZIP using Node.js only.
- Manual "Backup Sekarang" now shows a visible success/failure panel instead of only a callback toast.
- The existing SaaS/custom-bot destination fallback remains unchanged.
- No store/business logic was changed.
