import os
from html.parser import HTMLParser
from urllib.parse import urljoin
from urllib.request import urlopen, Request

url = "https://snhpinball.wixsite.com/home"
output_dir = "images"
os.makedirs(output_dir, exist_ok=True)

class ImageURLParser(HTMLParser):
    def __init__(self, base_url):
        super().__init__()
        self.base_url = base_url
        self.img_urls = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "img":
            src = attrs.get("src")
            if src:
                self.img_urls.add(urljoin(self.base_url, src))
        style = attrs.get("style")
        if style and "url(" in style:
            start = style.find("url(") + 4
            end = style.find(")", start)
            if end != -1:
                img_url = style[start:end].strip('"\'')
                self.img_urls.add(urljoin(self.base_url, img_url))

    def handle_comment(self, data):
        pass

    def handle_data(self, data):
        pass

request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urlopen(request) as resp:
    html = resp.read().decode("utf-8", errors="ignore")

parser = ImageURLParser(url)
parser.feed(html)
img_urls = parser.img_urls

print(f"Found {len(img_urls)} images")

for i, img_url in enumerate(img_urls):
    try:
        request = Request(img_url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(request) as resp:
            img_data = resp.read()
        filename = os.path.join(output_dir, f"image_{i}.jpg")
        with open(filename, "wb") as f:
            f.write(img_data)
        print(f"Saved {filename}")
    except Exception:
        print(f"Failed: {img_url}")