#!/usr/bin/env bash
# Start the 3 nodes; the containers come back by themselves (restart: unless-stopped).
set -euo pipefail
source "$(dirname "$0")/aws/lib.sh"
IDS=$(aws ec2 describe-instances "${R[@]}" --filters Name=tag:Project,Values=$PROJECT Name=instance-state-name,Values=stopped,stopping \
      --query 'Reservations[].Instances[].InstanceId' --output text)
[ -z "$IDS" ] && { echo "nothing stopped"; exit 0; }
aws ec2 start-instances "${R[@]}" --instance-ids $IDS >/dev/null
aws ec2 wait instance-running "${R[@]}" --instance-ids $IDS && echo "running: $IDS"
bash aws/refresh_ips.sh
