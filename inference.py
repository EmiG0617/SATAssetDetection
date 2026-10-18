from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import TypedDict

import cv2
import numpy as np
import torch
from ultralytics import YOLO


class Detection(TypedDict):
    asset_type: str
    confidence: float
    x1: float
    y1: float
    x2: float
    y2: float


class ImageDetections(TypedDict):
    filename: str
    width: int | None
    height: int | None
    detections: list[Detection]
    error: str | None


class AssetDetector:
    """Loads the trained model once and predicts on encoded image bytes."""

    def __init__(
        self,
        model_path: str | Path,
        *,
        device: str | None = None,
        image_size: int = 640,
        confidence: float = 0.25,
        iou: float = 0.7,
        batch_size: int = 4,
    ) -> None:
        if image_size < 1:
            raise ValueError("image_size must be a positive integer.")
        if not 0 <= confidence <= 1:
            raise ValueError("confidence must be between 0 and 1.")
        if not 0 <= iou <= 1:
            raise ValueError("iou must be between 0 and 1.")
        if batch_size < 1:
            raise ValueError("batch_size must be a positive integer.")

        self.device = device or ("cuda:0" if torch.cuda.is_available() else "cpu")
        self.image_size = image_size
        self.confidence = confidence
        self.iou = iou
        self.batch_size = batch_size
        self.model = YOLO(str(model_path))

    def predict_images(
        self,
        images: Sequence[tuple[str, bytes]],
    ) -> list[ImageDetections]:
        """Return detections for (filename, encoded image bytes) pairs.

        Image contents are decoded in memory and are not written to disk.
        """
        output: list[ImageDetections] = []
        for start in range(0, len(images), self.batch_size):
            batch = images[start : start + self.batch_size]
            batch_results: list[tuple[int, ImageDetections]] = []
            decoded_images: list[tuple[int, str, np.ndarray]] = []
            for index, (filename, image_bytes) in enumerate(batch):
                try:
                    image = self._decode_image(filename, image_bytes)
                except ValueError as error:
                    batch_results.append(
                        (index, self._error_result(filename, str(error)))
                    )
                else:
                    decoded_images.append((index, filename, image))

            if not decoded_images:
                batch_results.sort(key=lambda result: result[0])
                output.extend(result for _, result in batch_results)
                continue

            predictions = self.model.predict(
                source=[image for _, _, image in decoded_images],
                imgsz=self.image_size,
                conf=self.confidence,
                iou=self.iou,
                device=self.device,
                batch=len(decoded_images),
                save=False,
                verbose=False,
            )
            if len(predictions) != len(decoded_images):
                raise RuntimeError(
                    "The model returned a different number of predictions "
                    "than the number of input images."
                )

            for (index, filename, image), prediction in zip(
                decoded_images, predictions, strict=True
            ):
                batch_results.append(
                    (index, self._format_result(filename, image, prediction))
                )
            batch_results.sort(key=lambda result: result[0])
            output.extend(result for _, result in batch_results)
        return output

    @staticmethod
    def _decode_image(filename: str, image_bytes: bytes) -> np.ndarray:
        if not image_bytes:
            raise ValueError(f"Image {filename!r} is empty.")
        image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError(f"Image {filename!r} could not be decoded.")
        return image

    def _format_result(
        self,
        filename: str,
        image: np.ndarray,
        prediction: object,
    ) -> ImageDetections:
        boxes = prediction.boxes
        detections: list[Detection] = []
        if boxes is not None and len(boxes) > 0:
            class_ids = boxes.cls.cpu().tolist()
            confidences = boxes.conf.cpu().tolist()
            coordinates = boxes.xyxy.cpu().tolist()
            for class_id, score, (x1, y1, x2, y2) in zip(
                class_ids, confidences, coordinates, strict=True
            ):
                detections.append(
                    {
                        "asset_type": str(self.model.names[int(class_id)]),
                        "confidence": round(float(score), 3),
                        "x1": round(float(x1), 2),
                        "y1": round(float(y1), 2),
                        "x2": round(float(x2), 2),
                        "y2": round(float(y2), 2),
                    }
                )

        height, width = image.shape[:2]
        return {
            "filename": filename,
            "width": width,
            "height": height,
            "detections": detections,
            "error": None,
        }

    @staticmethod
    def _error_result(filename: str, message: str) -> ImageDetections:
        return {
            "filename": filename,
            "width": None,
            "height": None,
            "detections": [],
            "error": message,
        }
