"""Make the Nginx error document self-contained from the shared maintenance UI."""

import base64
from pathlib import Path
import re


def standalone_maintenance_html(source_root: Path) -> str:
    page = (source_root / 'html/maintenance.html').read_text(encoding='utf-8')
    css = (source_root / 'css/maintenance.css').read_text(encoding='utf-8')
    mime_types = {'.webp': 'image/webp', '.png': 'image/png',
                  '.svg': 'image/svg+xml', '.woff2': 'font/woff2'}

    def embedded_url(path: str) -> str:
        asset = source_root / path.lstrip('/')
        encoded = base64.b64encode(asset.read_bytes()).decode('ascii')
        return f'data:{mime_types[asset.suffix]};base64,{encoded}'

    css = re.sub(r"url\(['\"]?(/assets/[^)'\"]+)['\"]?\)",
                 lambda match: f'url("{embedded_url(match[1])}")', css)
    page = page.replace('<link rel="stylesheet" href="/css/maintenance.css">',
                        f'<style>\n{css}\n</style>')
    page = re.sub(r'<script\b[^>]*>.*?</script>\s*', '', page, flags=re.DOTALL)
    page = re.sub(r'src="(/assets/[^\"]+)"',
                  lambda match: f'src="{embedded_url(match[1])}"', page)
    return page.replace('<!DOCTYPE html>',
                        '<!DOCTYPE html>\n<!-- Generated from html/maintenance.html and css/maintenance.css. -->', 1)
