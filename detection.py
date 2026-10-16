from ultralytics import YOLO
import os
import cv2
import pandas as pd
import matplotlib.pyplot as plt
import numpy as np

# ── CONFIG ────────────────────────────────────────────────────────────────────
model_path        = "/home/sagemaker-user/11x_weights.pt"
images_folder     = "/home/sagemaker-user/sample_images"
output_dir_images = f"{images_folder}_Annotated"
output_excel_path = f"{images_folder}_detections.xlsx"
MAX_DISPLAY       = 12    # max annotated images to show inline (detections only)
COLS              = 3     # grid columns
# ─────────────────────────────────────────────────────────────────────────────

os.makedirs(output_dir_images, exist_ok=True)
bounding_box_data = []
display_frames    = []   # collect (filename, annotated_frame) for inline display

model = YOLO(model_path)
print(f"Model loaded: {os.path.basename(model_path)}\n")

image_files = sorted([
    os.path.join(images_folder, f)
    for f in os.listdir(images_folder)
    if f.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.webp'))
])

if not image_files:
    print(f"No images found in {images_folder}")
else:
    print(f"Processing {len(image_files)} images...\n")
    detected_count = 0

    for i, im_path in enumerate(image_files, 1):
        image_name = os.path.basename(im_path)
        try:
            results  = model(im_path, save=False, verbose=False)
            res      = results[0]
            annotated = res.plot()

            if res.boxes is not None and len(res.boxes) > 0:
                detected_count += 1
                print(f"[{i:02d}/{len(image_files)}] {image_name}")
                for box in res.boxes:
                    cls_idx    = int(box.cls)
                    class_name = model.names.get(cls_idx, "Unknown")
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    conf = float(box.conf[0])
                    print(f"        └─ {class_name}  {conf:.0%}  [{int(x1)}, {int(y1)} → {int(x2)}, {int(y2)}]")
                    bounding_box_data.append({
                        'Image Filename': image_name,
                        'Class Name':     class_name,
                        'Confidence':     round(conf, 3),
                        'x1': round(x1, 1), 'y1': round(y1, 1),
                        'x2': round(x2, 1), 'y2': round(y2, 1)
                    })
                if len(display_frames) < MAX_DISPLAY:
                    display_frames.append((image_name, annotated))
            else:
                bounding_box_data.append({
                    'Image Filename': image_name, 'Class Name': 'No Detection',
                    'Confidence': 0.0, 'x1': 0.0, 'y1': 0.0, 'x2': 0.0, 'y2': 0.0
                })

            cv2.imwrite(os.path.join(output_dir_images, image_name), annotated)

        except Exception as e:
            print(f"[{i:02d}] ERROR: {image_name} — {e}")
            bounding_box_data.append({
                'Image Filename': image_name, 'Class Name': 'Error',
                'Confidence': 0.0, 'x1': 0.0, 'y1': 0.0, 'x2': 0.0, 'y2': 0.0
            })

    # ── SUMMARY ──────────────────────────────────────────────────────────────
    df = pd.DataFrame(bounding_box_data)
    detections_df = df[~df['Class Name'].isin(['No Detection', 'Error'])]

    print(f"\n{'─' * 52}")
    print(f"  Images processed  : {len(image_files)}")
    print(f"  With detections   : {detected_count}")
    print(f"  No detections     : {len(image_files) - detected_count}")
    print(f"  Total detections  : {len(detections_df)}")
    print(f"{'─' * 52}")

    if not detections_df.empty:
        print("\n  Detections by class:")
        for cls, cnt in detections_df['Class Name'].value_counts().items():
            bar = '█' * cnt
            print(f"  {cls:<28} {cnt:>3}  {bar}")

    df.to_excel(output_excel_path, index=False)
    print(f"\n  Annotated images → {output_dir_images}")
    print(f"  Excel report     → {output_excel_path}")

    # ── INLINE IMAGE GRID ────────────────────────────────────────────────────
    if display_frames:
        rows = (len(display_frames) + COLS - 1) // COLS
        fig, axes = plt.subplots(rows, COLS, figsize=(COLS * 7, rows * 4))
        axes = np.array(axes).flatten()

        for ax, (name, frame) in zip(axes, display_frames):
            ax.imshow(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            ax.set_title(name, fontsize=7, pad=4)
            ax.axis('off')

        for ax in axes[len(display_frames):]:
            ax.set_visible(False)

        showing = len(display_frames)
        total   = detected_count
        plt.suptitle(
            f"{os.path.basename(images_folder)} — Detections  "
            f"(showing {showing} of {total} images with detections)",
            fontsize=13, fontweight='bold', y=1.01
        )
        plt.tight_layout()
        plt.show()