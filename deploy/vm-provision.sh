#!/usr/bin/env bash
# One-time: create a low-cost GCP Compute Engine VM to host the Rudraganga
# backend as a PERSISTENT Node process (Express + Socket.IO + in-process job
# worker + bqService). Unlike Cloud Run / Vercel, a plain VM keeps WebSockets
# and background timers alive, so the realtime layer works unchanged.
#
# HTTPS without a domain: we use a *.sslip.io hostname that resolves to the
# VM's public IP, and Caddy auto-provisions a Let's Encrypt cert for it.
#
#   ./deploy/vm-provision.sh
#
# Re-running create commands that already exist errors harmlessly.
set -euo pipefail

PROJECT="${PROJECT:-rudraganga}"
ZONE="${ZONE:-asia-south1-a}"
VM_NAME="${VM_NAME:-rg-backend-vm}"
MACHINE="${MACHINE:-e2-small}"        # ~2 vCPU burst / 2GB. e2-micro is free-tier-ish but tight for Node.
DISK_SIZE="${DISK_SIZE:-20GB}"
IMAGE_FAMILY="${IMAGE_FAMILY:-debian-12}"
IMAGE_PROJECT="${IMAGE_PROJECT:-debian-cloud}"

# 1) Reserve a STATIC external IP so the sslip.io hostname (and your clients)
#    don't break when the VM restarts.
gcloud compute addresses create "${VM_NAME}-ip" \
  --project="$PROJECT" --region="${ZONE%-*}" || true
STATIC_IP="$(gcloud compute addresses describe "${VM_NAME}-ip" \
  --project="$PROJECT" --region="${ZONE%-*}" --format='value(address)')"

# 2) Firewall: allow HTTP/HTTPS (Caddy) + SSH. The Node app itself stays on
#    localhost:5000 behind Caddy — never expose 5000 publicly.
gcloud compute firewall-rules create rg-allow-web \
  --project="$PROJECT" --direction=INGRESS --action=ALLOW \
  --rules=tcp:80,tcp:443 --target-tags=rg-backend --source-ranges=0.0.0.0/0 || true

# 3) Create the VM, tagged so the firewall rule applies. The startup script
#    runs vm-setup.sh contents on first boot (installs Node, Caddy, systemd).
gcloud compute instances create "$VM_NAME" \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type="$MACHINE" \
  --image-family="$IMAGE_FAMILY" --image-project="$IMAGE_PROJECT" \
  --boot-disk-size="$DISK_SIZE" --boot-disk-type=pd-balanced \
  --address="$STATIC_IP" \
  --tags=rg-backend \
  --scopes=cloud-platform || true

DASH_IP="${STATIC_IP//./-}"
echo
echo "VM created."
echo "  Static IP   : $STATIC_IP"
echo "  HTTPS host  : https://${DASH_IP}.sslip.io   (resolves to the IP; Caddy will get a cert for it)"
echo
echo "Next:"
echo "  1) SSH in:   gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT"
echo "  2) Run the VM setup (see deploy/README-vm.md). It clones the repo,"
echo "     installs deps, and starts the systemd service behind Caddy."
