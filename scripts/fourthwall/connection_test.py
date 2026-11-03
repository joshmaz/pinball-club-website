"""Read-only live connection test; print only selected shop/catalog fields."""
import json
import sys
from client import FourthwallClient, FourthwallError


def main():
    client = FourthwallClient()
    shop = client.shop()
    if shop.get("publicDomain", "").removeprefix("https://").rstrip("/") != "shop.snhpinballclub.com":
        raise FourthwallError("Unexpected shop domain; stopped before listing products")
    products = []
    page = 0
    while True:
        batch = client.products(page=page)
        rows = batch["results"]
        products.extend({key: row.get(key) for key in (
            "id", "name", "slug", "type", "state", "access"
        )} for row in rows)
        if not rows or page + 1 >= batch.get("totalPages", page + 2):
            break
        page += 1
        if page >= 100:
            raise FourthwallError("Pagination safety limit reached")
    print(json.dumps({"connection": "ok", "shop": {
        key: shop.get(key) for key in ("id", "name", "domain", "publicDomain", "status")
    }, "productCount": len(products), "products": products}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except FourthwallError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Connection test failed: unexpected response format", file=sys.stderr)
        sys.exit(1)
