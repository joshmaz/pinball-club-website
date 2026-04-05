import os
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from urllib.request import urlopen, Request
from collections import deque

START_URL = "https://snhpinball.wixsite.com/home"
BASE_DOMAIN = urlparse(START_URL).netloc

output_dir = "images"
os.makedirs(output_dir, exist_ok=True)

visited_pages = set()
image_urls = set()

class SiteParser(HTMLParser):
    def __init__(self, base_url):
        super().__init__()
        self.base_url = base_url
        self.links = set()
        self.images = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)

        # Extract links
        if tag == "a":
            href = attrs.get("href")
            if href:
                full_url = urljoin(self.base_url, href)
                self.links.add(full_url)

        # Extract images
        if tag == "img":
            src = attrs.get("src")
            if src:
                self.images.add(urljoin(self.base_url, src))

        # Extract background images
        style = attrs.get("style")
        if style and "url(" in style:
            start = style.find("url(") + 4
            end = style.find(")", start)
            if end != -1:
                img_url = style[start:end].strip('"\'')
                self.images.add(urljoin(self.base_url, img_url))


def fetch_page(url):
    try:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except:
        print(f"Failed to fetch page: {url}")
        return ""


def is_valid_page(url):
    parsed = urlparse(url)
    return (
        parsed.netloc == BASE_DOMAIN
        and not parsed.path.endswith((".jpg", ".png", ".webp", ".gif", ".pdf"))
    )

def get_full_res_wix_url(url):
    if "static.wixstatic.com/media/" not in url:
        return url

    try:
        parts = url.split("/media/")
        base = parts[0] + "/media/"
        remainder = parts[1]

        # Extract the media ID (first segment)
        media_id = remainder.split("/")[0]

        return base + media_id
    except:
        return url

# BFS crawl
queue = deque([START_URL])

while queue:
    current_url = queue.popleft()

    if current_url in visited_pages:
        continue

    print(f"Crawling: {current_url}")
    visited_pages.add(current_url)

    html = fetch_page(current_url)
    if not html:
        continue

    parser = SiteParser(current_url)
    parser.feed(html)

    # Collect images
    image_urls.update(parser.images)

    # Queue new pages
    for link in parser.links:
        if is_valid_page(link) and link not in visited_pages:
            queue.append(link)


print(f"\nTotal pages visited: {len(visited_pages)}")
print(f"Total images found: {len(image_urls)}")


# Download images
for i, img_url in enumerate(image_urls):
    full_url = get_full_res_wix_url(img_url)

    try:
        req = Request(full_url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req) as resp:
            img_data = resp.read()

        ext = os.path.splitext(full_url.split("?")[0])[1]
        if not ext:
            ext = ".jpg"

        filename = os.path.join(output_dir, f"image_{i}{ext}")

        with open(filename, "wb") as f:
            f.write(img_data)

        print(f"Saved FULL RES {filename}")
    except:
        print(f"Full-res failed, falling back: {img_url}")

        # fallback to original URL
        try:
            req = Request(img_url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req) as resp:
                img_data = resp.read()

            filename = os.path.join(output_dir, f"image_{i}.jpg")
            with open(filename, "wb") as f:
                f.write(img_data)

            print(f"Saved fallback {filename}")
        except:
            print(f"Failed completely: {img_url}")