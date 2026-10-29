#!/usr/bin/env bash
# Point all 3 nodes at the IMAGE in aws/ids.env (one digest everywhere), pull and recreate the container.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
for ip in $PUB_master $PUB_w1 $PUB_w2; do
  ssh -n "${K[@]}" ubuntu@$ip "set -e; cd /opt/papermill
    sed -i 's|^IMAGE=.*|IMAGE=$IMAGE|; s|^IMAGE_DIGEST=.*|IMAGE_DIGEST=$IMAGE_DIGEST|' .env
    aws ecr get-login-password --region $REGION | sudo docker login --username AWS --password-stdin ${REPO%%/*} >/dev/null 2>&1
    sudo docker compose pull -q && sudo docker compose up -d >/dev/null 2>&1
    echo \"$ip: \$(sudo docker inspect papermill-node --format '{{.Image}} {{.State.Status}}')\"" &
done; wait
