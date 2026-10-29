"""EDL — полное описание монтажа. Сохраняется вместе с результатом: по нему ролик собирается заново."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

ASPECT_SIZES: dict[str, tuple[int, int]] = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}


class MediaRef(BaseModel):
    asset_id: str
    storage_key: str
    sha256: str


class ClipSegment(BaseModel):
    type: Literal["clip"] = "clip"
    source: MediaRef
    start: float = Field(ge=0)
    end: float
    mute: bool = False
    scene_index: int | None = None
    label: str = ""

    @model_validator(mode="after")
    def _range(self) -> ClipSegment:
        if self.end - self.start < 0.3:
            raise ValueError("фрагмент короче 0,3 с")
        return self

    @property
    def duration(self) -> float:
        return round(self.end - self.start, 3)


class CardSegment(BaseModel):
    type: Literal["card"] = "card"
    template: str = "title_card"
    headline: str
    subline: str = ""
    duration_s: float = Field(2.5, gt=0.5, le=10)
    scene_index: int | None = None

    @property
    def duration(self) -> float:
        return self.duration_s


class OverlaySpec(BaseModel):
    text: str
    start: float = Field(ge=0)
    end: float


class SubtitleSegment(BaseModel):
    start: float = Field(ge=0)
    end: float
    text: str


class LogoSpec(BaseModel):
    position: Literal["top_left", "top_right", "bottom_left", "bottom_right"] = "top_right"
    width_ratio: float = Field(0.2, gt=0.02, le=0.5)
    opacity: float = Field(0.9, ge=0.1, le=1)
    margin_ratio: float = Field(0.04, ge=0, le=0.2)


class MusicSpec(BaseModel):
    source: MediaRef
    volume: float = Field(0.18, gt=0, le=1)
    duck: bool = True
    fade_out_s: float = Field(1.5, ge=0, le=10)


class OutputSpec(BaseModel):
    aspect: Literal["9:16", "16:9", "1:1"] = "9:16"
    fps: int = Field(30, ge=15, le=60)
    crf: int = Field(21, ge=14, le=32)
    preset: str = "medium"
    audio_bitrate: str = "160k"
    reframe: Literal["blur_pad", "crop", "fit"] = "blur_pad"
    max_bytes: int = 48 * 1024 * 1024

    @property
    def size(self) -> tuple[int, int]:
        return ASPECT_SIZES[self.aspect]


class LoudnessSpec(BaseModel):
    integrated: float = -16.0
    true_peak: float = -1.5
    lra: float = 20.0


class EDL(BaseModel):
    version: int = 1
    output: OutputSpec = Field(default_factory=OutputSpec)
    segments: list[Annotated[ClipSegment | CardSegment, Field(discriminator="type")]] = Field(
        default_factory=list
    )
    overlays: list[OverlaySpec] = Field(default_factory=list)
    subtitles: list[SubtitleSegment] = Field(default_factory=list)
    logo: LogoSpec | None = Field(default_factory=LogoSpec)
    music: MusicSpec | None = None
    loudness: LoudnessSpec = Field(default_factory=LoudnessSpec)
    title: str = ""
    brand_digest: str = ""

    @model_validator(mode="after")
    def _non_empty(self) -> EDL:
        if not self.segments:
            raise ValueError("в монтаже нет ни одного фрагмента")
        return self

    @property
    def duration(self) -> float:
        return round(sum(s.duration for s in self.segments), 3)

    def segment_offsets(self) -> list[float]:
        offsets, t = [], 0.0
        for s in self.segments:
            offsets.append(round(t, 3))
            t += s.duration
        return offsets
