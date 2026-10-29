"""Рендер обложек, инфографики, титров и надписей по шаблонам из config/templates.yaml (Pillow).

Рендер детерминирован: одинаковые поля, бренд и шаблон дают одинаковый PNG. Параметры рендера
сохраняются в media_assets.render_params и позволяют воспроизвести файл.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageFont, ImageOps

from app.settings.channel import BrandConfig


class TemplateError(ValueError):
    pass


@dataclass(slots=True)
class RenderResult:
    png: bytes
    width: int
    height: int
    warnings: list[str] = field(default_factory=list)


@lru_cache
def load_templates(path: str) -> dict[str, Any]:
    with Path(path).open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    return data.get("templates", {})


@lru_cache(maxsize=128)
def _font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size=size)
    except OSError as exc:
        raise TemplateError(f"шрифт не загружается: {path}") from exc


def _color(value: str, brand: BrandConfig) -> tuple[int, int, int]:
    if value.startswith("brand."):
        value = getattr(brand.colors, value.split(".", 1)[1])
    return ImageColor.getrgb(value)[:3]


def _box(box: list[float], w: int, h: int) -> tuple[int, int, int, int]:
    x, y, bw, bh = box
    return int(x * w), int(y * h), int(bw * w), int(bh * h)


def _wrap(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    lines: list[str] = []
    # Тире и короткие предлоги не отрываются от соседнего слова.
    text = re.sub(r" ([—–-]) ", "\u00a0\\1 ", text)
    text = re.sub(r"(?:(?<=\s)|^)([вксоуиа]|во|на|за|по|до|из|от) ", "\\1\u00a0", text, flags=re.IGNORECASE)
    for paragraph in text.split("\n"):
        words = [w for w in paragraph.split(" ") if w]
        if not words:
            lines.append("")
            continue
        line = words[0]
        for word in words[1:]:
            candidate = f"{line} {word}"
            if font.getlength(candidate) <= max_width:
                line = candidate
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def _fit(
    text: str, font_path: str, size_range: list[int], width: int, height: int, spacing: float = 1.18
) -> tuple[ImageFont.FreeTypeFont, list[str], int, bool]:
    max_size, min_size = size_range[0], size_range[-1]
    size = max_size
    while size >= min_size:
        font = _font(font_path, size)
        lines = _wrap(text, font, width)
        line_h = int(size * spacing)
        widest = max((font.getlength(ln) for ln in lines), default=0)
        if line_h * len(lines) <= height and widest <= width:
            return font, lines, line_h, True
        size -= 2
    font = _font(font_path, min_size)
    lines = _wrap(text, font, width)
    line_h = int(min_size * spacing)
    max_lines = max(height // line_h, 1)
    fits = len(lines) <= max_lines
    if not fits:
        lines = lines[:max_lines]
        lines[-1] = lines[-1].rstrip(" .,;") + "…"
    return font, lines, line_h, fits


class TemplateRenderer:
    def __init__(
        self,
        templates_path: Path,
        brand: BrandConfig,
        *,
        logo_bytes: bytes | None = None,
        font_paths: dict[str, str] | None = None,
    ):
        self.templates = load_templates(str(templates_path))
        self.brand = brand
        self.logo = Image.open(io.BytesIO(logo_bytes)).convert("RGBA") if logo_bytes else None
        self.fonts = font_paths or {"regular": brand.fonts.regular, "bold": brand.fonts.bold}

    def template_ids(self) -> list[str]:
        return sorted(self.templates)

    def render(
        self,
        template_id: str,
        fields: dict[str, Any],
        *,
        images: dict[str, bytes] | None = None,
        size: tuple[int, int] | None = None,
        synthetic: bool = False,
    ) -> RenderResult:
        spec = self.templates.get(template_id)
        if spec is None:
            raise TemplateError(f"нет шаблона {template_id}")
        w, h = size or tuple(spec["size"])
        transparent = bool(spec.get("transparent"))
        canvas = Image.new(
            "RGBA",
            (w, h),
            (0, 0, 0, 0) if transparent else (*_color(self.brand.colors.background, self.brand), 255),
        )
        draw = ImageDraw.Draw(canvas)
        warnings: list[str] = []
        images = images or {}
        for el in spec["elements"]:
            kind = el["type"]
            if el.get("when_missing") and images.get(el["when_missing"]):
                continue
            if kind == "fill":
                draw.rectangle([0, 0, w, h], fill=_color(el["color"], self.brand))
            elif kind == "gradient":
                canvas.alpha_composite(self._gradient(w, h, el))
                draw = ImageDraw.Draw(canvas)
            elif kind == "rect":
                x, y, bw, bh = _box(el["box"], w, h)
                draw.rectangle([x, y, x + bw, y + bh], fill=_color(el["color"], self.brand))
            elif kind == "image":
                data = images.get(el["field"])
                if not data:
                    if el.get("optional"):
                        continue
                    raise TemplateError(f"шаблону {template_id} нужно изображение «{el['field']}»")
                x, y, bw, bh = _box(el["box"], w, h)
                img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGBA")
                img = ImageOps.fit(img, (bw, bh), method=Image.Resampling.LANCZOS)
                canvas.alpha_composite(img, (x, y))
            elif kind == "shade":
                canvas.alpha_composite(self._shade(w, h, el))
                draw = ImageDraw.Draw(canvas)
            elif kind == "logo":
                self._logo(canvas, el, w, h)
            elif kind in {"text", "text_box"}:
                text = str(fields.get(el["field"]) or "").strip()
                if not text:
                    continue
                if not self._text(canvas, el, text, w, h, boxed=kind == "text_box"):
                    warnings.append(f"текст «{el['field']}» не поместился и сокращён")
                draw = ImageDraw.Draw(canvas)
            elif kind == "numbered_list":
                points = [str(p).strip() for p in fields.get(el["field"]) or [] if str(p).strip()]
                if points and not self._numbered(draw, el, points, w, h):
                    warnings.append("пункты инфографики не поместились и сокращены")
            elif kind == "route_line":
                points = [str(p).strip() for p in fields.get(el["field"]) or [] if str(p).strip()]
                if len(points) >= 2:
                    self._route(draw, el, points, w, h)
                else:
                    warnings.append("для маршрута нужно минимум две точки")
            elif kind == "disclosure":
                if synthetic and self.brand.synthetic_disclosure:
                    self._text(
                        canvas,
                        {**el, "valign": "top"},
                        self.brand.synthetic_disclosure,
                        w,
                        h,
                        boxed=True,
                        opacity=0.55,
                        background="#000000",
                    )
                    draw = ImageDraw.Draw(canvas)
            else:
                raise TemplateError(f"неизвестный элемент шаблона: {kind}")
        out = io.BytesIO()
        (canvas if transparent else canvas.convert("RGB")).save(out, format="PNG", optimize=True)
        return RenderResult(png=out.getvalue(), width=w, height=h, warnings=warnings)

    def _gradient(self, w: int, h: int, el: dict[str, Any]) -> Image.Image:
        a, b = _color(el["from"], self.brand), _color(el["to"], self.brand)
        direction = el.get("direction", "vertical")
        vertical = Image.linear_gradient("L").resize((w, h))
        if direction == "vertical":
            mask = vertical
        else:
            horizontal = (
                Image.linear_gradient("L")
                .rotate(90, expand=True)
                .transpose(Image.Transpose.FLIP_LEFT_RIGHT)
                .resize((w, h))
            )
            mask = (
                horizontal if direction == "horizontal" else ImageChops.add(horizontal, vertical, scale=2.0)
            )
        return Image.composite(
            Image.new("RGBA", (w, h), (*b, 255)), Image.new("RGBA", (w, h), (*a, 255)), mask
        )

    def _shade(self, w: int, h: int, el: dict[str, Any]) -> Image.Image:
        color = _color(el["color"], self.brand)
        start = int(el.get("from_y", 0.5) * h)
        o1, o2 = el.get("opacity", [0, 0.8])
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        span = max(h - start, 1)
        for y in range(start, h):
            t = (y - start) / span
            d.line([(0, y), (w, y)], fill=(*color, int(255 * (o1 + (o2 - o1) * t))))
        return layer

    def _logo(self, canvas: Image.Image, el: dict[str, Any], w: int, h: int) -> None:
        if self.logo is None:
            return
        x, y, bw, bh = _box(el["box"], w, h)
        logo = self.logo.copy()
        logo.thumbnail((bw, bh), Image.Resampling.LANCZOS)
        align = el.get("align", "left")
        lx = x + (bw - logo.width if align == "right" else (bw - logo.width) // 2 if align == "center" else 0)
        ly = y + (bh - logo.height) // 2
        canvas.alpha_composite(logo, (lx, ly))

    def _text(
        self,
        canvas: Image.Image,
        el: dict[str, Any],
        text: str,
        w: int,
        h: int,
        *,
        boxed: bool = False,
        opacity: float | None = None,
        background: str | None = None,
    ) -> bool:
        x, y, bw, bh = _box(el["box"], w, h)
        pad = int(min(bw, bh) * 0.08) if boxed else 0
        font, lines, line_h, fits = _fit(
            text, self.fonts[el.get("font", "regular")], el.get("size", [48, 24]), bw - 2 * pad, bh - 2 * pad
        )
        block_h = line_h * len(lines)
        valign = el.get("valign", "top")
        top = (
            y
            + pad
            + (
                0
                if valign == "top"
                else (bh - 2 * pad - block_h)
                if valign == "bottom"
                else (bh - 2 * pad - block_h) // 2
            )
        )
        align = el.get("align", "left")
        color = _color(el.get("color", "brand.text"), self.brand)
        if boxed:
            widest = int(max(font.getlength(ln) for ln in lines))
            bg = _color(background or el.get("background", "brand.secondary"), self.brand)
            alpha = int(255 * (opacity if opacity is not None else el.get("opacity", 0.8)))
            box_w = widest + 2 * pad
            bx = x if align == "left" else x + bw - box_w if align == "right" else x + (bw - box_w) // 2
            layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
            ImageDraw.Draw(layer).rounded_rectangle(
                [bx, top - pad, bx + box_w, top + block_h + pad // 2], radius=pad, fill=(*bg, alpha)
            )
            canvas.alpha_composite(layer)
        draw = ImageDraw.Draw(canvas)
        for i, line in enumerate(lines):
            lw = font.getlength(line)
            lx = x + pad if align == "left" else x + bw - pad - lw if align == "right" else x + (bw - lw) / 2
            draw.text((lx, top + i * line_h), line, font=font, fill=color)
        return fits

    def _numbered(
        self, draw: ImageDraw.ImageDraw, el: dict[str, Any], points: list[str], w: int, h: int
    ) -> bool:
        x, y, bw, bh = _box(el["box"], w, h)
        row_h = bh // len(points)
        badge = int(min(row_h * 0.6, bw * 0.1))
        all_fit = True
        for i, point in enumerate(points):
            ry = y + i * row_h
            cy = ry + row_h // 2
            draw.ellipse(
                [x, cy - badge // 2, x + badge, cy + badge // 2], fill=_color(el["badge"], self.brand)
            )
            num_font = _font(self.fonts["bold"], int(badge * 0.55))
            label = str(i + 1)
            draw.text(
                (x + badge / 2 - num_font.getlength(label) / 2, cy - badge * 0.36),
                label,
                font=num_font,
                fill=_color(el["badge_text"], self.brand),
            )
            tx = x + badge + int(badge * 0.4)
            font, lines, line_h, fits = _fit(
                point, self.fonts[el.get("font", "regular")], el["size"], bw - (tx - x), int(row_h * 0.92)
            )
            all_fit &= fits
            top = cy - line_h * len(lines) // 2
            for j, line in enumerate(lines):
                draw.text((tx, top + j * line_h), line, font=font, fill=_color(el["color"], self.brand))
        return all_fit

    def _route(
        self, draw: ImageDraw.ImageDraw, el: dict[str, Any], points: list[str], w: int, h: int
    ) -> None:
        x, y, bw, bh = _box(el["box"], w, h)
        line_color = _color(el["line"], self.brand)
        text_color = _color(el["color"], self.brand)
        lx = x + int(bw * 0.06)
        step = bh / (len(points) - 1)
        draw.line([(lx, y), (lx, y + bh)], fill=line_color, width=max(int(bw * 0.012), 4))
        for i, name in enumerate(points):
            cy = int(y + i * step)
            r = int(bw * (0.035 if i in (0, len(points) - 1) else 0.022))
            draw.ellipse([lx - r, cy - r, lx + r, cy + r], fill=line_color, outline=text_color, width=3)
            font, lines, line_h, _ = _fit(
                name,
                self.fonts[el.get("font", "bold")],
                el["size"],
                int(bw * 0.8),
                int(step * 0.9) if len(points) > 1 else bh,
            )
            for j, line in enumerate(lines[:2]):
                draw.text(
                    (lx + int(bw * 0.08), cy - line_h // 2 + j * line_h), line, font=font, fill=text_color
                )
