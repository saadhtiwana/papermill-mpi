#!/usr/bin/env bash
# Stop (not terminate) the 3 nodes: compute billing stops; EBS volumes and the Elastic IP are kept.
set -euo pipefail
source "$(dirname "$0")/aws/lib.sh"
IDS=$(aws ec2 describe-instances "${R[@]}" --filters Name=tag:Project,Values=$PROJECT Name=instance-state-name,Values=running,pending \
      --query 'Reservations[].Instances[].InstanceId' --output text)
[ -z "$IDS" ] && { echo "nothing running"; exit 0; }
aws ec2 stop-instances "${R[@]}" --instance-ids $IDS >/dev/null
aws ec2 wait instance-stopped "${R[@]}" --instance-ids $IDS && echo "stopped: $IDS"
