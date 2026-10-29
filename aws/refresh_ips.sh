#!/usr/bin/env bash
# Re-read the public IPs (workers get new ones after every start) into aws/ids.env.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
for n in master w1 w2; do v=ID_$n
  setvar PUB_$n "$(aws ec2 describe-instances "${R[@]}" --instance-ids ${!v} --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
  echo "PUB_$n=$(grep "^PUB_$n=" aws/ids.env | cut -d= -f2)"
done
