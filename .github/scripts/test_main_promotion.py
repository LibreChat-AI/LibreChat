"""Exercise the policy embedded in the trusted workflow, using only the stdlib."""
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/promote-main.yml'
TEXT = WORKFLOW.read_text()
MATCH = re.search(r"^          cat > .* <<'PY'\n(.*?)^          PY$", TEXT, re.M | re.S)
if MATCH is None:
    raise RuntimeError('Inline production policy was not found')
SOURCE = '\n'.join(line[10:] for line in MATCH[1].splitlines())
POLICY = types.ModuleType('promotion_policy')
exec(compile(SOURCE, str(WORKFLOW), 'exec'), POLICY.__dict__)
DEV = 'd' * 40
MAIN = 'a' * 40
ENV = {
    'DEV_SHA': DEV,
    'EXPECTED_MAIN_SHA': MAIN,
    'GITHUB_REPOSITORY': POLICY.REPO,
    'GITHUB_EVENT_NAME': 'workflow_dispatch',
    'GITHUB_REF': 'refs/heads/main',
    'GITHUB_SERVER_URL': 'https://github.com',
    'GITHUB_API_URL': 'https://api.github.com',
    'WORKFLOW_REF': POLICY.WORKFLOW,
    'WORKFLOW_SHA': MAIN,
    'GITHUB_SHA': MAIN,
    'GITHUB_ACTOR': 'danny-avila',
    'GITHUB_TRIGGERING_ACTOR': 'release-maintainer',
    'GH_TOKEN': 'read-only-fixture',
    'PROMOTION_TOKEN': 'write-fixture',
}


