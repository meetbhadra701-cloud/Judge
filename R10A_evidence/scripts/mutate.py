import json, os, re, shutil, subprocess, sys, time
ATK = '/tmp/claude-0/-home-user-Judge/0a5b962f-5501-546d-8848-7dcc95a400e9/scratchpad/r10/atk'
OUT = '/home/user/Judge/R10A_evidence/mutations'
os.makedirs(OUT, exist_ok=True)
PG = 'postgres://postgres@127.0.0.1:5433/'
ENV = dict(os.environ, TEST_DATABASE_URL=PG+'judge_r10_mut_test', R10_PG_URL=PG+'judge_r10_atk_test', R10_UPG_URL=PG+'judge_r10_upg_test', R10_FRESH_URL=PG+'judge_r10_fresh_test', R10_OUT=OUT)
MIG = 'packages/database/drizzle/0025_m7_interview_records.sql'
STORE = 'packages/database/src/interview-store.ts'
SVC = 'apps/api/src/interview/service.ts'
SCH = 'packages/schemas/src/interview.ts'
VIEW = 'apps/web/app/projects/[projectId]/interview/view.tsx'
ACT = 'apps/web/app/projects/[projectId]/interview/actions.ts'

def stmt(name_re):  # whole SQL statement -> SELECT 1;
    return ('re', name_re)
MUT = [
 dict(id='M1a', kind='db', desc='remove composite FK team_answers_question_in_set_fk (question must belong to the set)', edits=[(MIG, ('re', r'ALTER TABLE "team_answers" ADD CONSTRAINT "team_answers_question_in_set_fk"[^;]*;'), 'SELECT 1;')]),
 dict(id='M1b', kind='db', desc='remove composite FK team_answers_assessment_same_project_fk', edits=[(MIG, ('re', r'ALTER TABLE "team_answers" ADD CONSTRAINT "team_answers_assessment_same_project_fk"[^;]*;'), 'SELECT 1;')]),
 dict(id='M1c', kind='db', desc='remove composite FK judge_observations_team_answer_same_question_fk (linked answer must be of the same question)', edits=[(MIG, ('re', r'ALTER TABLE "judge_observations" ADD CONSTRAINT "judge_observations_team_answer_same_question_fk"[^;]*;'), 'SELECT 1;')]),
 dict(id='M1d', kind='db', desc='remove composite FK team_answers_set_same_assessment_fk (set must belong to the assessment)', edits=[(MIG, ('re', r'ALTER TABLE "team_answers" ADD CONSTRAINT "team_answers_set_same_assessment_fk"[^;]*;'), 'SELECT 1;')]),
 dict(id='M2a', kind='db', desc='remove append-only trigger on team_answers', edits=[(MIG, ('re', r'CREATE TRIGGER "team_answers_immutable_guard"[^;]*;'), 'SELECT 1;')]),
 dict(id='M2b', kind='db', desc='remove append-only trigger on judge_observations', edits=[(MIG, ('re', r'CREATE TRIGGER "judge_observations_immutable_guard"[^;]*;'), 'SELECT 1;')]),
 dict(id='M2c', kind='db', desc='remove no-truncate trigger on team_answers', edits=[(MIG, ('re', r'CREATE TRIGGER "team_answers_no_truncate"[^;]*;'), 'SELECT 1;')]),
 dict(id='M3a', kind='db', desc='remove the void guard on team_answers', edits=[(MIG, ('re', r'CREATE TRIGGER "team_answers_not_voided_guard"[^;]*;'), 'SELECT 1;')]),
 dict(id='M3b', kind='db', desc='remove the void guard on judge_observations', edits=[(MIG, ('re', r'CREATE TRIGGER "judge_observations_not_voided_guard"[^;]*;'), 'SELECT 1;')]),
 dict(id='M4a', kind='db', desc='disable correction uniqueness on team_answers', edits=[(MIG, ('lit', '\tCONSTRAINT "team_answers_one_correction_key" UNIQUE("supersedes_answer_id"),\n'), '')]),
 dict(id='M4b', kind='db', desc='disable correction uniqueness on judge_observations', edits=[(MIG, ('lit', '\tCONSTRAINT "judge_observations_one_correction_key" UNIQUE("supersedes_observation_id"),\n'), '')]),
 dict(id='M5', kind='db', desc='allow a forged actor: the answer request accepts actorId and the service records it', edits=[
    (SCH, ('lit', "export const RecordTeamAnswerRequest = z.strictObject({\n  text: AnswerText,"), "export const RecordTeamAnswerRequest = z.strictObject({\n  actorId: Uuid.optional(),\n  text: AnswerText,"),
    (SVC, ('lit', "        supersedesAnswerId: body.supersedesAnswerId ?? null,\n        actorId: actor.id,"), "        supersedesAnswerId: body.supersedesAnswerId ?? null,\n        actorId: (body as { actorId?: string }).actorId ?? actor.id,")]),
 dict(id='M6a', kind='db', desc='skip the assessment-verification check on answers', edits=[(SVC, ('lit', "    if (!set.assessmentVerified) {\n      throw new InterviewApiError(\n        'ASSESSMENT_NOT_VERIFIED',\n        'This assessment did not pass verification, so no interview record can be added to it',\n      );\n    }\n    if (!set.questions.some"), "    if (!set.questions.some")]),
 dict(id='M7', kind='db', desc='disable the idempotency conflict check (same key, different content replays)', edits=[(STORE, ('all', "    if (earlier.requestHash !== input.requestHash) throw new InterviewKeyReusedError();\n"), '')]),
 dict(id='M8', kind='db', desc='put the typed answer into the audit metadata', edits=[(STORE, ('lit', "            questionId: input.questionId,\n            role: input.role,\n            ...(input.supersedesAnswerId === null"), "            questionId: input.questionId,\n            role: input.role,\n            text: input.text,\n            ...(input.supersedesAnswerId === null")]),
 dict(id='M9', kind='ui', desc='mark testimony as verified evidence in the UI', edits=[(VIEW, ('lit', '<small>Testimony recorded by the judge. Not a verified fact.</small>'), '<small>Verified evidence recorded by the judge.</small>')]),
 dict(id='M10', kind='ui', desc='hide the linked uncertainty from the UI', edits=[(VIEW, ('lit', '      {addressed.length > 0 ? (\n'), '      {false ? (\n')]),
 dict(id='M11', kind='ui', desc='lose the typed values after a failed save', edits=[(ACT, ('lit', "    outcomeUnknown: rule === undefined && outcomeIsUnknown(result),\n    values,\n"), "    outcomeUnknown: rule === undefined && outcomeIsUnknown(result),\n    values: EMPTY_INTERVIEW_FORM.values,\n")]),
 dict(id='M1e', kind='db', desc='remove composite FK judge_observations_assessment_same_project_fk', edits=[(MIG, ('re', r'ALTER TABLE "judge_observations" ADD CONSTRAINT "judge_observations_assessment_same_project_fk"[^;]*;'), 'SELECT 1;')]),
 dict(id='M1f', kind='db', desc='remove composite FK team_answers_supersedes_same_question_fk (answer correction must be of the same question)', edits=[(MIG, ('re', r'ALTER TABLE "team_answers" ADD CONSTRAINT "team_answers_supersedes_same_question_fk"[^;]*;'), 'SELECT 1;')]),
 dict(id='M1g', kind='db', desc='remove composite FK judge_observations_supersedes_same_assessment_fk (observation correction stays in the assessment)', edits=[(MIG, ('re', r'ALTER TABLE "judge_observations" ADD CONSTRAINT "judge_observations_supersedes_same_assessment_fk"[^;]*;'), 'SELECT 1;')]),
]
AUTHOR = ['interview-store.test', 'interview-concurrency.test', 'interview-http.test', 'm7-migration-upgrade', 'interview/view.test', 'interview/actions.test']
REVIEW = ['tests/r10/t1-provenance', 'tests/r10/t2-immutability', 'tests/r10/t2b', 'tests/r10/t3-concurrency', 'tests/r10/t4-auth', 'tests/r10/t5-unverified', 'tests/r10/t6-trust', 'tests/r10/t7-migration']

