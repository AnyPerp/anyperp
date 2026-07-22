#!/usr/bin/env python3
"""Generate AnyPerp GitHub social / homepage assets (brand-safe, readable)."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "github"
OUT.mkdir(parents=True, exist_ok=True)

# Brand tokens (from app/globals.css) — tuned for long reading comfort
INK = (0, 0, 0)
INK_SOFT = (26, 26, 26)
MUTED = (106, 106, 106)
MUTED_STRONG = (61, 61, 61)
SURFACE = (255, 255, 255)
CANVAS = (244, 247, 244)
CANVAS_DEEP = (238, 242, 238)
LINE = (232, 235, 232)
GREEN = (0, 200, 5)           # brand mark / small accents only
GREEN_DEEP = (0, 150, 4)      # readable green on light
GREEN_SOFT = (230, 249, 231)
ORANGE = (255, 80, 0)         # middle logo bar only
# Soft dark surfaces (GitHub dark-mode friendly, not pure black)
DARK_BG = (11, 15, 12)
DARK_PANEL = (18, 24, 20)
DARK_LINE = (40, 52, 44)
TEXT_ON_DARK = (232, 240, 234)
MUTED_ON_DARK = (154, 171, 158)
GREEN_READABLE_DARK = (120, 210, 130)  # desaturated for body accents on dark


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def draw_logo_bars(draw: ImageDraw.ImageDraw, cx: int, cy: int, scale: float = 1.0) -> None:
    """Three-bar mark: short green, tall orange, mid green — matches public/logo/anyperp-logo.svg."""
    w = int(36 * scale)
    gap = int(14 * scale)
    r = max(4, int(9 * scale))
    # heights relative to logo SVG proportions
    h1, h2, h3 = int(82 * scale), int(192 * scale), int(138 * scale)
    total_w = 3 * w + 2 * gap
    x0 = cx - total_w // 2
    # bar 1 bottom-aligned
    y_base = cy + h2 // 2
    bars = [
        (x0, y_base - h1, w, h1, GREEN),
        (x0 + w + gap, y_base - h2, w, h2, ORANGE),
        (x0 + 2 * (w + gap), y_base - h3, w, h3, GREEN_DEEP),
    ]
    for x, y, bw, bh, color in bars:
        draw.rounded_rectangle([x, y, x + bw, y + bh], radius=r, fill=color)


def rounded_rect(draw: ImageDraw.ImageDraw, box, radius: int, fill, outline=None, width: int = 1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def social_preview() -> Path:
    """1280x640 — GitHub social preview / Open Graph."""
    W, H = 1280, 640
    img = Image.new("RGB", (W, H), DARK_BG)
    draw = ImageDraw.Draw(img)

    # Soft vignette panels (subtle, not neon)
    rounded_rect(draw, (40, 40, W - 40, H - 40), 28, DARK_PANEL, DARK_LINE, 2)

    # Left accent rail (brand green, low visual weight)
    draw.rectangle([40, 40, 48, H - 40], fill=GREEN_DEEP)

    # Logo
    draw_logo_bars(draw, 160, 200, scale=1.15)

    # Wordmark + tagline
    draw.text((280, 130), "AnyPerp", font=font(64, True), fill=TEXT_ON_DARK)
    draw.text((280, 210), "Any token. A perp. Today.", font=font(28), fill=GREEN_READABLE_DARK)

    # Subcopy — readable muted, not bright
    lines = [
        "Permissionless isolated perpetual markets on Robinhood Chain.",
        "Open factory. Local risk. Oracle-gated activation.",
    ]
    y = 270
    for line in lines:
        draw.text((280, y), line, font=font(22), fill=MUTED_ON_DARK)
        y += 34

    # Feature chips
    chips = ["Isolated markets", "Oracle-priced", "Testnet prototype", "MIT open source"]
    x = 280
    y = 370
    for chip in chips:
        tw = draw.textlength(chip, font=font(16))
        pad_x, pad_y = 16, 10
        box = [x, y, x + tw + pad_x * 2, y + 32]
        rounded_rect(draw, box, 16, (24, 36, 28), DARK_LINE, 1)
        draw.text((x + pad_x, y + 7), chip, font=font(16), fill=TEXT_ON_DARK)
        x += int(tw + pad_x * 2 + 12)

    # Footer meta
    draw.line([(80, 500), (W - 80, 500)], fill=DARK_LINE, width=1)
    draw.text((80, 530), "anyperp.fun", font=font(20, True), fill=TEXT_ON_DARK)
    draw.text((80, 562), "github.com/AnyPerp/anyperp  ·  Unaudited testnet — not for real funds", font=font(16), fill=MUTED_ON_DARK)
    draw.text((W - 320, 545), "v0.1.0-testnet", font=font(18), fill=MUTED_ON_DARK)

    path = OUT / "github-social-preview.png"
    img.save(path, "PNG", optimize=True)
    return path


def org_banner() -> Path:
    """1500x500-ish wide org header style (also works as README hero)."""
    W, H = 1500, 500
    img = Image.new("RGB", (W, H), CANVAS)
    draw = ImageDraw.Draw(img)

    # Soft white card
    rounded_rect(draw, (32, 32, W - 32, H - 32), 24, SURFACE, LINE, 2)
    # Green soft strip top
    draw.rectangle([32, 32, W - 32, 40], fill=GREEN)

    draw_logo_bars(draw, 140, 230, scale=1.0)

    draw.text((240, 140), "AnyPerp", font=font(56, True), fill=INK)
    draw.text((240, 212), "Any token. A perp. Today.", font=font(26), fill=GREEN_DEEP)
    draw.text(
        (240, 270),
        "Isolated permissionless perpetuals on Robinhood Chain — open source testnet prototype.",
        font=font(20),
        fill=MUTED_STRONG,
    )

    # Bottom meta bar
    rounded_rect(draw, (240, 340, 1100, 400), 12, GREEN_SOFT, None)
    draw.text((260, 358), "Site  anyperp.fun   ·   Org  github.com/AnyPerp   ·   License  MIT", font=font(18), fill=INK_SOFT)

    path = OUT / "github-org-banner.png"
    img.save(path, "PNG", optimize=True)
    return path


def light_og() -> Path:
    """Light variant for sites that prefer light cards (1200x630)."""
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), CANVAS)
    draw = ImageDraw.Draw(img)
    rounded_rect(draw, (36, 36, W - 36, H - 36), 28, SURFACE, LINE, 2)
    draw.rectangle([36, 36, 44, H - 36], fill=GREEN)

    draw_logo_bars(draw, 150, 220, scale=1.1)
    draw.text((270, 150), "AnyPerp", font=font(58, True), fill=INK)
    draw.text((270, 225), "Any token. A perp. Today.", font=font(26), fill=GREEN_DEEP)

    body = [
        "Factory for isolated, oracle-priced perpetual markets.",
        "Permissionless creation. Mechanical admission. Local risk.",
    ]
    y = 290
    for line in body:
        draw.text((270, y), line, font=font(22), fill=MUTED_STRONG)
        y += 36

    chips = ["Solidity", "TypeScript", "Python sims", "Robinhood Chain"]
    x = 270
    for chip in chips:
        tw = draw.textlength(chip, font=font(16))
        box = [x, 420, x + tw + 28, 456]
        rounded_rect(draw, box, 14, GREEN_SOFT, (184, 240, 186), 1)
        draw.text((x + 14, 428), chip, font=font(16), fill=INK_SOFT)
        x += int(tw + 40)

    draw.text((270, 520), "anyperp.fun  ·  github.com/AnyPerp/anyperp", font=font(18), fill=MUTED)

    path = OUT / "github-og-light.png"
    img.save(path, "PNG", optimize=True)
    return path


def main() -> None:
    paths = [social_preview(), org_banner(), light_og()]
    for p in paths:
        print(f"{p}  ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
