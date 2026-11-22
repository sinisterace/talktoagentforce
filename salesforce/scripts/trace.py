#!/usr/bin/env python3
"""Compact summary of the newest preview trace: transitions, action calls, variable writes."""
import json, glob, os, sys

session = sys.argv[1]
count = int(sys.argv[2]) if len(sys.argv) > 2 else 1
base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    '.sfdx/agents/HVAC_Service_Voice_Agent/sessions', session, 'traces')
files = sorted(glob.glob(os.path.join(base, '*.json')), key=os.path.getmtime)[-count:]

INTERESTING = {'TransitionStep', 'FunctionStep', 'ActionStep', 'InvokeActionStep',
               'VariableUpdateStep', 'PlannerResponseStep', 'ErrorStep', 'FunctionErrorStep'}


def short(v, n=300):
    s = json.dumps(v) if not isinstance(v, str) else v
    return s if len(s) <= n else s[:n] + '...'


def walk(o):
    if isinstance(o, dict):
        t = o.get('stepType') or o.get('type')
        if t in INTERESTING:
            d = o.get('data', o)
            if t == 'VariableUpdateStep':
                for u in d.get('variable_updates', []):
                    name = u.get('variable_name', '')
                    if name.startswith('__') or name.startswith('AgentScriptInternal'):
                        continue
                    print(f'  VAR {name} = {short(u.get("variable_new_value"), 160)}')
            elif t == 'TransitionStep':
                print(f'  -> {d.get("to_agent") or d.get("targetNode") or short(d, 160)}')
            else:
                keys = {k: d[k] for k in d if k not in ('stepType', 'type', 'id', 'timestamp',
                                                        'safetyScore', 'startExecutionTime',
                                                        'endExecutionTime')}
                print(f'  {t}: {short(keys, 1200)}')
        for v in o.values():
            walk(v)
    elif isinstance(o, list):
        for v in o:
            walk(v)


for f in files:
    print('=== trace', os.path.basename(f))
    walk(json.load(open(f)))
