#!/usr/bin/env bash
# Creates (idempotently): key pair, security group, IAM role + instance profile, ECR repository.
# Security group: 22 + HTTP_PORT from your current IP, HTTP_PORT also from HTTP_ALLOW_CIDRS, all traffic from the
# group itself (MPI + container sshd 2222). Nothing is open to the world.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
TAG="{Key=Project,Value=$PROJECT}"
MYIP=$(curl -s -m 10 https://checkip.amazonaws.com)
ACC=$(aws sts get-caller-identity "${R[@]}" --query Account --output text)
mkdir -p keys && chmod 700 keys
if ! aws ec2 describe-key-pairs "${R[@]}" --key-names $PROJECT-key >/dev/null 2>&1; then
  aws ec2 create-key-pair "${R[@]}" --key-name $PROJECT-key --key-type ed25519 \
      --tag-specifications "ResourceType=key-pair,Tags=[$TAG]" --query KeyMaterial --output text > keys/$PROJECT-key.pem
  chmod 600 keys/$PROJECT-key.pem
fi
VPC=$(aws ec2 describe-vpcs "${R[@]}" --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNET=$(aws ec2 describe-subnets "${R[@]}" --filters Name=vpc-id,Values=$VPC Name=availability-zone,Values=$AZ --query 'Subnets[0].SubnetId' --output text)
CIDR=$(aws ec2 describe-vpcs "${R[@]}" --vpc-ids $VPC --query 'Vpcs[0].CidrBlock' --output text)
SG=$(aws ec2 describe-security-groups "${R[@]}" --filters Name=group-name,Values=$PROJECT-sg Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  SG=$(aws ec2 create-security-group "${R[@]}" --group-name $PROJECT-sg --description "$PROJECT cluster" --vpc-id $VPC \
       --tag-specifications "ResourceType=security-group,Tags=[$TAG,{Key=Name,Value=$PROJECT-sg}]" --query GroupId --output text)
  WEB="{CidrIp=$MYIP/32,Description=my-ip}"
  for c in $HTTP_ALLOW_CIDRS; do WEB="$WEB,{CidrIp=$c,Description=allowed}"; done
  aws ec2 authorize-security-group-ingress "${R[@]}" --group-id $SG --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MYIP/32,Description=my-ip-ssh}]" \
    "IpProtocol=tcp,FromPort=$HTTP_PORT,ToPort=$HTTP_PORT,IpRanges=[$WEB]" \
    "IpProtocol=-1,UserIdGroupPairs=[{GroupId=$SG,Description=cluster-internal}]" >/dev/null
fi
# node role: ECR pull (+ push to this project's repository only, the image is built on the master), S3 read of the shards
ROLE=$PROJECT-node-role; PROF=$PROJECT-node-profile
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --tags Key=Project,Value=$PROJECT --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam put-role-policy --role-name $ROLE --policy-name $PROJECT-node --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":\"ecr:GetAuthorizationToken\",\"Resource\":\"*\"},
  {\"Effect\":\"Allow\",\"Action\":[\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\",\"ecr:BatchCheckLayerAvailability\",
     \"ecr:InitiateLayerUpload\",\"ecr:UploadLayerPart\",\"ecr:CompleteLayerUpload\",\"ecr:PutImage\",\"ecr:DescribeImages\"],
   \"Resource\":\"arn:aws:ecr:$REGION:$ACC:repository/$PROJECT-engine\"},
  {\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$SHARD_BUCKET/*\"}]}"
if ! aws iam get-instance-profile --instance-profile-name $PROF >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name $PROF --tags Key=Project,Value=$PROJECT >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name $PROF --role-name $ROLE
  sleep 10   # IAM propagation
fi
aws ecr describe-repositories "${R[@]}" --repository-names $PROJECT-engine >/dev/null 2>&1 || \
  aws ecr create-repository "${R[@]}" --repository-name $PROJECT-engine --tags Key=Project,Value=$PROJECT >/dev/null
for kv in "VPC=$VPC" "SUBNET=$SUBNET" "CIDR=$CIDR" "SG=$SG" "PROFILE=$PROF" "REPO=$ACC.dkr.ecr.$REGION.amazonaws.com/$PROJECT-engine"; do
  setvar "${kv%%=*}" "${kv#*=}"; done
echo "infra ready (ids in aws/ids.env)"
