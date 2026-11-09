#!/usr/bin/env python3
"""WCAG contrast check for config/nmb/nmb-theme.yaml (resolved against LibreChat defaults).

Usage: python3 config/nmb/check_contrast.py   (needs PyYAML; dark/light defaults are read
from packages/data-provider/src/themes/{default,dark}.ts for tokens the theme does not set)
Text pairs must reach 4.5:1 (AA); UI-component pairs (focus ring, control edge) 3:1.
"""
import re, sys, pathlib, yaml
root = pathlib.Path(__file__).resolve().parents[2]
theme = yaml.safe_load((root / 'config/nmb/nmb-theme.yaml').read_text())['interface']['theme']['modes']

def defaults(f):
    d = {}
    for m in re.finditer(r"'rgb-([a-z0-9-]+)':\s*'(\d+) (\d+) (\d+)'", (root / 'packages/data-provider/src/themes' / f).read_text()):
        d[m[1]] = tuple(int(m[i]) for i in (2, 3, 4))
    return d
base = {'light': defaults('default.ts'), 'dark': defaults('dark.ts')}

def lum(c):
    f = lambda v: (v / 255 / 12.92) if v / 255 <= 0.03928 else (((v / 255) + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
def cr(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)

fails = 0
for mode in ('light', 'dark'):
    t = dict(base[mode])
    for k, v in theme[mode]['colors'].items():
        t[k[4:]] = tuple(int(x) for x in v.split())
    g = lambda k: t[k]
    white = (255, 255, 255)
    surfaces = ['surface-primary', 'surface-primary-alt', 'surface-secondary', 'surface-tertiary', 'surface-sidebar',
                'surface-chat', 'surface-composer', 'surface-nav-selected', 'surface-nav-hover', 'surface-hover',
                'surface-user-message', 'surface-dialog', 'surface-menu', 'surface-code']
    checks = []  # (label, fg, bg, min)
    for s in surfaces:
        for fg in ('text-primary', 'text-secondary', 'text-secondary-alt', 'text-muted', 'link', 'link-inline'):
            checks.append((f'{fg} on {s}', g(fg), g(s), 4.5))
        checks.append((f'focus-outline on {s}', g('focus-outline'), g(s), 3.0))
        checks.append((f'focus-control on {s}', g('focus-control'), g(s), 3.0))
        checks.append((f'ring-primary on {s}', g('ring-primary'), g(s), 3.0))
    checks += [
        ('submit button: text-on-status on surface-submit', g('text-on-status'), g('surface-submit'), 4.5),
        ('submit button hover', g('text-on-status'), g('surface-submit-hover'), 4.5),
        ('send button: text-inverted on button-primary', g('text-inverted'), g('button-primary'), 4.5),
        ('send button hover', g('text-inverted'), g('button-primary-hover'), 4.5),
        ('accent-primary (auth links) on surface-primary', g('accent-primary'), g('surface-primary'), 4.5),
        ('accent-primary-hover on surface-primary', g('accent-primary-hover'), g('surface-primary'), 4.5),
        ('submit button vs page (non-text)', g('surface-submit'), g('surface-primary'), 3.0),
        ('send button vs composer (non-text)', g('button-primary'), g('surface-composer'), 3.0),
        ('border-heavy on surface-primary (control edge)', g('border-heavy'), g('surface-primary'), 3.0),
        ('text-primary on user message bubble', g('text-primary'), g('surface-user-message'), 4.5),
    ]
    print(f'== {mode} ==')
    for label, fg, bg, need in checks:
        r = cr(fg, bg); ok = r >= need; fails += not ok
        if not ok or '--all' in sys.argv or label in {c[0] for c in checks[:0]}:
            print(f'{"PASS" if ok else "FAIL"} {r:5.2f} (>= {need}) {label}')
    rs = [cr(fg, bg) for _, fg, bg, need in checks if need == 4.5]
    print(f'{len(checks)} checks; lowest text pair {min(rs):.2f}')
    lo = min(checks, key=lambda c: cr(c[1], c[2]) / c[3]); print('tightest:', lo[0], f'{cr(lo[1], lo[2]):.2f}')
print('FAILURES:', fails); sys.exit(1 if fails else 0)
