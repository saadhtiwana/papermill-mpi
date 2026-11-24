// CI for papermill-mpi: a push to main (git push or a web upload) triggers this on the Jenkins EC2 host via the
// GitHub webhook. Builds the engine natively (no Docker) and runs tests/run_tests.sh, which expects the repo at /work.
// Uploaded .c files are compiled in their own stage; a broken upload never fails the main build. Other file types
// are only listed.
pipeline {
  agent any
  triggers { githubPush() }
  options { disableConcurrentBuilds(); buildDiscarder(logRotator(numToKeepStr: '30')) }

  stages {
    stage('Checkout') {
      steps {
        script {
          def v = checkout scm
          env.PREV_COMMIT = v.GIT_PREVIOUS_COMMIT ?: ''
          echo "Triggered by: ${currentBuild.getBuildCauses()*.shortDescription.join('; ')}"
        }
        sh '''#!/bin/bash
          TOKEN=$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
          IID=$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
          echo "EC2 host: $(hostname) (instance ${IID:-unknown})"
          git log -1 --format='Commit:  %H%nAuthor:  %an <%ae>%nCommitter: %cn <%ce>%nDate:    %ad%nMessage: %s'
          mkdir -p build
          # changed files since the last build; first build or rewritten history -> files of this commit only
          if [ -n "$PREV_COMMIT" ] && [ "$PREV_COMMIT" != "$(git rev-parse HEAD)" ] && git cat-file -e "$PREV_COMMIT^{commit}" 2>/dev/null; then
            git diff --name-status "$PREV_COMMIT" HEAD > build/changed.txt
          else
            git diff-tree --no-commit-id --name-status -r --root HEAD > build/changed.txt
          fi
          echo "Changed files:"; sed 's/^/  /' build/changed.txt; [ -s build/changed.txt ] || echo "  (none)"
          # added/modified .c files that still exist
          awk -F'\\t' '$1 !~ /^D/ {print $NF}' build/changed.txt | grep -E '\\.c$' | while IFS= read -r f; do [ -f "$f" ] && echo "$f"; done > build/changed_c.txt || true
        '''
      }
    }

    stage('Install deps check') {
      steps {
        sh '''
          for c in gcc g++ mpicc mpicxx mpirun python3; do command -v $c >/dev/null || { echo "missing: $c"; exit 1; }; done
          test -f /usr/include/zlib.h || { echo "missing: zlib1g-dev"; exit 1; }
          g++ --version | head -1; mpirun --version | head -1; python3 --version; echo "cores: $(nproc)"
        '''
      }
    }

    stage('Build') {
      steps {
        // same flags as the Dockerfile
        sh 'mpicxx -O3 -fopenmp -std=c++17 -o build/engine engine/engine.cpp -lz && ls -l build/engine'
      }
    }

    stage('Test') {
      steps {
        sh '''#!/bin/bash
          set -o pipefail
          sed "s#/work/#$WORKSPACE/#g" tests/run_tests.sh > build/run_tests.sh
          ENGINE=$WORKSPACE/build/engine bash build/run_tests.sh 2>&1 | tee build/test.log
          grep -q '^ALL TESTS PASSED$' build/test.log
        '''
      }
    }

    stage('Compile uploaded C') {
      when { expression { readFile('build/changed_c.txt').trim() } }
      steps {
        // a broken upload marks only this stage as failed; the build result stays green
        catchError(buildResult: 'SUCCESS', stageResult: 'FAILURE') {
          sh '''#!/bin/bash
            mkdir -p build/uploads; rc=0
            while IFS= read -r f; do
              out="build/uploads/$(basename "${f%.c}")"
              echo "== $f"
              if mpicc -fopenmp -Wall -O2 -o "$out" "$f" -lm; then
                timeout 10 "$out" < /dev/null; echo "exit code: $?"
              else
                echo "compile failed: $f"; rc=1
              fi
            done < build/changed_c.txt
            exit $rc
          '''
        }
      }
    }

    stage('Archive') {
      steps {
        archiveArtifacts artifacts: 'build/engine, build/test.log, build/changed.txt, build/uploads/**', allowEmptyArchive: true, fingerprint: true
      }
    }
  }
}
