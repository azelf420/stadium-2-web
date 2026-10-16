# Stadium 2 N64Recomp fork: N64RECOMP_STATIC_ENTRIES=<file> turns each static function that lies inside a real
# function P (which the fork emits as a whole copy of P entered at the static's address) into a dispatch entry of P
# and a 4-line wrapper. Pass 1 (file missing) discovers every static without writing function bodies and saves the
# list; pass 2 (file present) seeds the statics, adds the entries to P before P is recompiled, and emits wrappers.
# Without the variable nothing changes. Idempotent.
import sys
p = sys.argv[1] + '/src/main.cpp'; s = open(p).read()
if 'N64RECOMP_STATIC_ENTRIES' in s: print('already applied'); sys.exit()
def rep(old, new):
    global s
    assert s.count(old) == 1, (s.count(old), old[:80]); s = s.replace(old, new)

rep('''    register_interior_dispatch_aliases(context);
''', '''    register_interior_dispatch_aliases(context);

    // Static-entry dedup (see tools/s2_static_dedup.py in n64-web): pass 1 discovers, pass 2 dedups.
    const char* static_entries_env = std::getenv("N64RECOMP_STATIC_ENTRIES");
    const std::filesystem::path static_entries_path = static_entries_env ? static_entries_env : "";
    const bool static_dedup_discover = static_entries_env && !std::filesystem::exists(static_entries_path);
    const bool static_dedup_apply = static_entries_env && !static_dedup_discover;
    std::set<std::pair<size_t, uint32_t>> static_dedup_entries; // (containing real function, static vram)
    std::vector<std::tuple<uint32_t, size_t, std::string>> static_dedup_record; // (static vram, section, P or "-")
    if (static_dedup_apply) {
        std::ifstream in{ static_entries_path };
        uint32_t vram; size_t sec; std::string parent; size_t n_entries = 0, n_seed = 0;
        while (in >> std::hex >> vram >> std::dec >> sec >> parent) {
            if (sec < static_funcs_by_section.size()) { static_funcs_by_section[sec].push_back(vram); n_seed++; }
            if (parent == "-") continue;
            auto it = context.functions_by_name.find(parent);
            if (it == context.functions_by_name.end()) continue;
            context.functions[it->second].dispatch_entry_vrams.insert(vram);
            static_dedup_entries.emplace(it->second, vram);
            n_entries++;
        }
        fmt::print("[static-dedup] seeded {} statics, {} become dispatch entries\\n", n_seed, n_entries);
    }
''')
rep('''        if (N64Recomp::recompile_function(context, fidx, buf, static_funcs_by_section, false)) {
            current_output_file << buf.str();
            return;''', '''        if (N64Recomp::recompile_function(context, fidx, buf, static_funcs_by_section, false)) {
            if (!static_dedup_discover) {
                current_output_file << buf.str();
            }
            return;''')
rep('''    for (size_t section_index = 0; section_index < context.sections.size(); section_index++) {
        auto& section = context.sections[section_index];
        auto& section_funcs = section.function_addrs;
        const uint32_t section_encoded_vram =
            infer_section_encoded_vram_base(context, section_index);
''', '''    const size_t num_real_functions = context.functions.size();
    for (size_t section_index = 0; section_index < context.sections.size(); section_index++) {
        auto& section = context.sections[section_index];
        auto& section_funcs = section.function_addrs;
        const uint32_t section_encoded_vram =
            infer_section_encoded_vram_base(context, section_index);
''')
rep('''            size_t containing_func_index = find_containing_function_in_section(context, static_func_addr, section_index);

            if (containing_func_index != (size_t)-1) {''', '''            size_t containing_func_index = find_containing_function_in_section(context, static_func_addr, section_index);

            if (static_entries_env) {
                const bool in_real = containing_func_index != (size_t)-1 && containing_func_index < num_real_functions &&
                    !context.functions[containing_func_index].ignored;
                if (static_dedup_discover) {
                    static_dedup_record.emplace_back(static_func_addr, section_index,
                        in_real ? context.functions[containing_func_index].name : std::string("-"));
                }
                if (static_dedup_apply && in_real && static_dedup_entries.contains({ containing_func_index, static_func_addr })) {
                    std::string wrapper_name = fmt::format("static_{}_{:08X}", section_index, static_func_addr);
                    declare_function(wrapper_name);
                    fmt::print(current_output_file,
                        "RECOMP_FUNC void {}(uint8_t* rdram, recomp_context* ctx) {{\\n"
                        "    uint32_t recomp_prev_dispatch_entry = ctx->dispatch_entry_target;\\n"
                        "    ctx->dispatch_entry_target = 0x{:08X}u;\\n"
                        "    {}(rdram, ctx);\\n"
                        "    ctx->dispatch_entry_target = recomp_prev_dispatch_entry;\\n"
                        "}}\\n",
                        wrapper_name, static_func_addr, context.functions[containing_func_index].name);
                    if (!config.single_file_output) {
                        cur_file_function_count++;
                        if (cur_file_function_count >= config.functions_per_output_file) {
                            open_new_output_file();
                        }
                    }
                    continue;
                }
            }

            if (containing_func_index != (size_t)-1) {''')
rep('''    if (!context.dispatch_aliases.empty()) {
        for (const N64Recomp::DispatchAlias& alias : context.dispatch_aliases) {''', '''    if (static_dedup_discover) {
        std::ofstream out{ static_entries_path };
        for (const auto& [vram, sec, parent] : static_dedup_record) {
            out << std::hex << vram << std::dec << ' ' << sec << ' ' << parent << '\\n';
        }
        fmt::print("[static-dedup] discovery wrote {} statics to {}; run again to generate\\n",
            static_dedup_record.size(), static_entries_path.string());
        return EXIT_SUCCESS;
    }

    if (!context.dispatch_aliases.empty()) {
        for (const N64Recomp::DispatchAlias& alias : context.dispatch_aliases) {''')
if '#include <fstream>' not in s: s = s.replace('#include <sstream>', '#include <sstream>\n#include <fstream>\n#include <tuple>', 1)
open(p, 'w').write(s); print('applied')
