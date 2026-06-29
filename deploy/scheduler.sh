#!/usr/bin/env bash
# Create/replace the daily 3am (IST) translation back-fill Cloud Scheduler job.
# It POSTs the secured internal endpoint on the Cloud Run service, which scans
# dynamic content for missing locales and back-fills them via Cloud Translation.
#
#   INTERNAL_JOB_SECRET=<same-as-cloud-run> ./deploy/scheduler.sh
set -euo pipefail

PROJECT=rudraganga
REGION=asia-south1
SERVICE=rg-backend
JOB=rg-translate-backfill
: "${INTERNAL_JOB_SECRET:?Set INTERNAL_JOB_SECRET (must match the Cloud Run env var)}"

URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format='value(status.url)')/api/internal/jobs/translate-backfill"

# 3:00 AM Asia/Kolkata, every day.
ARGS=(
  --project="$PROJECT" --location="$REGION"
  --schedule="0 3 * * *" --time-zone="Asia/Kolkata"
  --uri="$URL" --http-method=POST
  --headers="X-Internal-Secret=${INTERNAL_JOB_SECRET},Content-Type=application/json"
  --message-body='{"limit":500}'
  --attempt-deadline=600s
)

if gcloud scheduler jobs describe "$JOB" --project="$PROJECT" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${ARGS[@]}"
else
  gcloud scheduler jobs create http "$JOB" "${ARGS[@]}"
fi
echo "Scheduler job '$JOB' → $URL (daily 03:00 IST)"
