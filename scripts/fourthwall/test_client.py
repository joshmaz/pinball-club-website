"""Offline security checks using dummy credentials only."""
import unittest
from unittest.mock import patch
from pathlib import Path
import tempfile
from urllib.error import HTTPError
from client import FourthwallClient, FourthwallError, NoRedirect


class ClientTests(unittest.TestCase):
    def client(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials.env'
            path.write_text("FOURTHWALL_API_USERNAME=dummy\nFOURTHWALL_API_PASSWORD='test-only'\n")
            path.chmod(0o600)
            with patch("client.CREDENTIALS", path):
                return FourthwallClient()

    def test_fixed_destination_and_basic_auth(self):
        client = self.client()
        with patch.object(client._FourthwallClient__opener, "open") as request:
            request.return_value.__enter__.return_value.read.return_value = b'{}'
            client.products(page=2)
            req = request.call_args.args[0]
            self.assertEqual(req.full_url, 'https://api.fourthwall.com/open-api/v1.0/products?page=2&size=100')
            self.assertEqual(req.get_method(), 'GET')
            self.assertEqual(req.get_header('Authorization'), 'Basic ZHVtbXk6dGVzdC1vbmx5')

    def test_redirects_blocked(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example'))

    def test_error_does_not_echo_response_or_credentials(self):
        client = self.client()
        with patch.object(client._FourthwallClient__opener, "open", side_effect=HTTPError(
            'https://api.fourthwall.com', 401, 'sensitive-body', {}, None
        )):
            with self.assertRaisesRegex(FourthwallError, '^Fourthwall returned HTTP 401$'):
                client.shop()

    def test_bad_pagination_blocked_before_network(self):
        with self.assertRaises(ValueError):
            self.client().products(page='https://other.example')

    def test_unsafe_credential_permissions_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials.env'
            path.write_text('FOURTHWALL_API_USERNAME=dummy\nFOURTHWALL_API_PASSWORD=test\n')
            path.chmod(0o644)
            with patch('client.CREDENTIALS', path), self.assertRaises(FourthwallError):
                FourthwallClient()

    def test_symlink_credentials_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials.env'
            path.symlink_to('/dev/null')
            with patch('client.CREDENTIALS', path), self.assertRaises(FourthwallError):
                FourthwallClient()

    def test_product_id_cannot_change_route(self):
        for value in ('../shops/current', 'https://example.com', 'x?token=y', '', None):
            with self.assertRaises(ValueError):
                self.client().product(value)

    def test_response_size_limited(self):
        client = self.client()
        with patch.object(client._FourthwallClient__opener, 'open') as request:
            request.return_value.__enter__.return_value.read.return_value = b'x' * (4 * 1024 * 1024 + 1)
            with self.assertRaises(FourthwallError):
                client.shop()


if __name__ == '__main__':
    unittest.main()
