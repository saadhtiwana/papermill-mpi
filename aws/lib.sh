# Shared by the aws/ scripts: config, saved ids, region and ssh options.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
[ -f aws/config.env ] || { echo "copy aws/config.env.example to aws/config.env first" >&2; exit 1; }
source aws/config.env
touch aws/ids.env; source aws/ids.env
R=(--region "$REGION")
K=(-i keys/$PROJECT-key.pem -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
# setvar KEY VALUE : store KEY=VALUE in aws/ids.env (portable, no sed -i)
setvar() { grep -v "^$1=" aws/ids.env > aws/ids.env.tmp || true; echo "$1=$2" >> aws/ids.env.tmp; mv aws/ids.env.tmp aws/ids.env; export "$1=$2"; }
