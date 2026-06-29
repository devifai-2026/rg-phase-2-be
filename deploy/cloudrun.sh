#!/usr/bin/env bash
# Build + deploy the Rudraganga backend to Cloud Run, wired to Memorystore
# (private IP via the VPC connector) and Pub/Sub. Run from backend/.
#
#   ./deploy/cloudrun.sh
#
# Prereqs (one-time): infra provisioned by ./deploy/provision.sh (Pub/Sub topics,
# Memorystore rg-cache, VPC connector rg-connector). Non-secret config is set as
# env vars here; secrets (JWT, PayU, etc.) should come from Secret Manager.
set -euo pipefail

PROJECT=rudraganga
REGION=asia-south1
SERVICE=rg-backend
CONNECTOR=rg-connector
REDIS_HOST=10.79.54.219          # Memorystore rg-cache private IP
REDIS_URL="redis://${REDIS_HOST}:6379"

gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --source=. \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --min-instances=1 \
  --max-instances=10 \
  --cpu=1 --memory=512Mi \
  --concurrency=200 \
  --timeout=3600 \
  --session-affinity \
  --vpc-connector="$CONNECTOR" \
  --vpc-egress=private-ranges-only \
  --set-env-vars="NODE_ENV=production,SOCKET_ADAPTER=redis,REDIS_URL=${REDIS_URL},CACHE_ENABLED=true,CACHE_REDIS_URL=${REDIS_URL},PUBSUB_ENABLED=true,PUBSUB_PROJECT_ID=${PROJECT},PUBSUB_TOPIC_PREFIX=rg"
  # NOTE: secrets via --set-secrets, e.g.:
  #   --set-secrets="JWT_SECRET=rg-jwt-secret:latest,PAYU_SALT=rg-payu-salt:latest,MONGO_URI=rg-mongo-uri:latest"
  # PUBSUB/GCS auth uses the Cloud Run service account (ADC) — no key file in prod.

echo "Deployed. Service URL:"
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format='value(status.url)'
