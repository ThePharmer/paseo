import importlib.util
import unittest
from pathlib import Path

import yaml

spec = importlib.util.spec_from_file_location('filters', Path(__file__).with_name('native-headers-workflow-filters.py'))
filters = importlib.util.module_from_spec(spec)
spec.loader.exec_module(filters)


class WorkflowFiltersTest(unittest.TestCase):
    def transform(self, source):
        return yaml.load(filters.protect_workflow(source), Loader=filters.WorkflowLoader)

    def test_positive_tag_filters_exclude_fork_tags_last(self):
        source = 'on:\n  push:\n    tags: ["v*", "!v*-beta.*"]\n'
        self.assertEqual(self.transform(source)['on']['push']['tags'],
                         ['v*', '!v*-beta.*', '!**-native-headers', '!**-native-headers-test',
                          '!native-headers-preflight-**'])

    def test_unfiltered_push_gets_ignored_tags(self):
        for source in ['on: push\n', 'on: [push, workflow_dispatch]\n', 'on:\n  push:\n']:
            self.assertEqual(self.transform(source)['on']['push']['tags-ignore'], filters.EXCLUSIONS)

    def test_existing_ignored_tags_are_preserved(self):
        source = 'on:\n  push:\n    tags-ignore: ["test-*"]\n'
        self.assertEqual(self.transform(source)['on']['push']['tags-ignore'], ['test-*'] + filters.EXCLUSIONS)

    def test_branch_only_and_manual_workflows_are_unchanged(self):
        for source in ['on:\n  push:\n    branches: [main]\n', 'on: workflow_dispatch\n']:
            self.assertEqual(filters.protect_workflow(source), source)

    def test_other_events_and_job_bytes_are_preserved(self):
        jobs = 'jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ github.ref }}"\n'
        source = 'on:\n  push:\n    tags: ["v*"]\n  workflow_dispatch:\n    inputs:\n      force:\n        type: boolean\n        default: false\n' + jobs
        result = filters.protect_workflow(source)
        self.assertTrue(result.endswith(jobs))
        self.assertIs(self.transform(source)['on']['workflow_dispatch']['inputs']['force']['default'], False)
        self.assertEqual(filters.protect_workflow(result), result)


if __name__ == '__main__':
    unittest.main()
