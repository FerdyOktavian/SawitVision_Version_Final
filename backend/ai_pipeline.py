"""YOLO11n -> DINOv2 maturity inference pipeline for SawitVision V3.

The implementation follows the locked research artifacts:

* YOLO11n Stage 22 ``best.pt``, selected by the Stage 23 V1 validation
  analysis (inference ``imgsz=640``, ``conf=0.40``, ``iou=0.50``).
* DINOv2 ViT-S/14 Stage 39 ``best.pt``, validated by Stages 40 and 41.
* DINO evaluation preprocessing is exactly: RGB, bicubic resize to 256,
  center crop to 224, tensor conversion, and ImageNet normalization.

All public confidence and probability values returned by this module use the
legacy API scale of 0-100 percent.
"""

from __future__ import annotations

from collections import Counter
from contextlib import nullcontext
import gc
import hashlib
import logging
import math
import os
from pathlib import Path
import threading
from typing import Any, Iterable

from PIL import Image, ImageDraw, ImageFont, ImageOps
import torch
from torch import Tensor, nn
from torchvision import transforms
from torchvision.transforms import InterpolationMode
from transformers import Dinov2Config, Dinov2Model
from ultralytics import YOLO

from ai_model_config import (
    BASE_DIR,
    DEFAULT_DINO_SHA256,
    DEFAULT_YOLO_SHA256,
    DINO_ARTIFACT,
    YOLO_ARTIFACT,
    resolve_model_path,
)
from config_utils import env_bool, env_float, env_int, env_text
from image_safety import log_rss_checkpoint

logger = logging.getLogger(__name__)

# Some virtualized CPUs (for example older KVM CPU profiles without AVX)
# cannot execute certain oneDNN/MKLDNN primitives reliably.
# SawitVision production inference is CPU-safe without MKLDNN.
if not torch.cuda.is_available():
    torch.backends.mkldnn.enabled = False

CLASS_NAMES = ("belum_masak", "masak", "terlalu_masak")
CLASS_TO_INDEX = {name: index for index, name in enumerate(CLASS_NAMES)}

DINO_MODEL_SOURCE = "facebook/dinov2-small"
DINO_MODEL_COMMIT = "ed25f3a31f01632728cabb09d1542f84ab7b0056"
DINO_CHECKPOINT_FORMAT = "stage39_full_training_state_v1"
DINO_BEST_EPOCH = 11
DINO_BEST_VAL_MACRO_F1 = 0.9747261765521841
DINO_IMAGE_SIZE = 224
DINO_RESIZE_SIZE = 256
DINO_MEAN = (0.485, 0.456, 0.406)
DINO_STD = (0.229, 0.224, 0.225)

ANNOTATION_COLORS = {
    "belum_masak": "#22C55E",
    "masak": "#F59E0B",
    "terlalu_masak": "#EF4444",
}


class AIPipelineError(RuntimeError):
    """Raised when model loading or inference violates the locked contract."""


class MaturityDinov2(nn.Module):
    """Exact Stage 39 CLS-token + mean-patch-token classifier."""

    def __init__(self, backbone: Dinov2Model, num_classes: int = 3) -> None:
        super().__init__()
        self.backbone = backbone
        hidden_size = int(backbone.config.hidden_size)
        self.classifier = nn.Linear(hidden_size * 2, num_classes)

    def forward(self, pixel_values: Tensor) -> Tensor:
        output = self.backbone(pixel_values=pixel_values)
        cls_token = output.last_hidden_state[:, 0]
        patch_mean = output.last_hidden_state[:, 1:].mean(dim=1)
        return self.classifier(torch.cat((cls_token, patch_mean), dim=1))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_file(
    path: Path,
    label: str,
    expected_sha256: str | None,
) -> None:
    if not path.is_file():
        raise FileNotFoundError(
            f"{label} tidak ditemukan: {path}. "
            "Atur path melalui environment variable yang sesuai."
        )
    if not expected_sha256:
        logger.warning("model_verification_skipped model=%s", label)
        return
    actual_sha256 = _sha256_file(path)
    if actual_sha256.lower() != expected_sha256.lower():
        raise AIPipelineError(
            f"SHA-256 {label} tidak cocok. "
            f"expected={expected_sha256.lower()}, actual={actual_sha256.lower()}"
        )
    logger.info("model_verification_succeeded model=%s", label)


