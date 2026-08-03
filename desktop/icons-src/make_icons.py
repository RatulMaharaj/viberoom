"""Generate the Viberoom app icon set from the brand tile design.

Monochrome "Vr" tile: white Space Grotesk monogram on a pure black
rounded square. No border, no color — a nod to Lightroom's two-letter
monogram without borrowing Adobe's tile grammar.

    uv run --with pillow python desktop/icons-src/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
ROOT = HERE.parents[1]

BG = "#0a0a0a"        # near-black
INK = "#f5f5f5"       # paper white
FONT = HERE / "SpaceGrotesk-Bold.ttf"


def tile(size: int) -> Image.Image:
    s = size / 1024  # design at 1024, scale down
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(232 * s), fill=BG)

    font = ImageFont.truetype(str(FONT), int(560 * s))
    # optical centering: measure ink extents, not the em box
    box = d.textbbox((0, 0), "Vr", font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), "Vr", font=font, fill=INK)
    return img


def main() -> None:
    icons = ROOT / "desktop" / "src-tauri" / "icons"
    base = tile(1024)
    base.save(HERE / "icon.png")
    tile(32).save(icons / "32x32.png")
    tile(128).save(icons / "128x128.png")
    tile(256).save(icons / "128x128@2x.png")
    base.save(icons / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    base.save(icons / "icon.icns")
    print("icon set written")


if __name__ == "__main__":
    main()
