#!/usr/bin/env python
"""
SELF-HOSTED OCR against the same eight screenshots — PaddleOCR and Surya.

    python scripts/ocr-local.py --engine=paddle --out=paddle.json
    python scripts/ocr-local.py --engine=surya  --out=surya.json
    node    scripts/ocr-bench.mjs --provider=paddle

── WHY THIS ONE MATTERS MORE THAN THE HOSTED READERS ────────────────────────────────────────────

Every paid option shares two problems that price tables never show. The screenshots carry REAL
CUSTOMER NAMES AND ADDRESSES, so using a hosted engine means shipping them to a third party — and
the company operates from Damascus, where availability and payment for US cloud services is an open
question that no benchmark can settle.

A model running on the VPS the business already pays for has neither problem: nothing leaves the
country, nothing needs a card, and the per-image cost is zero forever. If accuracy is close, that is
a different kind of win from a cent saved.

── HOW IT PLUGS IN ──────────────────────────────────────────────────────────────────────────────

This writes a plain JSON transcript per fixture and stops. Scoring stays in `ocr-bench.mjs`, against
the same answer key as every other provider, so a local engine is judged by the same ruler — and the
expensive part (running the model) does not have to be repeated to re-score.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "apps" / "driver" / "test" / "fixtures" / "ocr"

# The same eight the hosted providers are scored on. Kept in step with scripts/ocr-truth.mjs.
FILES = [
    "log-0804-a.jpg",
    "log-0804-b.jpg",
    "orders-0804-a.jpg",
    "orders-0804-b.jpg",
    "orders-0804-c.jpg",
    "orders-0806-lg.jpg",
    "orders-0807-sm.jpg",
    "orders-0806-en.jpg",
]


def run_paddle(paths: list[Path]) -> dict[str, dict]:
    """
    PaddleOCR with the Arabic recogniser.

    `lang="ar"` selects a recognition model trained on Arabic script INCLUDING its numerals, which
    is the whole question — a Latin model would transliterate ٢٣٥ into whatever shape is nearest,
    which is exactly how Tesseract produces «11061» for «−١٦٥٫٥٠».
    """
    from paddleocr import PaddleOCR  # noqa: PLC0415

    # 3.x renamed the entry point and dropped several constructor arguments, so each shape is tried
    # in turn rather than pinning this script to one release of a fast-moving package.
    #
    # `enable_mkldnn=False` is not optional on Windows CPU. With oneDNN on, inference dies with
    #   (Unimplemented) ConvertPirAttribute2RuntimeAttribute not support
    #   [pir::ArrayAttribute<pir::DoubleAttribute>]
    # — a backend fault, nothing to do with the image or the language. Disabling it costs speed and
    # is the difference between a reader that runs and one that does not.
    # The 3.x default pipeline also loads a document-orientation classifier and a de-warping model
    # (PP-LCNet_x1_0_doc_ori, UVDoc). A phone screenshot is already flat and upright, so both are
    # dead weight — and each is another native code path. On this Windows box the full pipeline
    # segfaults outright (0xC0000005), so the slim configuration is tried FIRST, not as a fallback.
    slim = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "enable_mkldnn": False,
    }
    attempts = [
        {"lang": "ar", **slim},
        {"lang": "ar", "use_textline_orientation": False, "enable_mkldnn": False},
        {"lang": "ar", "enable_mkldnn": False},
        {"lang": "ar", "use_angle_cls": False, "enable_mkldnn": False, "show_log": False},
        {"lang": "ar"},
    ]
    engine = None
    for kwargs in attempts:
        try:
            engine = PaddleOCR(**kwargs)
            break
        except TypeError:
            continue
    if engine is None:
        raise RuntimeError("could not construct PaddleOCR with any known argument shape")

    out: dict[str, dict] = {}
    for p in paths:
        started = time.time()
        lines: list[str] = []
        try:
            if hasattr(engine, "predict"):
                for page in engine.predict(str(p)):
                    d = page.json.get("res", page.json) if hasattr(page, "json") else page
                    lines.extend(d.get("rec_texts", []) or [])
            else:
                result = engine.ocr(str(p), cls=False)
                for page in result or []:
                    for entry in page or []:
                        # [[box], (text, confidence)]
                        if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                            lines.append(str(entry[1][0]))
        except Exception as e:  # noqa: BLE001 — one bad fixture must not lose the other seven
            print(f"  ! {p.name}: {e}", file=sys.stderr)
        out[p.name] = {"text": "\n".join(lines), "lines": lines}
        print(f"  {p.name:<22} {len(lines):>3} lines   {time.time() - started:5.1f}s")
    return out


def run_surya(paths: list[Path]) -> dict[str, dict]:
    """
    Surya — detection then recognition, both as torch models.

    Heavier than Paddle (it pulls torch), but its recogniser covers 90+ languages and it is the
    stronger of the two on dense, small text, which is what a payments log is.
    """
    from PIL import Image  # noqa: PLC0415
    from surya.detection import DetectionPredictor  # noqa: PLC0415
    from surya.recognition import RecognitionPredictor  # noqa: PLC0415

    recogniser = RecognitionPredictor()
    detector = DetectionPredictor()

    out: dict[str, dict] = {}
    for p in paths:
        started = time.time()
        lines: list[str] = []
        try:
            image = Image.open(p).convert("RGB")
            # The signature moved between releases: newer takes langs, older took a list per image.
            try:
                predictions = recogniser([image], det_predictor=detector)
            except TypeError:
                predictions = recogniser([image], [["ar", "en"]], detector)
            for page in predictions:
                for line in getattr(page, "text_lines", []) or []:
                    text = getattr(line, "text", None)
                    if text:
                        lines.append(str(text))
        except Exception as e:  # noqa: BLE001
            print(f"  ! {p.name}: {e}", file=sys.stderr)
        out[p.name] = {"text": "\n".join(lines), "lines": lines}
        print(f"  {p.name:<22} {len(lines):>3} lines   {time.time() - started:5.1f}s")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--engine", required=True, choices=["paddle", "surya"])
    ap.add_argument("--out", required=True, help="where to write the JSON transcript")
    ap.add_argument("--only", default=None, help="comma-separated fixture names")
    args = ap.parse_args()

    wanted = args.only.split(",") if args.only else FILES
    paths = [FIXTURES / f for f in wanted]
    missing = [p.name for p in paths if not p.exists()]
    if missing:
        print(f"missing fixtures: {missing}", file=sys.stderr)
        return 2

    print(f"\n▸ {args.engine} — {len(paths)} screenshots, running locally, nothing leaves this machine\n")
    started = time.time()
    result = run_paddle(paths) if args.engine == "paddle" else run_surya(paths)

    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    total = time.time() - started
    print(f"\nwrote {args.out}  ({total:.1f}s total, {total / max(1, len(paths)):.1f}s per image)")
    print(f"score it:  node scripts/ocr-bench.mjs --provider={args.engine}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
