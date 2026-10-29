#!/bin/bash
# Engine vs reference.py on several corpora, settings and layouts; run inside the image with the repo at /work:
#   docker run --rm -v "$PWD":/work:ro papermill-mpi bash /work/tests/run_tests.sh
# Every layout must match the reference (1e-6 relative) and produce byte-identical output; progress must be
# whole numbers 0..100, increasing, ending with 100.
set -u
E=${ENGINE:-/opt/engine}
W=$(mktemp -d)
fail=0
MPI="mpirun --oversubscribe -np 3 -x OMP_NUM_THREADS -x PAPERMILL_DATA"
LAYOUTS=("1x1:env OMP_NUM_THREADS=1 $E" "1x4:env OMP_NUM_THREADS=4 $E" "3x2:env OMP_NUM_THREADS=2 $MPI $E")
check_progress() {
  python3 - "$1" <<'PY' || return 1
import sys
v = [int(l) for l in open(sys.argv[1]) if l.strip()]
assert v and v[-1] == 100 and all(a < b for a, b in zip(v, v[1:])) and all(0 <= x <= 100 for x in v), v
PY
}
run_case() {   # name data_dir queries reference_output "launcher" shards...
  local name=$1 d=$2 qf=$3 ref=$4 l=$5; shift 5
  /work/tests/run_engine.sh $d "$l" $qf "$@" > $W/$name.eng || { echo "FAIL run $name"; fail=1; return; }
  check_progress $d/progress.txt || { echo "FAIL progress $name: $(tr '\n' ' ' < $d/progress.txt)"; fail=1; }
  if python3 /work/tests/compare.py $W/$name.eng $ref > $W/$name.cmp; then echo "OK   $name ($(tail -1 $W/$name.cmp))"
  else echo "FAIL $name"; cat $W/$name.cmp; fail=1; fi
}
reference() {  # data_dir queries [shards...] -> stdout
  local d=$1 qf=$2; shift 2
  tr '\n' '\0' < $qf | xargs -0 python3 /work/reference.py --data $d ${1:+--shards "$@" --jobs 2}
}
same() { cmp -s $W/$1.eng $W/$2.eng && echo "OK   $1 == $2 (byte-identical)" || { echo "FAIL $1 differs from $2"; fail=1; }; }

# 1. worked toy example: exact output, exact tie broken by id
mkdir -p $W/toy && cp /work/tests/toy/* $W/toy/
PAPERMILL_DATA=$W/toy $E index > /dev/null 2>&1
printf 'd1 0.615891522787\nd2 0.161284293245\nd3 0.161284293245\n' |
  diff - <(PAPERMILL_DATA=$W/toy $E search "sparse solvers") > /dev/null && echo "OK   toy example exact" || { echo "FAIL toy"; fail=1; }

# 2. hand-written edge cases under three settings files (all tf / idf / norm options)
for st in /work/examples/settings.example.txt /work/tests/unit/settings-bm25.txt /work/tests/unit/settings-plain.txt; do
  n=unit-$(basename $st .txt); mkdir -p $W/$n; cp /work/tests/unit/extra.jsonl $W/$n/; cp $st $W/$n/settings.txt
  reference $W/$n /work/tests/queries.txt > $W/$n.ref
  for L in "${LAYOUTS[@]}"; do run_case $n-${L%%:*} $W/$n /work/tests/queries.txt $W/$n.ref "${L#*:}"; done
  same $n-1x1 $n-1x4; same $n-1x1 $n-3x2
done

# 3. synthetic corpus: extra docs only, then extra docs + 4 gzip shards; plus forced hash-range passes
python3 /work/tests/gen_corpus.py $W/syn > /dev/null && cp /work/examples/settings.example.txt $W/syn/settings.txt
cat /work/tests/queries.txt $W/syn/queries.txt > $W/syn/q.txt
reference $W/syn $W/syn/q.txt > $W/syn0.ref
reference $W/syn $W/syn/q.txt 0 1 2 3 > $W/syn4.ref
for L in "${LAYOUTS[@]}"; do
  run_case syn0-${L%%:*} $W/syn $W/syn/q.txt $W/syn0.ref "${L#*:}"
  run_case syn4-${L%%:*} $W/syn $W/syn/q.txt $W/syn4.ref "${L#*:}" 0 1 2 3
done
run_case syn4-1x2p3 $W/syn $W/syn/q.txt $W/syn4.ref "env OMP_NUM_THREADS=2 PAPERMILL_PASSES=3 $E" 0 1 2 3
run_case syn4-3x2p2 $W/syn $W/syn/q.txt $W/syn4.ref "env OMP_NUM_THREADS=2 PAPERMILL_PASSES=2 $MPI -x PAPERMILL_PASSES $E" 0 1 2 3
for x in syn0-1x4 syn0-3x2; do same syn0-1x1 $x; done
for x in syn4-1x4 syn4-3x2 syn4-1x2p3 syn4-3x2p2; do same syn4-1x1 $x; done

# 4. a 1-rank search must refuse the 3-rank index left by the last run
PAPERMILL_DATA=$W/syn $E search "qxalpha" > /dev/null 2>&1 && { echo "FAIL stale-index check"; fail=1; } || echo "OK   1-rank search refuses a 3-rank index"

# 5. exact collision check on the synthetic corpus
PAPERMILL_DATA=$W/syn OMP_NUM_THREADS=2 $E collisions 3 0 1 2 3 2>&1 | tail -1 | grep -q 'hash collisions 0$' \
  && echo "OK   no 64-bit feature hash collisions" || { echo "FAIL collision check"; fail=1; }

[ $fail = 0 ] && echo "ALL TESTS PASSED" || { echo "SOME TESTS FAILED"; exit 1; }