def fixtures():
    result = {
        'environments/main-promotion': {
            'can_admins_bypass': False,
            'deployment_branch_policy': {
                'protected_branches': False, 'custom_branch_policies': True,
            },
            'protection_rules': [{
                'type': 'required_reviewers', 'prevent_self_review': True,
                'reviewers': [{'type': 'User', 'reviewer': {'login': 'reviewer'}}],
            }],
        },
        'environments/main-promotion/deployment-branch-policies?per_page=100': {
            'total_count': 1, 'branch_policies': [{'name': 'main', 'type': 'branch'}],
        },
    }
    for actor in ('danny-avila', 'release-maintainer'):
        result[f'collaborators/{actor}/permission'] = {
            'permission': 'admin', 'role_name': 'admin',
        }
    for branch, sha in [('main', MAIN), ('dev', DEV)]:
        result[f'git/ref/heads/{branch}'] = {
            'ref': f'refs/heads/{branch}', 'object': {'type': 'commit', 'sha': sha},
        }
    for index, (filename, (workflow_id, required)) in enumerate(POLICY.CI.items(), 1):
        result[f'actions/workflows/{filename}'] = {
            'id': workflow_id, 'path': f'.github/workflows/{filename}', 'state': 'active',
        }
        run = {
            'id': index, 'run_attempt': 2, 'workflow_id': workflow_id,
            'path': f'.github/workflows/{filename}', 'event': 'push',
            'head_branch': 'dev', 'head_sha': DEV,
            'repository': {'full_name': POLICY.REPO},
            'status': 'completed', 'conclusion': 'success',
        }
        result[f'actions/workflows/{workflow_id}/runs?head_sha={DEV}&per_page=100'] = {
            'total_count': 1, 'workflow_runs': [run],
        }
        result[f'actions/runs/{index}'] = copy.deepcopy(run)
        jobs = [{'name': name, 'head_sha': DEV, 'status': 'completed', 'conclusion': 'success'}
                for name in sorted(required)]
        jobs.append({'name': 'Codegraph select', 'head_sha': DEV,
                     'status': 'completed', 'conclusion': 'skipped'})
        result[f'actions/runs/{index}/attempts/2/jobs?per_page=100'] = {
            'total_count': len(jobs), 'jobs': jobs,
        }
    return result


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.data = fixtures()
        self.calls = []
        self.git_calls = []
        self.scratch = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.scratch.cleanup)
        self.addCleanup(patch.stopall)
        self.env = dict(ENV, RUNNER_TEMP=self.scratch.name,
                        GITHUB_STEP_SUMMARY=str(Path(self.scratch.name) / 'summary'))
        patch.dict(os.environ, self.env, clear=True).start()
        patch.object(POLICY, 'api', self.api).start()
        patch.object(POLICY, 'git', self.git).start()

    def api(self, path):
        self.calls.append(path)
        if path not in self.data:
            raise POLICY.Refused('Missing fixture')
        return copy.deepcopy(self.data[path])

    def git(self, args, token):
        self.git_calls.append((args, token))
        if 'rev-parse' in args:
            return MAIN if args[-1] == 'refs/heads/main' else DEV
        return ''

    def refuse(self, operation=POLICY.verify):
        with self.assertRaises(POLICY.Refused):
            operation()
        self.assertFalse(any('push' in args for args, _ in self.git_calls))

    def ci_run(self, index=1):
        workflow_id = list(POLICY.CI.values())[index - 1][0]
        return self.data[f'actions/workflows/{workflow_id}/runs?head_sha={DEV}&per_page=100']

    def ci_jobs(self, index=1):
        return self.data[f'actions/runs/{index}/attempts/2/jobs?per_page=100']

    def test_verified_full_ci_fetches_objects_but_never_pushes(self):
        self.assertEqual(POLICY.verify()[:2], (DEV, MAIN))
        self.assertTrue(any('merge-base' in args for args, _ in self.git_calls))
        self.assertFalse(any('checkout' in args or 'push' in args for args, _ in self.git_calls))
        self.assertTrue(all(token == ENV['GH_TOKEN'] for _, token in self.git_calls))

    def test_rejects_shell_injection_and_nonexact_hashes(self):
        for candidate in ('dev', DEV[:7], DEV.upper(), DEV + '\n', '--all',
                          '$(touch release)', DEV + ';echo unsafe', ''):
            with self.subTest(candidate=candidate), patch.dict(os.environ, DEV_SHA=candidate):
                self.refuse()
        self.assertEqual(self.git_calls, [])

    def test_requires_main_dispatch_and_fixed_repository_and_hosts(self):
        for key, value in {
            'GITHUB_REPOSITORY': 'attacker/LibreChat', 'GITHUB_EVENT_NAME': 'pull_request_target',
            'GITHUB_REF': 'refs/heads/dev', 'GITHUB_SERVER_URL': 'https://evil.example',
            'GITHUB_API_URL': 'https://evil.example', 'WORKFLOW_REF': POLICY.WORKFLOW + '-evil',
            'WORKFLOW_SHA': DEV, 'GITHUB_SHA': DEV,
        }.items():
            with self.subTest(key=key), patch.dict(os.environ, {key: value}):
                self.refuse()

    def test_requires_original_and_rerun_actor_authorization(self):
        for actor in ('danny-avila', 'release-maintainer'):
            path = f'collaborators/{actor}/permission'
            original = self.data[path]
            self.data[path] = {'permission': 'write', 'role_name': 'write'}
            self.refuse()
            self.data[path] = original

    def test_maintain_role_is_allowed_but_custom_writer_role_is_not(self):
        path = 'collaborators/release-maintainer/permission'
        self.data[path] = {'permission': 'write', 'role_name': 'maintain'}
        self.assertEqual(POLICY.context(), (DEV, MAIN))
        self.data[path] = {'permission': 'write', 'role_name': 'publisher'}
        self.refuse()

    def test_actor_cannot_inject_an_api_path(self):
        with patch.dict(os.environ, GITHUB_ACTOR='../git/refs'):
            self.refuse()

    def test_missing_or_unprotected_environment_refuses(self):
        value = self.data['environments/main-promotion']
        for key, replacement in [
            ('can_admins_bypass', True), ('can_admins_bypass', None),
            ('protection_rules', []), ('deployment_branch_policy', None),
            ('deployment_branch_policy', {'protected_branches': True, 'custom_branch_policies': False}),
        ]:
            with self.subTest(key=key, replacement=replacement):
                old = value[key]
                value[key] = replacement
                self.refuse()
                value[key] = old
        del self.data['environments/main-promotion']
        self.refuse()

    def test_requires_nonself_approval_and_reviewers(self):
        rule = self.data['environments/main-promotion']['protection_rules'][0]
        for key, value in [('prevent_self_review', False), ('prevent_self_review', None), ('reviewers', [])]:
            old = rule[key]
            rule[key] = value
            self.refuse()
            rule[key] = old

    def test_environment_rejects_wildcards_tags_and_extra_branches(self):
        path = 'environments/main-promotion/deployment-branch-policies?per_page=100'
        for rows in [[{'name': '*', 'type': 'branch'}], [{'name': 'main', 'type': 'tag'}],
                     [{'name': 'main', 'type': 'branch'}, {'name': 'dev', 'type': 'branch'}], []]:
            with self.subTest(rows=rows):
                self.data[path] = {'total_count': len(rows), 'branch_policies': rows}
                self.refuse()

    def test_drifted_main_or_dev_refuses(self):
        for branch in ('main', 'dev'):
            value = self.data[f'git/ref/heads/{branch}']['object']
            old = value['sha']
            value['sha'] = 'b' * 40
            self.refuse()
            value['sha'] = old

    def test_incomplete_or_oversized_responses_refuse(self):
        for value in ({'total_count': 2, 'rows': [1]}, {'rows': []},
                      {'total_count': 100, 'rows': list(range(100))}):
            with self.subTest(value=value.get('total_count')):
                self.refuse(lambda: POLICY.complete_list(value, 'rows'))

    def test_requires_real_workflow_ids_paths_and_active_state(self):
        for filename, (workflow_id, _) in POLICY.CI.items():
            workflow = self.data[f'actions/workflows/{filename}']
            for key, replacement in [('id', workflow_id + 1), ('path', '.github/workflows/fake.yml'),
                                     ('state', 'disabled_manually')]:
                old = workflow[key]
                workflow[key] = replacement
                self.refuse()
                workflow[key] = old

    def test_only_exact_dev_full_runs_count_not_prs_forks_or_old_commits(self):
        run = self.ci_run()['workflow_runs'][0]
        for key, replacement in [('event', 'pull_request'), ('event', 'workflow_run'),
                                 ('head_branch', 'topic'), ('head_sha', MAIN),
                                 ('repository', {'full_name': 'attacker/LibreChat'})]:
            old = run[key]
            run[key] = replacement
            self.refuse()
            run[key] = old
        run['event'] = 'workflow_dispatch'
        self.data['actions/runs/1']['event'] = 'workflow_dispatch'
        self.assertEqual(POLICY.verify()[:2], (DEV, MAIN))

    def test_no_workflow_run_means_not_tested(self):
        self.ci_run().update(total_count=0, workflow_runs=[])
        self.refuse()

    def test_newer_failed_or_pending_run_cannot_hide_behind_old_success(self):
        value = self.ci_run()
        old = copy.deepcopy(value['workflow_runs'][0])
        for status, conclusion in [('completed', 'failure'), ('in_progress', None),
                                   ('completed', 'cancelled'), ('completed', 'skipped')]:
            value['workflow_runs'] = [old, dict(old, id=100, status=status, conclusion=conclusion)]
            value['total_count'] = 2
            self.refuse()

    def test_ci_rerun_during_job_verification_refuses(self):
        for key, value in [('run_attempt', 3), ('status', 'in_progress'), ('conclusion', 'failure')]:
            old = self.data['actions/runs/1'][key]
            self.data['actions/runs/1'][key] = value
            self.refuse()
            self.data['actions/runs/1'][key] = old

    def test_every_required_shard_must_exist_and_succeed(self):
        for index in (1, 2):
            jobs = self.ci_jobs(index)
            original = copy.deepcopy(jobs)
            for name in POLICY.CI[list(POLICY.CI)[index - 1]][1]:
                with self.subTest(job=name):
                    jobs['jobs'] = [job for job in original['jobs'] if job['name'] != name]
                    jobs['total_count'] = len(jobs['jobs'])
                    self.refuse()
            jobs.update(original)
            for conclusion in ('skipped', 'cancelled', 'neutral', 'failure', None):
                jobs['jobs'][0]['conclusion'] = conclusion
                self.refuse()
            jobs.update(original)

    def test_duplicate_incomplete_wrong_sha_and_failed_extra_jobs_refuse(self):
        jobs = self.ci_jobs()
        old = copy.deepcopy(jobs)
        jobs['jobs'].append(copy.deepcopy(jobs['jobs'][0]))
        jobs['total_count'] += 1
        self.refuse()
        jobs.update(copy.deepcopy(old))
        jobs['jobs'][0]['head_sha'] = MAIN
        self.refuse()
        jobs.update(copy.deepcopy(old))
        jobs['jobs'][0]['status'] = 'in_progress'
        self.refuse()
        jobs.update(copy.deepcopy(old))
        jobs['jobs'].append({'name': 'Additional security test', 'head_sha': DEV,
                             'status': 'completed', 'conclusion': 'failure'})
        jobs['total_count'] += 1
        self.refuse()

    def test_control_plane_changes_refuse_automated_promotion(self):
        original = self.git
        def changed(args, token):
            return '.github/workflows/changed.yml' if 'diff' in args else original(args, token)
        with patch.object(POLICY, 'git', changed):
            self.refuse()

    def test_main_or_dev_can_change_during_fetch_without_any_push(self):
        original = self.git
        for branch in ('main', 'dev'):
            def move(args, token):
                if 'fetch' in args:
                    self.data[f'git/ref/heads/{branch}']['object']['sha'] = 'b' * 40
                return original(args, token)
            self.data.update(fixtures())
            with patch.object(POLICY, 'git', move):
                self.refuse()

    def test_revalidation_refuses_before_using_write_token(self):
        self.data['git/ref/heads/dev']['object']['sha'] = MAIN
        with patch.object(sys, 'argv', ['policy', 'promote']):
            self.refuse(POLICY.run)
        self.assertFalse(any(token == ENV['PROMOTION_TOKEN'] for _, token in self.git_calls))

    def test_success_pushes_only_pinned_sha_to_main_without_force(self):
        original = self.git
        def push(args, token):
            if 'push' in args:
                self.data['git/ref/heads/main']['object']['sha'] = DEV
            return original(args, token)
        with patch.object(POLICY, 'git', push), patch.object(sys, 'argv', ['policy', 'promote']):
            POLICY.run()
        pushes = [(args, token) for args, token in self.git_calls if 'push' in args]
        self.assertEqual(len(pushes), 1)
        self.assertEqual(pushes[0][0][-2:], [POLICY.REMOTE, f'{DEV}:refs/heads/main'])
        self.assertEqual(pushes[0][1], ENV['PROMOTION_TOKEN'])
        self.assertFalse(any('force' in arg for arg in pushes[0][0]))

    def test_api_failures_and_malformed_data_fail_closed(self):
        with patch.object(POLICY, 'api', side_effect=POLICY.Refused('API unavailable')):
            self.refuse()

    def test_already_current_does_not_push(self):
        with patch.object(POLICY, 'verify', return_value=(DEV, DEV, [])), \
             patch.object(POLICY, 'ref', return_value=DEV), \
             patch.object(sys, 'argv', ['policy', 'promote']):
            POLICY.run()
        self.assertEqual(self.git_calls, [])
        self.assertIn('Already current', Path(self.env['GITHUB_STEP_SUMMARY']).read_text())

    def test_failed_post_push_read_does_not_repeat_the_push(self):
        original = self.git
        def push(args, token):
            result = original(args, token)
            if 'push' in args:
                del self.data['git/ref/heads/main']
            return result
        with patch.object(POLICY, 'git', push), patch.object(sys, 'argv', ['policy', 'promote']):
            with self.assertRaises(POLICY.Refused):
                POLICY.run()
        self.assertEqual(sum('push' in args for args, _ in self.git_calls), 1)


