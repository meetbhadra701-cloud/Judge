#!/bin/bash
SP=/tmp/claude-0/-home-user-Judge/0a5b962f-5501-546d-8848-7dcc95a400e9/scratchpad
cd $SP/r10/gate
pnpm check > $SP/r10-check.txt 2>&1; echo "EXIT $?" >> $SP/r10-check.txt
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/judge_r10_gate_test R5_DATABASE_URL=postgres://postgres@127.0.0.1:5433/judge_r10_gate_test pnpm vitest run > $SP/r10-pg16.txt 2>&1; echo "EXIT $?" >> $SP/r10-pg16.txt
pnpm test:browser > $SP/r10-browser.txt 2>&1; echo "EXIT $?" >> $SP/r10-browser.txt
git diff --check 8b1c047b911ba5ddd981c2330273e664476cf7bf HEAD > $SP/r10-diffcheck.txt 2>&1; echo "EXIT $?" >> $SP/r10-diffcheck.txt
echo DONE > $SP/r10-gates.done
