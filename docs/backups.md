# Backups

The server writes a consistent copy of the database to `data/backups/` once a day and keeps the last 7. Set `BACKUP_DAYS` to change that, or to `0` to turn daily backups off.

Don't copy `dashboard.db` by hand while it runs. SQLite keeps recent changes in a side file, and a plain copy can come out broken. For a backup right now:

```bash
docker compose exec dashboard node server/backup.ts
```

It prints where it wrote the file and checks that the copy opens. Without Docker, run `npm run backup`.

To restore one, stop the container, put the backup in place of `data/dashboard.db`, delete `data/dashboard.db-wal` and `data/dashboard.db-shm`, and start it again.
