#!/bin/sh
# Nightly backup: database dump + employee documents, kept KEEP_DAYS days.
# Copy /backups off the server too (another disk, NAS or cloud), together with
# DATA_ENCRYPTION_KEY, which is NOT in the dump on purpose.
set -eu
run_backup() {
  stamp=$(date +%Y-%m-%d_%H%M)
  pg_dump -Fc -f "/backups/db_${stamp}.dump"
  tar -czf "/backups/uploads_${stamp}.tar.gz" -C /data uploads
  find /backups -name 'db_*.dump' -mtime +"$KEEP_DAYS" -delete
  find /backups -name 'uploads_*.tar.gz' -mtime +"$KEEP_DAYS" -delete
  echo "backup ${stamp} done"
}
run_backup
while true; do
  now=$(date +%s)
  next=$(date -d "$(date +%Y-%m-%d) $(printf %02d "$BACKUP_HOUR"):00" +%s 2>/dev/null || echo $((now + 86400)))
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  run_backup || echo "backup failed"
done
