#!/usr/bin/env bash
# Deploys this checkout's committed state (HEAD) to the staging VM on Azure: copies the source,
# builds the image on the VM and restarts the game server. Open rooms reset (phones get a notice
# and reload); accounts, shared arenas and reports stay on the VM's disk.
#
#   bash deploy/azure/deploy.sh        (from the repository root; Git Bash on Windows)
set -euo pipefail

SITE="${STAGING_SITE:-sticxcape-staging.malaysiawest.cloudapp.azure.com}"
KEY="${STAGING_KEY:-$HOME/.ssh/sticxcape_azure}"
vm() { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "azureuser@$SITE" "$@"; }

# A brand-new VM may still be installing Docker.
vm 'cloud-init status --wait > /dev/null'

echo "Copying $(git rev-parse --short HEAD) to $SITE"
git archive --format=tar HEAD | vm 'set -e; rm -rf ~/sticxcape/src.new; mkdir -p ~/sticxcape/src.new; tar -x -C ~/sticxcape/src.new; rm -rf ~/sticxcape/src; mv ~/sticxcape/src.new ~/sticxcape/src'

echo "Building and restarting (a few minutes on the small VM)"
vm "set -e; cd ~/sticxcape; cp src/deploy/azure/compose.yaml compose.yaml; echo SITE_ADDRESS=$SITE > .env; touch secrets.env; chmod 600 secrets.env; docker compose up -d --build --remove-orphans; docker image prune -f > /dev/null"

echo "Live at https://$SITE"
