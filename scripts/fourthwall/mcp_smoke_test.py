"""Explicit live read-only MCP test. Never prints raw protocol, errors, or headers."""
import json
from pathlib import Path
import selectors
import subprocess
import sys


def main():
    process = subprocess.Popen([sys.executable, '-B', str(Path(__file__).with_name('mcp_server.py'))],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    def send(message):
        process.stdin.write(json.dumps({'jsonrpc': '2.0', **message}) + '\n')
        process.stdin.flush()
    def request(ident, method, params=None):
        send({'id': ident, 'method': method, 'params': params or {}})
        if not selector.select(75):
            raise RuntimeError()
        response = json.loads(process.stdout.readline())
        if response.get('id') != ident or 'error' in response:
            raise RuntimeError()
        result = response['result']
        if result.get('isError'):
            raise RuntimeError()
        return result
    def call(ident, name, arguments=None):
        result = request(ident, 'tools/call', {'name': name, 'arguments': arguments or {}})
        return json.loads(result['content'][0]['text'])
    try:
        request(1, 'initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'snhpc-smoke-test', 'version': '1'}})
        send({'method': 'notifications/initialized'})
        tools = request(2, 'tools/list')['tools']
        assert {t['name'] for t in tools} == {'fourthwall_shop', 'fourthwall_products', 'fourthwall_product'}
        shop = call(3, 'fourthwall_shop')
        catalog = call(4, 'fourthwall_products', {'page': 0, 'size': 100})
        rows = catalog['results']
        assert rows
        detail = call(5, 'fourthwall_product', {'product_id': rows[0]['id']})
        assert detail['id'] == rows[0]['id']
        print(json.dumps({'mcp': 'ok', 'tools': len(tools), 'shop': shop['name'], 'status': shop['status'],
                          'pageProductCount': len(rows), 'products': [{'name': r['name'], 'state': r['state'], 'access': r['access']} for r in rows], 'productDetail': 'ok'}, indent=2))
    finally:
        selector.close()
        process.stdin.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdout.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('MCP smoke test failed (details suppressed)', file=sys.stderr)
        sys.exit(1)