class AdapterTests(unittest.TestCase):
    def test_api_uses_fixed_host_and_never_prints_raw_errors(self):
        failed = subprocess.CompletedProcess([], 1, stdout='credential-like diagnostic',
                                             stderr='untrusted server error')
        with patch.object(subprocess, 'run', return_value=failed) as run:
            with self.assertRaisesRegex(POLICY.Refused, '^GitHub policy read failed'):
                POLICY.api('git/ref/heads/main')
        self.assertIn('github.com', run.call_args.args[0])
        self.assertNotIn('shell', run.call_args.kwargs)
        for output in ('not-json', ''):
            with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output)):
                with self.assertRaisesRegex(POLICY.Refused, 'Invalid GitHub response'):
                    POLICY.api('git/ref/heads/main')

    def test_git_credentials_are_not_arguments_or_persisted_config(self):
        result = subprocess.CompletedProcess([], 0, stdout='ok', stderr='')
        token = 'synthetic-token'
        with patch.object(subprocess, 'run', return_value=result) as run, patch('builtins.print'):
            self.assertEqual(POLICY.git(['push', POLICY.REMOTE, DEV + ':refs/heads/main'], token), 'ok')
        argv = run.call_args.args[0]
        self.assertFalse(any(token in arg for arg in argv))
        self.assertEqual(argv[:3], ['git', '-c', 'core.hooksPath=/dev/null'])
        env = run.call_args.kwargs['env']
        self.assertEqual(env['GIT_CONFIG_GLOBAL'], '/dev/null')
        self.assertEqual(env['GIT_CONFIG_NOSYSTEM'], '1')
        self.assertEqual(env['GIT_CONFIG_KEY_0'], 'http.https://github.com/.extraheader')
        self.assertNotIn('shell', run.call_args.kwargs)


