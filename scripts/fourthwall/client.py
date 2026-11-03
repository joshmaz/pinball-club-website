"""Local-only Fourthwall client. Only explicitly allowed, read-only routes exist."""
import base64
import json
import os
import re
import stat
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://api.fourthwall.com/open-api/v1.0/"
CREDENTIALS = Path.home() / ".config/fourthwall/credentials.env"


class FourthwallError(Exception):
    """Sanitized failure, without headers, credentials, or response bodies."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class FourthwallClient:
    def __init__(self):
        try:
            values = {}
            # Open without following symlinks; check the actual descriptor before reading.
            fd = os.open(CREDENTIALS, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd) as stream:
                metadata = os.fstat(stream.fileno())
                if (not stat.S_ISREG(metadata.st_mode)
                        or metadata.st_uid != os.getuid()
                        or stat.S_IMODE(metadata.st_mode) & 0o077):
                    raise ValueError()
                source = stream.read(16385)
            if len(source) > 16384:
                raise ValueError()
            for line in source.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                key, value = line.removeprefix("export ").split("=", 1)
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[key.strip()] = value
            username = values["FOURTHWALL_API_USERNAME"]
            password = values["FOURTHWALL_API_PASSWORD"]
            if not username or not password or ":" in username:
                raise ValueError()
            self.__authorization = "Basic " + base64.b64encode(
                f"{username}:{password}".encode()
            ).decode("ascii")
        except (OSError, KeyError, ValueError, UnicodeError):
            raise FourthwallError("Cannot load valid local Fourthwall credentials") from None
        # Disable proxy environment variables and all redirects. TLS verification stays on.
        self.__opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect()
        )

    def __get(self, route, params=None):
        # No arbitrary URL, method, or endpoint input is exposed to callers.
        url = BASE_URL + route
        if params:
            url += "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(url, method="GET", headers={
            "Authorization": self.__authorization, "Accept": "application/json"
        })
        try:
            with self.__opener.open(request, timeout=30) as response:
                body = response.read(4 * 1024 * 1024 + 1)
                if len(body) > 4 * 1024 * 1024:
                    raise ValueError()
                result = json.loads(body)
                if not isinstance(result, dict):
                    raise ValueError()
                return result
        except urllib.error.HTTPError as error:
            error.close()
            raise FourthwallError(f"Fourthwall returned HTTP {error.code}") from None
        except Exception:
            raise FourthwallError("Fourthwall request failed (network or response error)") from None

    def shop(self):
        return self.__get("shops/current")

    def products(self, page=0, size=100):
        if type(page) is not int or page < 0 or type(size) is not int or not 1 <= size <= 100:
            raise ValueError("Invalid pagination")
        return self.__get("products", {"page": page, "size": size})

    def product(self, product_id):
        if not isinstance(product_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", product_id):
            raise ValueError("Invalid product ID")
        return self.__get("products/" + product_id)
