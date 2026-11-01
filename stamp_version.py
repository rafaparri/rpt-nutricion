"""Pone un número de versión nuevo antes de publicar (index.html y version.json).
Uso: python3 stamp_version.py"""
import re, json, time, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
V = time.strftime('%Y%m%d%H%M%S')
s = open('index.html', encoding='utf-8').read()
s = re.sub(r"window\.RPT_VERSION='[^']*'", "window.RPT_VERSION='%s'" % V, s)
s = re.sub(r'(src="app\.js)(\?v=[^"]*)?"', r'\1?v=%s"' % V, s)
s = re.sub(r'(href="app\.css)(\?v=[^"]*)?"', r'\1?v=%s"' % V, s)
open('index.html', 'w', encoding='utf-8').write(s)
json.dump({'v': V}, open('version.json', 'w'))
print('Versión', V)