class GitIntegrationTests(unittest.TestCase):
    def test_bare_git_fast_forward_preserves_hashes_and_refuses_divergence(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
                       GIT_AUTHOR_NAME='test', GIT_AUTHOR_EMAIL='test@example.invalid',
                       GIT_COMMITTER_NAME='test', GIT_COMMITTER_EMAIL='test@example.invalid')
            origin = str(Path(directory) / 'origin.git')
            local = str(Path(directory) / 'local.git')
            def git(*args, stdin=None, check=True):
                return subprocess.run(['git', *args], env=env, input=stdin, capture_output=True,
                                      text=True, check=check).stdout.strip()
            git('init', '--bare', origin)
            tree = git('--git-dir', origin, 'mktree', stdin='')
            main = git('--git-dir', origin, 'commit-tree', tree, '-m', 'main')
            dev = git('--git-dir', origin, 'commit-tree', tree, '-p', main, '-m', 'dev')
            divergent = git('--git-dir', origin, 'commit-tree', tree, '-p', main, '-m', 'other')
            git('--git-dir', origin, 'update-ref', 'refs/heads/main', main)
            git('--git-dir', origin, 'update-ref', 'refs/heads/dev', dev)
            git('init', '--bare', local)
            git('--git-dir', local, 'fetch', '--no-tags', origin,
                '+refs/heads/main:refs/heads/main', '+refs/heads/dev:refs/heads/dev')
            git('--git-dir', local, 'merge-base', '--is-ancestor', main, dev)
            git('--git-dir', local, 'push', origin, f'{dev}:refs/heads/main')
            self.assertEqual(git('--git-dir', origin, 'rev-parse', 'refs/heads/main'), dev)
            git('--git-dir', origin, 'update-ref', 'refs/heads/main', divergent)
            refused = subprocess.run(['git', '--git-dir', local, 'push', origin,
                                      f'{dev}:refs/heads/main'], env=env, capture_output=True)
            self.assertNotEqual(refused.returncode, 0)
            self.assertEqual(git('--git-dir', origin, 'rev-parse', 'refs/heads/main'), divergent)


