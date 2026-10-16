# Size breakdown of N64Recomp output: bytes in static_* vs other functions, and bytes of per-call tail-call blocks.
import sys, os, re
d = sys.argv[1]; tot = {'static': 0, 'func': 0}; cnt = {'static': 0, 'func': 0}; callblk = 0; calls = 0
for fn in os.listdir(d):
    if not fn.endswith('.c'): continue
    cur = None
    with open(os.path.join(d, fn), 'rb') as f:
        inblk = False
        for line in f:
            if line.startswith(b'RECOMP_FUNC '):
                cur = 'static' if b' static_' in line else 'func'; cnt[cur] += 1
            if cur: tot[cur] += len(line)
            if line.startswith(b'    gpr recomp_call_sp'): inblk = True; calls += 1
            if inblk:
                callblk += len(line)
                if line.startswith(b'}'): inblk = False
print({k: f'{v/1e9:.2f} GB' for k, v in tot.items()}, cnt, f'call blocks {callblk/1e9:.2f} GB over {calls} calls')
