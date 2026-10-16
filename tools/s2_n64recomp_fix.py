# Stadium 2 (michiiik/mstan N64Recomp fork) + N64Recomp-browser patch: after resolving conflicts with the fork's call
# emitters (tools/resolve.py: context.h rb, generator.h oo, cgenerator.cpp o, recompilation.cpp ooo,
# live_recompiler.h o, live_generator.cpp o, OfflineModRecomp/main.cpp ooo, src/main.cpp t), drop the kit's
# emit_tail_call_start (the fork has its own tail-call trampoline) and record called names for funcs.h.
import sys
p = sys.argv[1] + '/src/cgenerator.cpp'; s = open(p).read()
if 'void N64Recomp::CGenerator::emit_tail_call_start' in s:
    a = s.index('void N64Recomp::CGenerator::emit_tail_call_start'); b = s.index('void N64Recomp::CGenerator::emit_goto')
    s = s[:a] + s[b:]
old = '''    const N64Recomp::ReferenceSymbol& sym = context.get_reference_symbol(section_index, symbol_index);
    emit_call_prologue(output_file);'''
if old in s:
    s = s.replace(old, '''    const N64Recomp::ReferenceSymbol& sym = context.get_reference_symbol(section_index, symbol_index);
    // funcs.h declares every name the output calls (WebAssembly traps on an undeclared call's guessed signature).
    context.called_functions.insert(sym.name);
    emit_call_prologue(output_file);''', 1)
old = '''uint32_t return_vram) const {
    emit_call_prologue(output_file);
    fmt::print(output_file, "    {}(rdram, ctx);\\n", context.functions[function_index].name);'''
if old in s:
    s = s.replace(old, '''uint32_t return_vram) const {
    context.called_functions.insert(context.functions[function_index].name);
    emit_call_prologue(output_file);
    fmt::print(output_file, "    {}(rdram, ctx);\\n", context.functions[function_index].name);''', 1)
open(p, 'w').write(s); print('called_functions inserts:', s.count('called_functions.insert'))
