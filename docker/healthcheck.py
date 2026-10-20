"""Docker HEALTHCHECK: healthy if the web server answers (a 401 counts - it just means a password is set)."""
import os
import sys
import urllib.error
import urllib.request

url = "http://127.0.0.1:%s/" % os.environ.get("ZC95_WEB_PORT", "8080")
try:
  urllib.request.urlopen(url, timeout=4)
except urllib.error.HTTPError as e:
  sys.exit(0 if e.code == 401 else 1)
except Exception:
  sys.exit(1)
sys.exit(0)
