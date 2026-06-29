#!/usr/bin/env bash
# One-time GCP infra for the Rudraganga backend scalability stack.
# Idempotent-ish: re-running create commands that already exist will error
# harmlessly. Already executed once for project `rudraganga`; kept here as the
# source of truth / for recreating in another project.
set -euo pipefail

PROJECT=rudraganga
REGION=asia-south1
PNUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
APP_SA="rudraganga@rudraganga.iam.gserviceaccount.com"   # app/runtime service account
PUBSUB_SA="service-${PNUM}@gcp-sa-pubsub.iam.gserviceaccount.com"

# 1) Enable APIs.
gcloud services enable pubsub.googleapis.com redis.googleapis.com \
  cloudscheduler.googleapis.com translate.googleapis.com vpcaccess.googleapis.com \
  run.googleapis.com --project="$PROJECT"

# 2) Pub/Sub: dead-letter + fan-out topics, subscriptions with DLQ + retry.
gcloud pubsub topics create rg-deadletter --project="$PROJECT" || true
gcloud pubsub subscriptions create rg-deadletter-sub --topic=rg-deadletter \
  --project="$PROJECT" --message-retention-duration=7d --ack-deadline=600 || true
for t in payouts notifications recordings translation; do
  gcloud pubsub topics create "rg-$t" --project="$PROJECT" || true
  gcloud pubsub subscriptions create "rg-$t-sub" --topic="rg-$t" --project="$PROJECT" \
    --ack-deadline=60 --message-retention-duration=2d \
    --dead-letter-topic=rg-deadletter --max-delivery-attempts=5 \
    --min-retry-delay=5s --max-retry-delay=300s || true
done

# 3) IAM: let Pub/Sub forward to the DLQ, and grant the app SA pub/sub + translate.
gcloud pubsub topics add-iam-policy-binding rg-deadletter --project="$PROJECT" \
  --member="serviceAccount:${PUBSUB_SA}" --role=roles/pubsub.publisher
for t in payouts notifications recordings translation; do
  gcloud pubsub subscriptions add-iam-policy-binding "rg-$t-sub" --project="$PROJECT" \
    --member="serviceAccount:${PUBSUB_SA}" --role=roles/pubsub.subscriber
done
for role in roles/pubsub.publisher roles/pubsub.subscriber roles/cloudtranslate.user; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${APP_SA}" --role="$role" --condition=None
done

# 4) Memorystore for Redis (cache + socket adapter + online set). ~5 min.
gcloud redis instances create rg-cache --region="$REGION" --project="$PROJECT" \
  --tier=basic --size=1 --redis-version=redis_7_0 \
  --network="projects/${PROJECT}/global/networks/default" \
  --connect-mode=DIRECT_PEERING || true

# 5) Serverless VPC connector so Cloud Run can reach Memorystore's private IP.
gcloud compute networks vpc-access connectors create rg-connector --region="$REGION" \
  --project="$PROJECT" --network=default --range=10.8.0.0/28 \
  --min-instances=2 --max-instances=3 --machine-type=e2-micro || true

echo "Provisioning complete. Redis host:"
gcloud redis instances describe rg-cache --region="$REGION" --project="$PROJECT" --format='value(host)'
