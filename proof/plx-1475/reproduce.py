#!/usr/bin/env python3
"""Read-only source/artifact verification. Does not execute plxd or measure a carrier."""
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PIN = '265b931bb592bd0bbb0131b55f248d67a30c9f2d'
BINARY_PIN = '447d2567db13b6a1c0cbdb970854fe69c4c3a88f'
ARTIFACT = Path('/Users/ryan-stoffel/.parallax/uploads/01a1b44f-82d5-778a-bb40-921006432c27/connect-timings-wifi-join.jsonl')
BINARY = Path('/Users/ryan-stoffel/.parallax/worktrees/plx-1466/target/debug/plxd')

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True)

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def summary(values):
    return {'n': len(values), 'medianMs': statistics.median(values),
            'p95Ms': sorted(values)[math.ceil(.95 * len(values)) - 1],
            'minMs': min(values), 'maxMs': max(values)}

assert git('rev-parse', 'HEAD').strip() == PIN
assert sha(ARTIFACT) == '8990fbae2fbe914a32736172f172e5996dc3ed82ce557b69907ec052cb14f81e'
assert sha(BINARY) == '93daf8fea63862a82b4d62bd523819c439ded6d693b5c96d8594283be475ba8a'
relevant = ['daemon/src/relay.rs', 'daemon/src/remote.rs',
            'daemon/src/server/remote.rs', 'daemon/src/server/connection.rs']
assert git('diff', BINARY_PIN, PIN, '--', *relevant) == ''
# All daemon source changes since the binary source pin are in timing diagnostics.
changed = git('diff', '--name-only', BINARY_PIN, PIN, '--', 'daemon', 'Cargo.lock', 'Cargo.toml').splitlines()
assert changed == ['daemon/src/connect_timing.rs'], changed
rows = [json.loads(line) for line in ARTIFACT.read_text().splitlines()]
t3, px = rows
metrics = px['metrics']
stages = metrics['stages']
assert len(stages) == 30
raw = []
for index, items in enumerate(stages):
    client = {i['stage']: i['ms'] for i in items if i['kind'] == 'connect-timing'}
    server = {i['stage']: i['ms'] for i in items if i['kind'] == 'connect-server-timing'}
    assert server['spare'] == 1
    delta = lambda end, start: client[end] - client[start]
    raw.append({'sample': index + 1, 'outer_tcp': delta('outer_tcp_proxy_ready', 'outer_connect_start'),
                'outer_tls': delta('outer_tls_ready', 'outer_tcp_proxy_ready'),
                'outer_upgrade': delta('relay_upgrade_ready', 'outer_tls_ready'),
                'inner_tls': delta('pinned_tls_ready', 'pinned_tls_start'),
                'inner_ws': delta('ws_upgrade_ready', 'ws_upgrade_start'),
                **{k: server[k] for k in ['stream_join', 'join_read', 'join_ready', 'join_delete_alarm', 'join_total']}})
assert all(all(row[k] == 0 for k in ['join_read', 'join_ready', 'join_delete_alarm', 'join_total']) for row in raw)
evidence_files = [ROOT / p for p in relevant + ['relay/src/index.ts', 'relay/src/host.ts', 'relay/src/stream.ts', 'relay/src/crypto.ts']]
research = [Path('/Users/ryan-stoffel/.parallax/worktrees/plx-1470-proof/RESEARCH.md'),
            Path('/Users/ryan-stoffel/.parallax/worktrees/plx-1471-research/HANDOFF.md'),
            Path('/Users/ryan-stoffel/.parallax/worktrees/plx-1471-research/COLD-PATH-ADDENDUM.md')]
print(json.dumps({'kind': 'source and supplied artifact verification, NOT candidate measurements',
    'sourcePin': PIN, 'binarySourceReference': BINARY_PIN, 'binaryExecuted': False,
    'binarySha256': sha(BINARY), 'daemonChangesSinceBinarySourceReference': changed,
    'artifactPath': str(ARTIFACT), 'artifactSha256': sha(ARTIFACT),
    'fileHashes': {str(p): sha(p) for p in evidence_files + research},
    'reportedProductSummaries': {'parallax': {k: metrics[k] for k in ['connect', 'firstEvent', 'roundTrip']},
                                't3': {k: t3[k] for k in ['connect', 'firstEvent', 'roundTrip']}},
    'matchedStageSummaries': {k: summary([row[k] for row in raw]) for k in raw[0] if k != 'sample'},
    'rawDerivedStageMs': raw,
    'candidateCarrierStartupSamples': [], 'candidateFreshLogicalStreamSamples': [],
    'limitations': ['No candidate implementation, no local injected delay runs, no security parity validation.',
                    'Binary build provenance cannot be established from source match and hash alone.',
                    'Cloudflare production clocks advance after I/O, not CPU execution: zeros are timer-invisible, not negligible/submillisecond work.',
                    'Whole join RPC cause unresolved: local CPU, pre-entry gates, queue/network/wake/response; no measured storage-wait removal.',
                    'End-to-end quantiles are stored summaries, not recomputable from raw end-to-end samples.',
                    'Product summaries differ in handler/process/security boundaries.']}, indent=2))
