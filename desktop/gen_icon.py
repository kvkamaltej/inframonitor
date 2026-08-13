"""Generate the Infra Monitor app icon (desktop/inframonitor.ico).

A clean, brand-relevant mark: a stacked server rack with status LEDs (the top one green for
"healthy") on the app's teal, in a rounded square. Drawn large and downscaled so it stays
crisp from 256px down to the 16px taskbar size.

Run:  python desktop/gen_icon.py    (needs Pillow — build-time only; the .ico is committed)
"""

from pathlib import Path

from PIL import Image, ImageDraw

SS = 1024  # supersampled master; downscaled to the ICO sizes below
HERE = Path(__file__).resolve().parent

TEAL_TOP = (45, 212, 191)   # #2dd4bf
TEAL_BOT = (13, 148, 136)   # #0d9488
TEAL_DEEP = (15, 118, 110)  # #0f766e
GREEN = (34, 197, 94)       # #22c55e — "healthy" LED
WHITE = (255, 255, 255)


def _lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def build(size: int = SS) -> Image.Image:
    # Vertical teal gradient, clipped to a rounded square.
    gradient = Image.new("RGB", (size, size))
    gd = ImageDraw.Draw(gradient)
    for y in range(size):
        gd.line([(0, y), (size, y)], fill=_lerp(TEAL_TOP, TEAL_BOT, y / size))

    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), _rounded_mask(size, int(size * 0.22)))

    draw = ImageDraw.Draw(icon)

    # Three stacked "server" units, vertically centred.
    x0, x1 = int(size * 0.24), int(size * 0.76)
    bar_h = int(size * 0.155)
    gap = int(size * 0.052)
    total = 3 * bar_h + 2 * gap
    top = (size - total) // 2

    for i in range(3):
        y0 = top + i * (bar_h + gap)
        y1 = y0 + bar_h
        draw.rounded_rectangle([x0, y0, x1, y1], radius=int(bar_h * 0.30), fill=WHITE)

        cy = (y0 + y1) // 2
        # Status LED on the left — top server "healthy" green, the rest teal.
        led = GREEN if i == 0 else TEAL_DEEP
        r = int(bar_h * 0.17)
        cx = x0 + int(bar_h * 0.62)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=led)

        # Two vent slots on the right, in teal.
        slot_w, slot_h = int(bar_h * 1.15), int(bar_h * 0.12)
        sx1 = x1 - int(bar_h * 0.5)
        sx0 = sx1 - slot_w
        for k in (-1, 1):
            sy = cy + k * int(bar_h * 0.22)
            draw.rounded_rectangle(
                [sx0, sy - slot_h // 2, sx1, sy + slot_h // 2],
                radius=slot_h // 2,
                fill=TEAL_DEEP,
            )

    return icon


def main() -> None:
    master = build(SS)
    # Preview PNG (256) for eyeballing; not shipped.
    master.resize((256, 256), Image.LANCZOS).save(HERE / "inframonitor-preview.png")
    # Multi-resolution .ico. Pillow downsamples each size from the master.
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(HERE / "inframonitor.ico", format="ICO", sizes=ico_sizes)
    print(f"wrote {HERE / 'inframonitor.ico'} and preview PNG")


if __name__ == "__main__":
    main()