class WorkflowBoundaryTests(unittest.TestCase):
    def test_write_job_has_no_untrusted_execution_sources(self):
        self.assertNotRegex(TEXT, r'pull_request_target:|workflow_run:|repository_dispatch:|schedule:')
        self.assertNotRegex(TEXT, r'uses: (?:\./|actions/(?:checkout|cache|download-artifact|setup-node))')
        self.assertNotRegex(TEXT, r'\bnpm\s|\bnpx\s|\bpip\s|--force|force-with-lease|shell:\s*python')
        self.assertIn('permissions: {}', TEXT)
        self.assertIn('environment: main-promotion', TEXT)
        self.assertIn('cancel-in-progress: false', TEXT)
        self.assertIn('permission-contents: write', TEXT)
        self.assertNotIn('permission-workflows:', TEXT)
        actions = re.findall(r'uses: ([^\s]+)', TEXT)
        self.assertEqual(actions, ['actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349'])
        self.assertNotRegex(SOURCE, r'\beval\(|\bexec\(|shell=True')

    def test_inputs_and_credentials_are_not_interpolated_into_shell_source(self):
        for block in re.findall(r'        run: \|\n(.*?)(?=\n      -|\Z)', TEXT, re.S):
            self.assertNotIn('${{', block)
        self.assertLess(TEXT.index('python3 -I "$RUNNER_TEMP/main-promotion.py" verify'),
                        TEXT.index('uses: actions/create-github-app-token@'))
        self.assertNotIn('skip-token-revoke: true', TEXT)

    def test_selected_pr_tests_cannot_masquerade_as_full_ci(self):
        for filename in POLICY.CI:
            text = (ROOT / '.github/workflows' / filename).read_text()
            self.assertIn('  workflow_dispatch:', text)
            self.assertIn("github.event_name == 'pull_request'", text)

    def test_control_plane_is_code_owned(self):
        owners = (ROOT / '.github/CODEOWNERS').read_text()
        for path in ('/.github/CODEOWNERS', '/.github/workflows/', '/.github/scripts/'):
            self.assertIn(f'{path} @danny-avila', owners)


if __name__ == '__main__':
    unittest.main(verbosity=2)
