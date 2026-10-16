# Stadium 2 N64Recomp fork: one local-tailcall dispatcher per function instead of a switch over every local label at
# every call site (calls x labels). Call sites jump to it with their site number; it takes a local tailcall to its
# label, or drains a non-local one and goes back to the site. Gated by N64RECOMP_SHARED_TC_DISPATCH=1 (else as before).
import sys
root = sys.argv[1]
g = root + '/include/recompiler/generator.h'; s = open(g).read()
if 'tc_sites' not in s:
    old = '        void emit_tailcall_handling(const std::set<uint32_t>& local_labels, uint32_t return_vram) const;\n'
    assert s.count(old) == 1
    s = s.replace(old, old + '''        // Shared local-tailcall dispatcher state for the function being emitted (N64RECOMP_SHARED_TC_DISPATCH).
        mutable size_t tc_sites = 0;
        mutable std::set<uint32_t> tc_local_labels;
''')
    open(g, 'w').write(s)
c = root + '/src/cgenerator.cpp'; s = open(c).read()
if 'N64RECOMP_SHARED_TC_DISPATCH' in s: print('already applied'); sys.exit()
def rep(old, new):
    global s
    assert s.count(old) == 1, (s.count(old), old[:70]); s = s.replace(old, new)
rep('''    void emit_call_prologue(std::ostream& output_file) {
        fmt::print(output_file, "{{\\n");
        fmt::print(output_file, "    gpr recomp_call_sp = ctx->r29;\\n");
        fmt::print(output_file, "    uint32_t recomp_prev_host_return = ctx->host_return_target;\\n");
        fmt::print(output_file, "    uint32_t recomp_call_host_return = (uint32_t)ctx->r31;\\n");''', '''    bool shared_tc_dispatch() {
        static const bool on = [] { const char* e = std::getenv("N64RECOMP_SHARED_TC_DISPATCH"); return e && e[0] == '1'; }();
        return on;
    }

    void emit_call_prologue(std::ostream& output_file) {
        fmt::print(output_file, "{{\\n");
        if (shared_tc_dispatch()) {
            // Function-scope (emit_function_start), so the shared dispatcher sees the current call site's values.
            fmt::print(output_file, "    recomp_call_sp = ctx->r29;\\n");
            fmt::print(output_file, "    recomp_prev_host_return = ctx->host_return_target;\\n");
            fmt::print(output_file, "    recomp_call_host_return = (uint32_t)ctx->r31;\\n");
        } else {
        fmt::print(output_file, "    gpr recomp_call_sp = ctx->r29;\\n");
        fmt::print(output_file, "    uint32_t recomp_prev_host_return = ctx->host_return_target;\\n");
        fmt::print(output_file, "    uint32_t recomp_call_host_return = (uint32_t)ctx->r31;\\n");
        }''')
rep('''        "    int c1cs = 0;\\n" // cop1 conditional signal''', '''        "    int c1cs = 0;\\n" // cop1 conditional signal
        "{}"''')
rep('''        "    RECOMP_FUNC_ENTRY({})\\n",
        function_name, function_name);
}''', '''        "    RECOMP_FUNC_ENTRY({})\\n",
        function_name,
        shared_tc_dispatch() ? "    gpr recomp_call_sp = 0; uint32_t recomp_prev_host_return = 0, recomp_call_host_return = 0, recomp_tc_site = 0;\\n" : "",
        function_name);
    tc_sites = 0;
    tc_local_labels.clear();
}''')
rep('''void N64Recomp::CGenerator::emit_function_end() const {
    fmt::print(output_file, ";}}\\n");
}''', '''void N64Recomp::CGenerator::emit_function_end() const {
    if (tc_sites != 0) {
        // The shared dispatcher: a local tailcall goes to its label, anything else is drained and resumes its site.
        fmt::print(output_file, ";\\nrecomp_tc_dispatch:\\n");
        fmt::print(output_file, "    switch ((uint32_t)ctx->tailcall_target) {{\\n");
        for (uint32_t label_vram : tc_local_labels) {
            fmt::print(output_file, "    case 0x{:08X}u:\\n", label_vram);
        }
        fmt::print(output_file,
            "    {{\\n"
            "        uint32_t recomp_tc_t = (uint32_t)ctx->tailcall_target;\\n"
            "        recomp_cf_note(\\"call-local-tailcall\\", (uint32_t)recomp_call_sp, recomp_prev_host_return, recomp_call_host_return, ctx);\\n"
            "        ctx->tailcall_pending = 0;\\n"
            "        ctx->tailcall_target = 0;\\n"
            "        ctx->tailcall_func = 0;\\n"
            "        ctx->host_return_target = recomp_prev_host_return;\\n"
            "        if (ctx->r29 != recomp_call_sp) {{ recomp_cf_note(\\"call-sp-mismatch\\", (uint32_t)recomp_call_sp, recomp_prev_host_return, recomp_call_host_return, ctx); return; }}\\n"
            "        switch (recomp_tc_t) {{\\n");
        for (uint32_t label_vram : tc_local_labels) {
            fmt::print(output_file, "        case 0x{:08X}u: goto L_{:08X};\\n", label_vram, label_vram);
        }
        fmt::print(output_file,
            "        }}\\n"
            "    }}\\n"
            "    default: break;\\n"
            "    }}\\n"
            "    if (ctx->tailcall_dispatching >= 64u) {{\\n"
            "        recomp_cf_note(\\"call-bubble-dispatch\\", (uint32_t)recomp_call_sp, recomp_prev_host_return, recomp_call_host_return, ctx);\\n"
            "        ctx->host_return_target = recomp_prev_host_return;\\n"
            "        return;\\n"
            "    }}\\n"
            "    recomp_handle_tailcalls(rdram, ctx);\\n"
            "    switch (recomp_tc_site) {{\\n");
        for (size_t site = 0; site < tc_sites; site++) {
            fmt::print(output_file, "    case {}: goto recomp_tc_resume_{};\\n", site, site);
        }
        fmt::print(output_file, "    }}\\n    return;\\n");
    }
    fmt::print(output_file, ";}}\\n");
}''')
rep('''    if (!local_labels.empty()) {
        fmt::print(output_file, "        if (ctx->tailcall_target != 0) {{\\n");''', '''    if (shared_tc_dispatch() && !local_labels.empty()) {
        // To the function's shared dispatcher (emit_function_end), which comes back to recomp_tc_resume_<site>.
        size_t site = tc_sites++;
        tc_local_labels.insert(local_labels.begin(), local_labels.end());
        fmt::print(output_file, "        recomp_tc_site = {}; goto recomp_tc_dispatch;\\n", site);
        fmt::print(output_file, "    }}\\n");
        fmt::print(output_file, "    recomp_tc_resume_{}:\\n", site);
        return;
    }
    if (!local_labels.empty()) {
        fmt::print(output_file, "        if (ctx->tailcall_target != 0) {{\\n");''')
if '#include <cstdlib>' not in s: s = '#include <cstdlib>\n' + s
open(c, 'w').write(s); print('applied')
