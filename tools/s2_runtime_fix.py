# Stadium 2 runtime fork (michiiik/N64ModernRuntime) + kit patch, after tools/resolve.py (threads.cpp r,
# threadqueue.cpp o, recomp.cpp t, mods.hpp ttt, mods.cpp tttttt): drop what the kit's side brought from newer
# upstream that the fork lacks (mod deprecation), and use the fork's variable names in the kit's lines.
import sys, re
root = sys.argv[1]
def edit(rel, fn):
    p = f'{root}/{rel}'; s = open(p).read(); n = fn(s); open(p, 'w').write(n); print(rel, 'changed' if n != s else 'unchanged')
def drop_deprecated(s):
    s = re.sub(r'\n[ \t]*void register_deprecated_mod\([^;{]*\);', '', s)
    s = re.sub(r'\nvoid recomp::mods::(ModContext::)?register_deprecated_mod\([^{]*\{.*?\n\}\n', '\n', s, flags=re.S)
    return s
edit('librecomp/include/librecomp/mods.hpp', drop_deprecated)
edit('librecomp/src/recomp.cpp', drop_deprecated)
def mods_cpp(s):
    s = drop_deprecated(s)
    s = s.replace('    using namespace recomp::mods;\n    size_t reference_symbol_index = 0;', '    using namespace recomp::mods;\n    size_t resolved_count = 0;', 1)
    return s
edit('librecomp/src/mods.cpp', mods_cpp)
