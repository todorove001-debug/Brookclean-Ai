"""Рисует иконки PWA (автовоз на тёмно-синем фоне). Запуск: python3 web/scripts/make-icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
NAVY, AMBER, INK = (20, 32, 46), (242, 169, 0), (27, 20, 0)


def draw(size: int, pad: float) -> Image.Image:
    s = 4 * size  # рисуем крупно и уменьшаем — сглаживание
    img = Image.new("RGB", (s, s), NAVY)
    d = ImageDraw.Draw(img)
    u = s * (1 - 2 * pad) / 24  # сетка 24×24 внутри безопасной зоны
    ox = oy = s * pad

    def P(x, y):
        return (ox + x * u, oy + y * u)

    # платформа автовоза с машиной
    d.rounded_rectangle([P(2, 6.5), P(14.5, 15)], radius=u * 1.2, fill=AMBER)
    d.polygon([P(4, 9.5), P(6, 7.5), P(10, 7.5), P(12.5, 9.5)], fill=INK)
    # кабина
    d.polygon([P(15.5, 9), P(19.5, 9), P(22, 12), P(22, 15), P(15.5, 15)], fill=AMBER)
    d.polygon([P(16.8, 10.2), P(19, 10.2), P(20.6, 12.2), P(16.8, 12.2)], fill=NAVY)
    # колёса
    for cx in (5.5, 11, 19):
        d.ellipse([P(cx - 2, 13.5), P(cx + 2, 17.5)], fill=AMBER, outline=NAVY, width=int(u * 0.9))
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
draw(192, 0.08).save(OUT / "icon-192.png")
draw(512, 0.08).save(OUT / "icon-512.png")
draw(512, 0.2).save(OUT / "maskable-512.png")  # Android обрезает края круглой маской
draw(180, 0.1).save(OUT / "apple-touch-icon.png")
draw(32, 0.02).save(OUT / "favicon-32.png")
print("ok", OUT)
