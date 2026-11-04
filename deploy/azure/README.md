# Staging on Azure

One small VM runs the game server, with Caddy in front of it for HTTPS. Rooms live in memory, so staging is one server. Accounts, shared photo arenas and reports are kept in SQLite on the VM's own disk, so they survive deploys and reboots.

- **Address:** https://sticxcape-staging.malaysiawest.cloudapp.azure.com
- **Machine:** Standard_B2ats_v2 (2 vCPU, 1 GB) with Ubuntu 24.04 and a 64 GB disk, in resource group `sticxcape-staging`.
- **Region:** Malaysia West. The Azure for Students subscription allows only Korea Central, Australia East, Central India, Malaysia West and India South Central, and Malaysia West is nearest the playtesters in Southeast Asia.
- **Cost:** the VM is about $8.60 a month at Singapore's list price, plus the disk and IP address. The student free services cover this VM size and disk for 12 months.
- **SSH:** `ssh -i ~/.ssh/sticxcape_azure azureuser@sticxcape-staging.malaysiawest.cloudapp.azure.com`. The key was made for this VM only; password logins are off.

## Deploy

From the repository root, in Git Bash:

```bash
bash deploy/azure/deploy.sh
```

It copies the committed state (HEAD), builds the image on the VM and restarts the server, which takes a few minutes. Open rooms reset; phones get a notice and reload.

## Secrets

The server reads `MODEL_API_KEY` (Meta) and `ADMIN_TOKEN` (the password for `/admin`, user `admin`) from `~/sticxcape/secrets.env` on the VM. Without the Meta key, move names and tips are canned, and photo arena sharing is refused, since production shares nothing unchecked.

Copy the Meta key from your local `services/server/.env` without showing it:

```bash
grep '^MODEL_API_KEY=' services/server/.env | ssh -i ~/.ssh/sticxcape_azure azureuser@sticxcape-staging.malaysiawest.cloudapp.azure.com 'cat >> ~/sticxcape/secrets.env'
```

Make an admin password and restart the server with both:

```bash
ssh -i ~/.ssh/sticxcape_azure azureuser@sticxcape-staging.malaysiawest.cloudapp.azure.com 'echo ADMIN_TOKEN=$(openssl rand -hex 16) >> ~/sticxcape/secrets.env && cd ~/sticxcape && docker compose up -d'
```

Read the admin password later with `grep ADMIN_TOKEN ~/sticxcape/secrets.env` on the VM.

## Logs

```bash
ssh -i ~/.ssh/sticxcape_azure azureuser@sticxcape-staging.malaysiawest.cloudapp.azure.com 'cd ~/sticxcape && docker compose logs --tail 100 app'
```

`/healthz` answers without a password; `/admin` shows matches, relay delay and AI calls.

## How it was made

```bash
az group create --name sticxcape-staging --location malaysiawest
az vm create --resource-group sticxcape-staging --name sticxcape-staging --location malaysiawest --image Ubuntu2404 --size Standard_B2ats_v2 --admin-username azureuser --ssh-key-values ~/.ssh/sticxcape_azure.pub --public-ip-sku Standard --public-ip-address-dns-name sticxcape-staging --os-disk-size-gb 64 --storage-sku Premium_LRS --custom-data deploy/azure/cloud-init.yaml --nsg-rule SSH
az vm open-port --resource-group sticxcape-staging --name sticxcape-staging --port 80,443 --priority 900
```

`cloud-init.yaml` installs Docker and Compose on first boot and adds a swap file for building on the VM.

## Stopping it

`az vm deallocate --resource-group sticxcape-staging --name sticxcape-staging` stops the VM; the disk and IP address still cost a little. `az group delete --name sticxcape-staging` deletes everything, including the database.

`fly.toml` and the "Deploy staging" workflow are for Fly.io, which isn't used while staging runs on Azure.
