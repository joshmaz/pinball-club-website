"""Offline tests: dummy data and subprocess protocol; never loads live credentials."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch
from client import FourthwallError
from mcp_server import call_tool, InvalidParams


class MCPTests(unittest.TestCase):
    def test_invalid_arguments_never_load_credentials(self):
        with patch('mcp_server.FourthwallClient') as factory:
            for params in ({'name': 'delete_product'},
                           {'name': 'fourthwall_shop', 'arguments': {'url': 'https://example.com'}},
                           {'name': 'fourthwall_products', 'arguments': {'size': True}},
                           {'name': 'fourthwall_product', 'arguments': {'product_id': '../shops/current'}}):
                with self.assertRaises(InvalidParams):
                    call_tool(params)
            factory.assert_not_called()

    def test_wrong_shop_stops_catalog(self):
        with patch('mcp_server.FourthwallClient') as factory:
            factory.return_value.shop.return_value = {'publicDomain': 'other.example'}
            result = call_tool({'name': 'fourthwall_products'})
            self.assertTrue(result['isError'])
            factory.return_value.products.assert_not_called()

    def test_selected_fields_only(self):
        with patch('mcp_server.FourthwallClient') as factory:
            client = factory.return_value
            client.shop.return_value = {'publicDomain': 'shop.snhpinballclub.com', 'email': 'private'}
            client.products.return_value = {'results': [{'id': 'p1', 'name': 'Tee', 'state': {'type': 'AVAILABLE'}, 'access': {'type': 'HIDDEN'}, 'secret': 'private'}]}
            result = call_tool({'name': 'fourthwall_products'})
            self.assertFalse(result['isError'])
            row = json.loads(result['content'][0]['text'])['results'][0]
            self.assertEqual(row['state'], 'AVAILABLE')
            self.assertEqual(row['access'], 'HIDDEN')
            self.assertNotIn('private', json.dumps(result))

    def test_unexpected_errors_sanitized(self):
        with patch('mcp_server.FourthwallClient', side_effect=RuntimeError('secret-test-only')):
            result = call_tool({'name': 'fourthwall_shop'})
            self.assertTrue(result['isError'])
            self.assertNotIn('secret-test-only', json.dumps(result))

    def test_stdio_handshake_discovery_and_rejection(self):
        messages = [
            {'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'test', 'version': '1'}}},
            {'method': 'notifications/initialized'},
            {'id': 2, 'method': 'tools/list'},
            {'id': 3, 'method': 'tools/call', 'params': {'name': 'fourthwall_products', 'arguments': {'size': 101}}},
            {'id': 4, 'method': 'delete_product'},
            {'id': 5, 'method': 'ping'}]
        wire = '\n'.join(json.dumps({'jsonrpc': '2.0', **item}) for item in messages) + '\n'
        run = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('mcp_server.py'))], input=wire, text=True, capture_output=True, timeout=5)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stderr, '')
        replies = [json.loads(line) for line in run.stdout.splitlines()]
        self.assertEqual(len(replies), 5)
        self.assertEqual(len(replies[1]['result']['tools']), 3)
        self.assertTrue(all(t['annotations']['readOnlyHint'] for t in replies[1]['result']['tools']))
        self.assertEqual(replies[2]['error']['code'], -32602)
        self.assertEqual(replies[3]['error']['code'], -32601)
        self.assertEqual(replies[4]['result'], {})
