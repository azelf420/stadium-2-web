# Builds the published page from the built one: points game.wasm and game.data at the asset host (so the game's code
# is not in the site repository) and adds the retro side panel (ports/stadium2/site/retro.html).
#   python3 tools/make_site.py <built game.html> <out index.html> <asset base URL ending in />
import pathlib
import re
import sys

src, dst, base = sys.argv[1:4]
page = open(src).read()
panel = (pathlib.Path(__file__).resolve().parent.parent / 'ports/stadium2/site/retro.html').read_text()
style = re.search(r'<!--STYLE-->(.*)<!--/STYLE-->', panel, re.S).group(1)
body = re.search(r'<!--PANEL-->(.*)<!--/PANEL-->', panel, re.S).group(1)

def once(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)

page = once(page, 'var Module={', "var Module={locateFile:p=>/\\.(wasm|data)$/.test(p)?'" + base + "'+p:p,")
page = once(page, '</head>', style + '</head>')
page = once(page, '<body>', '<body>' + body)
open(dst, 'w').write(page)
print('site page written:', dst)