def run(cmd, timeout=1800):
    t = time.time()
    p = subprocess.run(cmd, cwd=ATK, env=ENV, capture_output=True, text=True, timeout=timeout)
    txt = p.stdout + p.stderr
    fails = sorted(set(re.findall(r'^\s*(?:FAIL|×)\s+(\S.*?)(?:\s+\d+ms)?$', txt, re.M)))[:12]
    m = re.search(r'Tests\s+(.*)', txt)
    return dict(exit=p.returncode, seconds=round(time.time()-t), summary=(m.group(1).strip() if m else '(no summary)'), failing=[f[:230] for f in fails])

def apply(mut):
    backups = {}
    for f, (mode, old), new in mut['edits']:
        path = os.path.join(ATK, f)
        if f not in backups: backups[f] = open(path).read()
        s = open(path).read()
        if mode == 're':
            s2, n = re.subn(old, new, s)
            assert n == 1, (mut['id'], f, 're matches', n)
        elif mode == 'all':
            n = s.count(old); assert n >= 1, (mut['id'], f, 'literal not found'); s2 = s.replace(old, new)
        else:
            n = s.count(old); assert n == 1, (mut['id'], f, 'literal matches', n); s2 = s.replace(old, new)
        open(path, 'w').write(s2)
    return backups
def restore(backups):
    for f, s in backups.items(): open(os.path.join(ATK, f), 'w').write(s)

only = sys.argv[1:] 
results = json.load(open(OUT+'/results.json')) if os.path.exists(OUT+'/results.json') else {}
def save(): json.dump(results, open(OUT+'/results.json', 'w'), indent=1)
if not only or 'CONTROL' in only:
    results['CONTROL'] = dict(desc='unmutated target', author=run(['pnpm','vitest','run',*AUTHOR]), reviewer=run(['pnpm','vitest','run',*REVIEW])); save(); print('CONTROL', json.dumps(results['CONTROL']), flush=True)
for mut in MUT:
    if only and mut['id'] not in only: continue
    if mut['kind'] == 'ui' and not (only and mut['id'] in only): continue   # UI mutants are run explicitly (they need a web rebuild)
    b = apply(mut)
    try:
        a = run(['pnpm','vitest','run',*AUTHOR]); r = run(['pnpm','vitest','run',*REVIEW])
    finally:
        restore(b)
    results[mut['id']] = dict(desc=mut['desc'], author=a, reviewer=r, author_killed=a['exit']!=0, reviewer_killed=r['exit']!=0); save()
    print(mut['id'], 'author_killed=%s reviewer_killed=%s' % (a['exit']!=0, r['exit']!=0), json.dumps(dict(author=a['failing'][:3], reviewer=r['failing'][:3])), flush=True)
