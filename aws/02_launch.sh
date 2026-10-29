#!/usr/bin/env bash
# Launches $PROJECT-master, -w1, -w2 (Ubuntu 22.04, gp3 root, same AZ) and puts an Elastic IP on the master.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
AMI=$(aws ssm get-parameter "${R[@]}" --name /aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id --query Parameter.Value --output text)
for n in master w1 w2; do
  NAME=$PROJECT-$n
  ID=$(aws ec2 describe-instances "${R[@]}" --filters Name=tag:Name,Values=$NAME Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)
  if [ "$ID" = None ]; then
    ID=$(aws ec2 run-instances "${R[@]}" --image-id $AMI --instance-type $INSTANCE_TYPE --count 1 \
      --key-name $PROJECT-key --security-group-ids $SG --subnet-id $SUBNET --iam-instance-profile Name=$PROFILE \
      --metadata-options HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled \
      --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$DISK_GB,VolumeType=gp3,DeleteOnTermination=true}" \
      --user-data file://aws/userdata.sh \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=$PROJECT}]" \
                           "ResourceType=volume,Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=$PROJECT}]" \
      --query 'Instances[0].InstanceId' --output text)
  fi
  setvar ID_$n $ID
done
aws ec2 wait instance-running "${R[@]}" --instance-ids $ID_master $ID_w1 $ID_w2
ALLOC=$(aws ec2 describe-addresses "${R[@]}" --filters Name=tag:Project,Values=$PROJECT --query 'Addresses[0].AllocationId' --output text)
[ "$ALLOC" = None ] && ALLOC=$(aws ec2 allocate-address "${R[@]}" --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$PROJECT-master},{Key=Project,Value=$PROJECT}]" --query AllocationId --output text)
aws ec2 associate-address "${R[@]}" --allocation-id $ALLOC --instance-id $ID_master >/dev/null
setvar ALLOC $ALLOC
setvar EIP "$(aws ec2 describe-addresses "${R[@]}" --allocation-ids $ALLOC --query 'Addresses[0].PublicIp' --output text)"
for n in master w1 w2; do v=ID_$n
  setvar PRIV_$n "$(aws ec2 describe-instances "${R[@]}" --instance-ids ${!v} --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)"
done
bash aws/refresh_ips.sh