def _resolve_device(requested: str) -> torch.device:
    normalized = requested.strip().lower()
    if normalized in {"", "auto"}:
        return torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    if normalized.startswith("cuda") and not torch.cuda.is_available():
        logger.warning(
            "cuda_unavailable requested_device=%s fallback_device=cpu",
            requested,
        )
        return torch.device("cpu")
    try:
        return torch.device(normalized)
    except (RuntimeError, ValueError) as error:
        raise AIPipelineError(f"AI_DEVICE tidak valid: {requested!r}") from error


def _zero_probabilities() -> dict[str, float]:
    return {class_name: 0.0 for class_name in CLASS_NAMES}


def summarize_detections(
    detections: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build the legacy-compatible top-level result.

    Compatibility rules required by the backend proof of concept:

    * ``predicted_class`` is the majority maturity class.
    * For a count tie, the class of the highest-confidence detection among
      the tied classes wins. An exact confidence tie is resolved by the
      stable class order in ``CLASS_NAMES``.
    * ``confidence`` is the mean maturity confidence of detections belonging
      to the selected majority class.
    * ``probabilities`` is the mean probability vector across every valid
      detection, not only detections in the majority class.
    * Zero detections returns ``None``, confidence 0, and zero probabilities.
    """
    counts = Counter(
        detection["predicted_class"] for detection in detections
    )
    by_class = {
        class_name: int(counts.get(class_name, 0))
        for class_name in CLASS_NAMES
    }
    summary = {
        "total_detections": len(detections),
        "by_class": by_class,
    }

    if not detections:
        return {
            "predicted_class": None,
            "confidence": 0.0,
            "probabilities": _zero_probabilities(),
            "summary": summary,
        }

    highest_count = max(by_class.values())
    tied_classes = {
        class_name
        for class_name, count in by_class.items()
        if count == highest_count
    }

    if len(tied_classes) == 1:
        predicted_class = next(iter(tied_classes))
    else:
        candidates = [
            detection
            for detection in detections
            if detection["predicted_class"] in tied_classes
        ]
        winning_detection = max(
            candidates,
            key=lambda item: (
                float(item["maturity_confidence"]),
                -CLASS_TO_INDEX[item["predicted_class"]],
            ),
        )
        predicted_class = str(winning_detection["predicted_class"])

    selected_confidences = [
        float(detection["maturity_confidence"])
        for detection in detections
        if detection["predicted_class"] == predicted_class
    ]
    confidence = sum(selected_confidences) / len(selected_confidences)
    probabilities = {
        class_name: sum(
            float(detection["probabilities"][class_name])
            for detection in detections
        )
        / len(detections)
        for class_name in CLASS_NAMES
    }

    return {
        "predicted_class": predicted_class,
        "confidence": confidence,
        "probabilities": probabilities,
        "summary": summary,
    }


class AIPipeline:
    """Load YOLO and DINO once, then run the two-stage RGB pipeline."""

    def __init__(
        self,
        yolo_model_path: Path,
        dino_checkpoint_path: Path,
        *,
        device: torch.device,
        yolo_imgsz: int = 640,
        yolo_confidence: float = 0.40,
        yolo_iou: float = 0.50,
        minimum_crop_size: int = 8,
        dino_batch_size: int = 8,
        use_amp: bool = True,
        annotate_detector_confidence: bool = False,
        verify_model_hashes: bool = True,
        expected_yolo_sha256: str = DEFAULT_YOLO_SHA256,
        expected_dino_sha256: str = DEFAULT_DINO_SHA256,
    ) -> None:
        self.yolo_model_path = Path(yolo_model_path).resolve()
        self.dino_checkpoint_path = Path(dino_checkpoint_path).resolve()
        self.device = device
        self.yolo_imgsz = int(yolo_imgsz)
        self.yolo_confidence = float(yolo_confidence)
        self.yolo_iou = float(yolo_iou)
        self.minimum_crop_size = max(1, int(minimum_crop_size))
        self.dino_batch_size = max(1, int(dino_batch_size))
        self.amp_enabled = bool(use_amp and device.type == "cuda")
        self.annotate_detector_confidence = bool(
            annotate_detector_confidence
        )
        self._inference_lock = threading.Lock()

        _verify_file(
            self.yolo_model_path,
            "checkpoint YOLO11n V1",
            expected_yolo_sha256 if verify_model_hashes else None,
        )
        _verify_file(
            self.dino_checkpoint_path,
            "checkpoint DINOv2 V1",
            expected_dino_sha256 if verify_model_hashes else None,
        )

        logger.info("model_loading model=yolo11n_v1")
        self.detector = YOLO(str(self.yolo_model_path))

        logger.info("model_loading model=dinov2_vits14_v1")
        self.classifier = self._load_dino_classifier(
            self.dino_checkpoint_path
        )
        self.classifier.to(self.device)
        self.classifier.eval()
        if self.classifier.training:
            raise AIPipelineError("DINOv2 gagal masuk ke eval mode.")

        self.dino_transform = transforms.Compose(
            [
                transforms.Resize(
                    DINO_RESIZE_SIZE,
                    interpolation=InterpolationMode.BICUBIC,
                ),
                transforms.CenterCrop(DINO_IMAGE_SIZE),
                transforms.ToTensor(),
                transforms.Normalize(DINO_MEAN, DINO_STD),
            ]
        )

        logger.info(
            "ai_pipeline_ready device=%s amp=%s yolo_imgsz=%d "
            "yolo_confidence=%.3f yolo_iou=%.3f",
            self.device,
            self.amp_enabled,
            self.yolo_imgsz,
            self.yolo_confidence,
            self.yolo_iou,
        )

    @classmethod
    def from_environment(cls) -> "AIPipeline":
        """Build a process-level pipeline from portable environment config."""
        yolo_path = resolve_model_path(YOLO_ARTIFACT)
        dino_path = resolve_model_path(DINO_ARTIFACT)
        return cls(
            yolo_model_path=yolo_path,
            dino_checkpoint_path=dino_path,
            device=_resolve_device(str(env_text("AI_DEVICE", "auto"))),
            yolo_imgsz=env_int(
                "YOLO_IMGSZ", 640, minimum=32, maximum=8192
            ),
            yolo_confidence=env_float(
                "YOLO_CONFIDENCE", 0.40, minimum=0, maximum=1
            ),
            yolo_iou=env_float(
                "YOLO_IOU", 0.50, minimum=0, maximum=1
            ),
            minimum_crop_size=env_int(
                "AI_MIN_CROP_SIZE", 8, minimum=1, maximum=8192
            ),
            dino_batch_size=env_int(
                "DINO_BATCH_SIZE", 4, minimum=1, maximum=1024
            ),
            use_amp=env_bool("AI_USE_AMP", True),
            annotate_detector_confidence=env_bool(
                "AI_ANNOTATE_DETECTOR_CONFIDENCE",
                False,
            ),
            verify_model_hashes=env_bool(
                "AI_VERIFY_MODEL_SHA256",
                True,
            ),
            expected_yolo_sha256=os.getenv(
                "YOLO_MODEL_SHA256",
                DEFAULT_YOLO_SHA256,
            ).strip(),
            expected_dino_sha256=os.getenv(
                "DINO_CHECKPOINT_SHA256",
                DEFAULT_DINO_SHA256,
            ).strip(),
        )

    @staticmethod
    def _load_dino_classifier(checkpoint_path: Path) -> MaturityDinov2:
        checkpoint = torch.load(
            checkpoint_path,
            map_location="cpu",
            weights_only=False,
        )
        if not isinstance(checkpoint, dict):
            raise AIPipelineError("Checkpoint DINO harus berupa dictionary.")
        if checkpoint.get("checkpoint_format") != DINO_CHECKPOINT_FORMAT:
            raise AIPipelineError(
                "Format checkpoint DINO bukan Stage39 V1: "
                f"{checkpoint.get('checkpoint_format')!r}"
            )
        if checkpoint.get("class_to_idx") != CLASS_TO_INDEX:
            raise AIPipelineError(
                "Class mapping checkpoint DINO tidak cocok: "
                f"{checkpoint.get('class_to_idx')!r}"
            )
        if int(checkpoint.get("best_global_epoch", -1)) != DINO_BEST_EPOCH:
            raise AIPipelineError(
                "Checkpoint DINO bukan best epoch Stage39 yang dikunci."
            )
        if not math.isclose(
            float(checkpoint.get("best_val_macro_f1", math.nan)),
            DINO_BEST_VAL_MACRO_F1,
            rel_tol=0.0,
            abs_tol=1e-15,
        ):
            raise AIPipelineError(
                "Validation macro-F1 checkpoint DINO tidak cocok dengan "
                "artifact Stage39."
            )

        runtime_config = checkpoint.get("runtime_config", {})
        if runtime_config.get("model_source") != DINO_MODEL_SOURCE:
            raise AIPipelineError(
                "DINO model source tidak cocok: "
                f"{runtime_config.get('model_source')!r}"
            )
        if runtime_config.get("model_commit_hash") != DINO_MODEL_COMMIT:
            raise AIPipelineError(
                "DINO model commit tidak cocok dengan Stage39 V1."
            )

        backbone_config_document = checkpoint.get("backbone_config")
        if not isinstance(backbone_config_document, dict):
            raise AIPipelineError("Checkpoint DINO tidak memiliki backbone_config.")
        expected_architecture = {
            "model_type": "dinov2",
            "hidden_size": 384,
            "patch_size": 14,
            "num_hidden_layers": 12,
            "num_attention_heads": 6,
        }
        for key, expected_value in expected_architecture.items():
            actual_value = backbone_config_document.get(key)
            if actual_value != expected_value:
                raise AIPipelineError(
                    f"Arsitektur DINO mismatch untuk {key}: "
                    f"expected={expected_value!r}, actual={actual_value!r}"
                )

        backbone = Dinov2Model(
            Dinov2Config.from_dict(backbone_config_document)
        )
        model = MaturityDinov2(backbone, num_classes=len(CLASS_NAMES))
        state_dict = checkpoint.get("model_state_dict")
        if not isinstance(state_dict, dict):
            raise AIPipelineError(
                "Checkpoint DINO tidak memiliki model_state_dict."
            )
        incompatible = model.load_state_dict(state_dict, strict=True)
        if incompatible.missing_keys or incompatible.unexpected_keys:
            raise AIPipelineError(
                "Strict DINO state loading gagal: "
                f"missing={incompatible.missing_keys}, "
                f"unexpected={incompatible.unexpected_keys}"
            )

        del checkpoint
        gc.collect()
        return model

    def _amp_context(self):
        if self.amp_enabled:
            return torch.autocast(device_type="cuda", dtype=torch.float16)
        return nullcontext()

    def _run_dino_batch(self, tensors: list[Tensor]) -> Tensor:
        batch = None
        logits = None
        probabilities = None
        try:
            batch = torch.stack(tensors).to(
                self.device,
                non_blocking=True,
            )
            self.classifier.eval()
            with torch.inference_mode():
                with self._amp_context():
                    logits = self.classifier(batch)
                probabilities = torch.softmax(logits.float(), dim=1)

            if probabilities.ndim != 2 or probabilities.shape[1] != len(
                CLASS_NAMES
            ):
                raise AIPipelineError(
                    "Output DINO tidak memiliki shape [batch, 3]: "
                    f"{tuple(probabilities.shape)}"
                )
            if not torch.isfinite(probabilities).all():
                raise AIPipelineError(
                    "DINO menghasilkan probability non-finite."
                )
            sum_error = float(
                (probabilities.sum(dim=1) - 1.0).abs().max().cpu()
            )
            if sum_error > 1e-5:
                raise AIPipelineError(
                    "Jumlah softmax DINO menyimpang terlalu besar: "
                    f"{sum_error}"
                )
            return probabilities.detach().cpu()
        finally:
            del logits, probabilities, batch

    @staticmethod
    def _warning(
        detection_index: int,
        stage: str,
        reason: str,
        bbox: Iterable[float] | None = None,
    ) -> dict[str, Any]:
        warning: dict[str, Any] = {
            "detection_index": int(detection_index),
            "stage": stage,
            "reason": reason,
        }
        if bbox is not None:
            warning["bbox"] = [float(value) for value in bbox]
        return warning

    def _prepare_crops(
        self,
        image: Image.Image,
        boxes: Any,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        prepared: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = []
        if boxes is None or len(boxes) == 0:
            return prepared, warnings

        width, height = image.size
        coordinates = boxes.xyxy.detach().cpu().tolist()
        detector_confidences = boxes.conf.detach().cpu().tolist()

        for index, (raw_bbox, raw_confidence) in enumerate(
            zip(coordinates, detector_confidences, strict=True)
        ):
            if len(raw_bbox) != 4 or not all(
                math.isfinite(float(value)) for value in raw_bbox
            ):
                warnings.append(
                    self._warning(index, "bbox", "bbox_non_finite", raw_bbox)
                )
                continue

            raw_x1, raw_y1, raw_x2, raw_y2 = (
                float(value) for value in raw_bbox
            )
            x1 = max(0, min(width, math.floor(raw_x1)))
            y1 = max(0, min(height, math.floor(raw_y1)))
            x2 = max(0, min(width, math.ceil(raw_x2)))
            y2 = max(0, min(height, math.ceil(raw_y2)))
            clamped_bbox = [x1, y1, x2, y2]

            if x2 <= x1 or y2 <= y1:
                warnings.append(
                    self._warning(
                        index,
                        "bbox",
                        "bbox_invalid_after_clamp",
                        clamped_bbox,
                    )
                )
                continue
            if (
                x2 - x1 < self.minimum_crop_size
                or y2 - y1 < self.minimum_crop_size
            ):
                warnings.append(
                    self._warning(
                        index,
                        "crop",
                        "crop_too_small",
                        clamped_bbox,
                    )
                )
                continue

            prepared.append(
                {
                    "detection_index": index,
                    "bbox": clamped_bbox,
                    "detector_confidence": float(raw_confidence) * 100.0,
                }
            )

        return prepared, warnings

    def _classify_prepared(
        self,
        image: Image.Image,
        prepared: list[dict[str, Any]],
        warnings: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        detections: list[dict[str, Any]] = []
        for start in range(0, len(prepared), self.dino_batch_size):
            items = prepared[start : start + self.dino_batch_size]
            valid_items = []
            tensors = []
            for item in items:
                crop = None
                try:
                    x1, y1, x2, y2 = item["bbox"]
                    crop = image.crop((x1, y1, x2, y2))
                    if crop.width <= 0 or crop.height <= 0:
                        raise ValueError("crop kosong")
                    tensors.append(self.dino_transform(crop))
                    valid_items.append(item)
                except Exception as error:
                    warnings.append(
                        self._warning(
                            item["detection_index"],
                            "crop_preprocessing",
                            f"{type(error).__name__}: {error}",
                            item["bbox"],
                        )
                    )
                finally:
                    if crop is not None:
                        crop.close()

            if not valid_items:
                continue
            log_rss_checkpoint(logger, "before_dino_batch")
            try:
                probability_batch = self._run_dino_batch(tensors)
                batch_pairs = [
                    (item, probability_tensor.tolist())
                    for item, probability_tensor in zip(
                        valid_items,
                        probability_batch,
                        strict=True,
                    )
                ]
                del probability_batch
            except Exception as batch_error:
                # A large batch may fail on a constrained GPU. Retry each
                # crop separately so one failure does not discard valid TBS.
                warnings.append(
                    self._warning(
                        valid_items[0]["detection_index"],
                        "dino_batch",
                        f"batch_retry: {type(batch_error).__name__}: "
                        f"{batch_error}",
                    )
                )
                batch_pairs = []
                for item, tensor in zip(valid_items, tensors, strict=True):
                    try:
                        single_probability = self._run_dino_batch([tensor])[0]
                        batch_pairs.append(
                            (item, single_probability.tolist())
                        )
                        del single_probability
                    except Exception as item_error:
                        warnings.append(
                            self._warning(
                                item["detection_index"],
                                "dino_inference",
                                f"{type(item_error).__name__}: {item_error}",
                                item["bbox"],
                            )
                        )
            finally:
                del tensors
                log_rss_checkpoint(logger, "after_dino_batch")

            for item, probability_row in batch_pairs:
                probability_values = [
                    float(value) * 100.0
                    for value in probability_row
                ]
                class_index = max(
                    range(len(CLASS_NAMES)),
                    key=probability_values.__getitem__,
                )
                predicted_class = CLASS_NAMES[class_index]
                detections.append(
                    {
                        "bbox": list(item["bbox"]),
                        "detector_confidence": float(
                            item["detector_confidence"]
                        ),
                        "predicted_class": predicted_class,
                        "class_index": class_index,
                        "maturity_confidence": probability_values[
                            class_index
                        ],
                        "probabilities": {
                            class_name: probability_values[index]
                            for index, class_name in enumerate(CLASS_NAMES)
                        },
                    }
                )
            del batch_pairs

        if prepared and not detections:
            raise AIPipelineError(
                "DINO gagal mengklasifikasikan seluruh crop valid. "
                f"Detail: {warnings}"
            )
        return detections

    @staticmethod
    def _annotation_font(image: Image.Image) -> ImageFont.ImageFont:
        size = max(13, min(28, round(min(image.size) * 0.025)))
        for font_name in ("DejaVuSans-Bold.ttf", "arialbd.ttf"):
            try:
                return ImageFont.truetype(font_name, size=size)
            except OSError:
                continue
        return ImageFont.load_default()

    def annotate_image(
        self,
        image: Image.Image,
        detections: list[dict[str, Any]],
        max_size: int | None = None,
    ) -> Image.Image:
        source_width, source_height = image.size
        should_resize = (
            max_size is not None
            and max_size > 0
            and (source_width > max_size or source_height > max_size)
        )
        annotated = (
            ImageOps.contain(
                image,
                (int(max_size), int(max_size)),
                method=Image.Resampling.LANCZOS,
            )
            if should_resize
            else image.copy()
        )
        scale_x = annotated.width / source_width
        scale_y = annotated.height / source_height
        draw = ImageDraw.Draw(annotated)
        font = self._annotation_font(annotated)
        line_width = max(2, round(min(annotated.size) * 0.004))

        display_class_names = {
            "belum_masak": "BELUM MATANG",
            "masak": "MATANG",
            "terlalu_masak": "TERLALU MATANG",
        }

        # Preserve the exact detections[] order used by the API and by the
        # zero-based prediction_detections.detection_index database column.
        for tbs_number, detection in enumerate(detections, start=1):
            source_x1, source_y1, source_x2, source_y2 = detection["bbox"]
            x1 = round(float(source_x1) * scale_x)
            y1 = round(float(source_y1) * scale_y)
            x2 = round(float(source_x2) * scale_x)
            y2 = round(float(source_y2) * scale_y)
            class_name = str(detection["predicted_class"])
            color = ANNOTATION_COLORS.get(class_name, "#FFFFFF")
            display_class_name = display_class_names.get(
                class_name,
                class_name.replace("_", " ").upper(),
            )
            label_lines = [
                f"TBS {tbs_number}",
                f"{display_class_name} "
                f"{float(detection['maturity_confidence']):.1f}%",
            ]
            if self.annotate_detector_confidence:
                label_lines.append(
                    f"DET {float(detection['detector_confidence']):.1f}%"
                )
            label = "\n".join(label_lines)
            text_spacing = max(2, line_width)

            draw.rectangle((x1, y1, x2, y2), outline=color, width=line_width)
            text_box = draw.multiline_textbbox(
                (0, 0),
                label,
                font=font,
                spacing=text_spacing,
            )
            text_width = text_box[2] - text_box[0]
            text_height = text_box[3] - text_box[1]
            padding = max(3, line_width)
            label_x = max(0, min(x1, annotated.width - text_width - 2 * padding))
            label_y = y1 - text_height - 2 * padding
            if label_y < 0:
                label_y = min(annotated.height - text_height - 2 * padding, y1)
            draw.rectangle(
                (
                    label_x,
                    label_y,
                    label_x + text_width + 2 * padding,
                    label_y + text_height + 2 * padding,
                ),
                fill=color,
            )
            draw.multiline_text(
                (label_x + padding, label_y + padding),
                label,
                fill="white",
                font=font,
                spacing=text_spacing,
            )
        return annotated

    @staticmethod
    def _normalize_source_image(
        image: Image.Image,
    ) -> tuple[Image.Image, bool]:
        """Return full-quality, correctly oriented RGB pixels with few copies."""
        try:
            orientation = int(image.getexif().get(274, 1) or 1)
        except (AttributeError, TypeError, ValueError):
            orientation = 1

        if orientation == 1:
            image.load()
            if image.mode == "RGB":
                return image, False
            return image.convert("RGB"), True

        transposed = ImageOps.exif_transpose(image)
        if transposed.mode == "RGB":
            return transposed, True
        converted = transposed.convert("RGB")
        transposed.close()
        return converted, True

    def _release_detector_request_state(self) -> None:
        """Drop full-resolution request buffers retained by Ultralytics."""
        predictor = getattr(self.detector, "predictor", None)
        if predictor is None:
            return
        for attribute in (
            "batch",
            "dataset",
            "results",
            "plotted_img",
        ):
            if hasattr(predictor, attribute):
                setattr(predictor, attribute, None)

    def predict(
        self,
        image: Image.Image,
        annotation_min_confidence: float | None = None,
        annotation_max_size: int | None = None,
        consume_input: bool = False,
    ) -> dict[str, Any]:
        """Run YOLO -> clamped crops -> DINO and return one image result."""
        if not isinstance(image, Image.Image):
            raise TypeError("AIPipeline.predict membutuhkan PIL.Image.")
        normalized_image, owns_normalized_image = self._normalize_source_image(
            image
        )
        if owns_normalized_image:
            log_rss_checkpoint(logger, "after_rgb_copy")
            if consume_input:
                image.close()
        log_rss_checkpoint(logger, "after_rgb")

        try:
            if normalized_image.width <= 0 or normalized_image.height <= 0:
                raise AIPipelineError("Dimensi gambar tidak valid.")
            with self._inference_lock, torch.inference_mode():
                yolo_results = None
                try:
                    log_rss_checkpoint(logger, "before_yolo")
                    yolo_results = self.detector.predict(
                        source=normalized_image,
                        imgsz=self.yolo_imgsz,
                        conf=self.yolo_confidence,
                        iou=self.yolo_iou,
                        device=str(self.device),
                        verbose=False,
                    )
                    log_rss_checkpoint(logger, "after_yolo")

                    if len(yolo_results) != 1:
                        raise AIPipelineError(
                            "YOLO harus mengembalikan tepat satu result untuk "
                            f"satu gambar; diterima {len(yolo_results)}."
                        )

                    prepared, warnings = self._prepare_crops(
                        normalized_image,
                        yolo_results[0].boxes,
                    )
                except Exception as error:
                    if isinstance(error, AIPipelineError):
                        raise
                    raise AIPipelineError(
                        f"YOLO inference gagal: {type(error).__name__}: {error}"
                    ) from error
                finally:
                    yolo_results = None
                    self._release_detector_request_state()
                    log_rss_checkpoint(logger, "after_yolo_release")

                # Explicitly avoid DINO when no valid crop exists.
                detections = (
                    self._classify_prepared(
                        normalized_image,
                        prepared,
                        warnings,
                    )
                    if prepared
                    else []
                )
                del prepared
                log_rss_checkpoint(logger, "after_dino")

            compatibility = summarize_detections(detections)
            should_annotate = (
                annotation_min_confidence is None
                or (
                    compatibility["predicted_class"] is not None
                    and float(compatibility["confidence"])
                    >= float(annotation_min_confidence)
                )
            )
            log_rss_checkpoint(logger, "before_annotation")
            annotated_image = (
                self.annotate_image(
                    normalized_image,
                    detections,
                    max_size=annotation_max_size,
                )
                if should_annotate
                else None
            )
            log_rss_checkpoint(logger, "after_annotation")
            return {
                **compatibility,
                "detections": detections,
                "warnings": warnings,
                "annotated_image": annotated_image,
                "image_size": normalized_image.size,
            }
        finally:
            if owns_normalized_image or consume_input:
                normalized_image.close()
