from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from ultralytics import YOLO


ROOT = Path(__file__).resolve().parent.parent
CHECKPOINT = ROOT / "SAT Asset Detection Model.pt"
MODEL_ASSETS = ROOT / "assets" / "model"
IMAGE_SIZE = 640
PART_SIZE = 32 * 1024 * 1024
DEFAULT_BATCH_SIZE = 4


def split_model(model_path: Path, class_names: list[str], max_batch_size: int) -> None:
    MODEL_ASSETS.mkdir(parents=True, exist_ok=True)
    part_sizes = []
    part_hashes = []
    part_count = 0

    with model_path.open("rb") as model_file:
        while chunk := model_file.read(PART_SIZE):
            part_count += 1
            part_path = MODEL_ASSETS / f"model-part-{part_count:03d}.bin"
            part_path.write_bytes(chunk)
            part_sizes.append(len(chunk))
            part_hashes.append(hashlib.sha256(chunk).hexdigest())

    model_hash = hashlib.sha256(model_path.read_bytes()).hexdigest()

    anchor_count = sum((IMAGE_SIZE // stride) ** 2 for stride in (8, 16, 32))
    metadata = {
        "classNames": class_names,
        "inputSize": IMAGE_SIZE,
        "dynamicBatch": True,
        "maxBatchSize": max_batch_size,
        "modelVersion": model_hash[:16],
        "partHashes": part_hashes,
        "modelBytes": sum(part_sizes),
        "partCount": part_count,
        "partSizes": part_sizes,
        "outputShape": ["batch", len(class_names) + 4, anchor_count],
    }
    (MODEL_ASSETS / "metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {part_count} model files and metadata to {MODEL_ASSETS}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export the TxDOT YOLO checkpoint to ONNX and split it for static hosting."
    )
    parser.add_argument(
        "--skip-export",
        action="store_true",
        help="Split an existing dynamic-batch ONNX file without exporting the checkpoint again.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Maximum browser inference batch size (default: {DEFAULT_BATCH_SIZE}).",
    )
    args = parser.parse_args()
    if args.batch_size < 1:
        parser.error("--batch-size must be at least 1.")

    if not CHECKPOINT.is_file():
        raise FileNotFoundError(f"Model checkpoint not found: {CHECKPOINT}")

    model = YOLO(str(CHECKPOINT))
    class_names = [model.names[index] for index in sorted(model.names)]
    onnx_path = ROOT / f"{CHECKPOINT.stem}.onnx"

    if not args.skip_export:
        onnx_path = Path(
            model.export(
                format="onnx",
                imgsz=IMAGE_SIZE,
                batch=args.batch_size,
                dynamic=True,
                simplify=False,
                opset=17,
                nms=False,
            )
        )
    elif not onnx_path.is_file():
        raise FileNotFoundError(
            f"ONNX file not found: {onnx_path}. Run without --skip-export to create it."
        )
    else:
        import onnx

        onnx_model = onnx.load(str(onnx_path), load_external_data=False)
        if not onnx_model.graph.input:
            raise ValueError(f"ONNX model has no graph input: {onnx_path}")
        batch_dimension = onnx_model.graph.input[0].type.tensor_type.shape.dim[0]
        if not batch_dimension.dim_param:
            raise ValueError(
                "The existing ONNX model does not have a dynamic batch dimension. "
                "Run without --skip-export to export the checkpoint for batching."
            )

    split_model(onnx_path, class_names, args.batch_size)


if __name__ == "__main__":
    main()
