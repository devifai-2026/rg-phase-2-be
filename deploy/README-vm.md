# Deploying the Rudraganga backend to a low-cost GCP VM (with free HTTPS)

This is the **recommended** host for this backend. Unlike Cloud Run / Vercel, a
plain Compute Engine VM runs **one persistent Node process**, so Socket.IO
WebSockets, the in-process `jobWorker`, and the `bqService` flush timer all work
**unchanged** — no architecture changes needed.

HTTPS without owning a domain: we use a `<dashed-ip>.sslip.io` hostname that
resolves to the VM's static IP, and **Caddy auto-provisions a Let's Encrypt
cert** for it (auto-renewing, free).

## Architecture

```
client ──HTTPS──> Caddy (:443, auto-TLS)  ──HTTP──>  node server.js (localhost:5000)
                  <dashed-ip>.sslip.io                 Express + Socket.IO + workers
```

## One-time setup

### 1. Create the VM + static IP + firewall (run locally)
```bash
cd backend
PROJECT=rudraganga ZONE=asia-south1-a ./deploy/vm-provision.sh
```
Note the printed `https://<dashed-ip>.sslip.io` URL.

### 2. Install + start everything (run on the VM)
SSH in and run the setup script. It installs Node 20 + Caddy, creates the
`rgapp` user, clones the repo, installs deps, and starts the systemd service
behind Caddy with auto-HTTPS:
```bash
gcloud compute ssh rg-backend-vm --zone=asia-south1-a --project=rudraganga
sudo bash /opt/rg-backend/deploy/vm-setup.sh   # or pipe it in if the repo isn't cloned yet
```

### 3. Set the real secrets/config on the VM
Secrets do **not** live in the repo. Edit the env file the service reads:
```bash
sudo nano /etc/rg-backend.env     # fill MONGO_URI, JWT_SECRET, GCS_*, AGORA_*, etc (see .env.example)
sudo chmod 600 /etc/rg-backend.env
sudo systemctl restart rg-backend
```
For GCP auth (GCS / Pub/Sub / BigQuery / Translate / Vertex), prefer the VM's
attached service account (ADC) over a key file — the VM was created with
`--scopes=cloud-platform`. If you still use key files, place them on the VM and
point `GCS_KEY_FILE` / `FIREBASE_SERVICE_ACCOUNT_JSON` at their paths.

### 4. Verify
```bash
curl https://<dashed-ip>.sslip.io/healthz     # {"status":"ok",...}
curl https://<dashed-ip>.sslip.io/readyz      # {"db":"up"}
# Socket.IO handshake:
curl "https://<dashed-ip>.sslip.io/socket.io/?EIO=4&transport=polling"
```
API docs: `https://<dashed-ip>.sslip.io/api-docs`

## Continuous deploys (GitHub Actions)

`.github/workflows/deploy-vm.yml` redeploys on every push to `main` once CI
passes. Add these repo secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
|--------|-------|
| `VM_HOST` | `<dashed-ip>.sslip.io` (or the static IP) |
| `VM_USER` | your SSH user on the VM |
| `VM_SSH_KEY` | a private key whose public half is in the VM's `~/.ssh/authorized_keys` |

It SSHes in, `git reset --hard origin/main`, `npm ci --omit=dev`, restarts the
service (graceful SIGTERM drain), and smoke-tests `/healthz`.

## Operations

```bash
sudo systemctl status rg-backend         # service health
sudo journalctl -u rg-backend -f         # app logs
sudo journalctl -u caddy -f              # TLS / proxy logs
sudo systemctl restart rg-backend        # restart app
sudo systemctl reload caddy              # reload proxy config
```

## Notes / gotchas
- **Never expose port 5000 publicly** — only 80/443 (Caddy) are open in the
  firewall. The app binds `localhost:5000`.
- **Single VM = single instance**, so `SOCKET_ADAPTER=memory` is fine (no Redis
  needed). If you scale to multiple VMs later, switch to the Redis adapter (see
  `deploy/provision.sh` / `deploy/cloudrun.sh`).
- sslip.io is great for getting started; for production buy a cheap domain and
  point an A record at the static IP, then change the hostname in
  `/etc/caddy/Caddyfile` and reload Caddy — it'll fetch a cert for the new name.
- The existing `deploy/cloudrun.sh` + `provision.sh` remain valid if you ever
  prefer Cloud Run + Memorystore instead.
```
