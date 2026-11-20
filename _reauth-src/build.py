# Rebuilds reauth/index.html from _reauth-src/index.template.html and the Word template.
# Run from the repository folder:  python3 _reauth-src/build.py
import base64, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = root / '_reauth-src'
html = (src / 'index.template.html').read_text(encoding='utf-8')
b64 = base64.b64encode((src / 'ReAuth_Request_Template.docx').read_bytes()).decode()
(root / 'reauth' / 'index.html').write_text(html.replace('__TEMPLATE_B64__', b64), encoding='utf-8')
print('reauth/index.html rebuilt')
