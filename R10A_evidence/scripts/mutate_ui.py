import json, os, re, subprocess, sys, time
ATK = '/tmp/claude-0/-home-user-Judge/0a5b962f-5501-546d-8848-7dcc95a400e9/scratchpad/r10/atk'
OUT = '/home/user/Judge/R10A_evidence/mutations'
PG = 'postgres://postgres@127.0.0.1:5433/'
ENV = dict(os.environ, R10_OUT=OUT, R10_PG_URL=PG+'judge_r10_atk_test')
VIEW = 'apps/web/app/projects/[projectId]/interview/view.tsx'
ACT = 'apps/web/app/projects/[projectId]/interview/actions.ts'
MUT = [
 ('M9', 'mark testimony as verified evidence in the UI', VIEW, '<small>Testimony recorded by the judge. Not a verified fact.</small>', '<small>Verified evidence recorded by the judge.</small>'),
 ('M10', 'hide the linked uncertainty from the UI', VIEW, '      {addressed.length > 0 ? (\n', '      {false ? (\n'),
 ('M11', 'lose the typed values after a failed save', ACT, "    outcomeUnknown: rule === undefined && outcomeIsUnknown(result),\n    values,\n", "    outcomeUnknown: rule === undefined && outcomeIsUnknown(result),\n    values: EMPTY_INTERVIEW_FORM.values,\n"),
]
def sh(cmd, timeout=1800):
    t = time.time(); p = subprocess.run(cmd, cwd=ATK, env=ENV, capture_output=True, text=True, timeout=timeout); txt = p.stdout + p.stderr
    fails = sorted(set(re.findall(r'^\s*(?:FAIL|×)\s+(\S.*?)(?:\s+\d+ms)?$', txt, re.M)))[:10]
    m = re.search(r'Tests\s+(.*)', txt)
    return dict(exit=p.returncode, seconds=round(time.time()-t), summary=(m.group(1).strip() if m else txt[-300:]), failing=[f[:230] for f in fails])
BUILD = ['pnpm', '--filter', '@judge-copilot/web', 'build']
UNIT = ['pnpm', 'vitest', 'run', 'interview/view.test', 'interview/actions.test']
BROWSER = ['pnpm', 'vitest', 'run', '-c', 'vitest.r10browser.config.ts']
results = json.load(open(OUT+'/results.json'))
def save(): json.dump(results, open(OUT+'/results.json', 'w'), indent=1)
# CONTROL: pristine build + both sets
b = sh(BUILD); results['UI-CONTROL'] = dict(build=b['exit'], author_unit=sh(UNIT), reviewer_browser=sh(BROWSER)); save(); print('UI-CONTROL', json.dumps(results['UI-CONTROL'])[:500], flush=True)
for mid, desc, f, old, new in MUT:
    path = os.path.join(ATK, f); orig = open(path).read(); assert orig.count(old) == 1, (mid, orig.count(old))
    open(path, 'w').write(orig.replace(old, new))
    try:
        bl = sh(BUILD); a = sh(UNIT); r = sh(BROWSER)
    finally:
        open(path, 'w').write(orig)
    results[mid] = dict(desc=desc, build=bl['exit'], author=a, reviewer=r, author_killed=a['exit']!=0, reviewer_killed=r['exit']!=0); save()
    print(mid, 'author_killed=%s reviewer_killed=%s' % (a['exit']!=0, r['exit']!=0), json.dumps(dict(author=a['failing'][:2], reviewer=r['failing'][:2]))[:600], flush=True)
sh(BUILD); print('UI-DONE restored+rebuilt', flush=True)
