# Resolves git conflict hunks in a file by a choice per hunk, in order: o(urs), t(heirs), b(oth: ours then theirs),
# r (both: theirs then ours). Usage: resolve.py <file> <choices, e.g. tttb>
import sys, re
path, choices = sys.argv[1], sys.argv[2]
lines = open(path).read().split('\n')
out, i, h = [], 0, 0
while i < len(lines):
    if lines[i].startswith('<<<<<<< '):
        ours, theirs, j = [], [], i + 1
        while not lines[j].startswith('======='): ours.append(lines[j]); j += 1
        j += 1
        while not lines[j].startswith('>>>>>>> '): theirs.append(lines[j]); j += 1
        c = choices[h]; h += 1
        out += {'o': ours, 't': theirs, 'b': ours + theirs, 'r': theirs + ours}[c]
        i = j + 1
    else:
        out.append(lines[i]); i += 1
assert h == len(choices), f'{path}: {h} hunks, {len(choices)} choices'
open(path, 'w').write('\n'.join(out)); print(f'{path}: {h} hunks resolved')
