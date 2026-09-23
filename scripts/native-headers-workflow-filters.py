"""Exclude fork publication tags from upstream push workflows in the release tree."""
import re
import sys
from pathlib import Path

import yaml


# GitHub uses YAML 1.2 booleans: the event key 'on' is a string, not True.
class WorkflowLoader(yaml.SafeLoader):
    pass


WorkflowLoader.yaml_implicit_resolvers = {
    key: [(tag, regex) for tag, regex in values if tag != 'tag:yaml.org,2002:bool']
    for key, values in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
WorkflowLoader.add_implicit_resolver(
    'tag:yaml.org,2002:bool', re.compile(r'^(?:true|false)$', re.I), list('tTfF')
)
EXCLUSIONS = ['**-native-headers', '**-native-headers-test', 'native-headers-preflight-**']


def protect_workflow(source):
    document = yaml.compose(source, Loader=WorkflowLoader)
    if not isinstance(document, yaml.MappingNode):
        raise ValueError('Expected a workflow mapping')
    event = next(((key, value) for key, value in document.value if key.value == 'on'), None)
    if event is None:
        return source
    key, node = event
    triggers = yaml.load(source, Loader=WorkflowLoader)['on']
    if isinstance(triggers, str):
        triggers = {triggers: None}
    elif isinstance(triggers, list):
        triggers = {trigger: None for trigger in triggers}
    if not isinstance(triggers, dict):
        raise ValueError('Unsupported workflow events')
    if 'push' not in triggers:
        return source
    push = triggers['push'] or {}
    if not isinstance(push, dict):
        raise ValueError('Unsupported push configuration')
    if ('branches' in push or 'branches-ignore' in push) and not any(
        field in push for field in ['tags', 'tags-ignore']
    ):
        return source  # Branch-only workflows do not run on tag pushes.
    field = 'tags' if 'tags' in push else 'tags-ignore'
    patterns = push.setdefault(field, [])
    if not isinstance(patterns, list):
        raise ValueError('Expected a list of tag patterns')
    for pattern in EXCLUSIONS:
        pattern = '!' + pattern if field == 'tags' else pattern
        if pattern not in patterns:
            patterns.append(pattern)
    triggers['push'] = push
    replacement = yaml.safe_dump({'on': triggers}, sort_keys=False, width=1000)
    return source[:key.start_mark.index] + replacement + source[node.end_mark.index:]


if __name__ == '__main__':
    directory = Path(sys.argv[1])
    for path in sorted(directory.iterdir()):
        if path.suffix not in ('.yml', '.yaml'):
            continue
        original = path.read_text()
        updated = protect_workflow(original)
        if updated != original:
            path.write_text(updated)
            print(f'Excluded fork tags from {path}')
