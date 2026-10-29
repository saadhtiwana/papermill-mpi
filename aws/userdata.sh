#!/bin/bash
# EC2 boot script: the host only needs Docker (+ compose plugin, AWS CLI for ECR login / S3 copy)
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 awscli
systemctl enable --now docker
usermod -aG docker ubuntu
mkdir -p /data/shards /opt/papermill && chown ubuntu:ubuntu /data /data/shards /opt/papermill
touch /var/lib/cloud/papermill-ready
