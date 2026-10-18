# TxDOT San Antonio District Asset Detection

A static website for running the district's Ultralytics YOLO11 asset detector in a visitor's browser. The site can be hosted for free with GitHub Pages. Uploaded images are not sent to a server; the model files are public site assets.

## Run the website

Open `index.html` through a local static web server (rather than `file://`) or publish the repository with GitHub Pages. The app loads its ONNX Runtime, spreadsheet, and ZIP libraries from jsDelivr when opened, so visitors need an internet connection.

For a local preview, from the project folder run:

```powershell
py -m http.server 8000
```

Then open `http://localhost:8000`.

To test multi-threaded WebAssembly locally, run this instead:

```powershell
py scripts/serve_isolated.py --port 8000
```

Open `http://localhost:8000/?provider=wasm` to force CPU/WASM inference. The local server sends the cross-origin isolation headers needed for WASM threads; the result status shows how many threads were enabled. For a WebGPU comparison, use `http://localhost:8000/` in a browser with WebGPU support. Run the same images in each mode and compare the reported inference time and throughput. This local test does not change the GitHub Pages host, which will continue to use one WASM thread unless it is moved to a host where these response headers can be configured.

In **Folder of images** mode, choose the entire folder to process its supported images. If your browser's folder picker only displays folders, select **Browse image files** to open the usual file picker, then select the images inside the folder (use Ctrl+A to select all).

Large folders are prepared and annotated one image at a time, while the current batch-capable ONNX export runs inference on up to four images together. Each image is decoded once and reused for model input preparation and annotation. To rebuild the batch-capable model package, use the original checkpoint and run `python scripts/prepare_model.py --batch-size 4`; this re-exports ONNX with dynamic batch support using the same trained weights, then replaces the browser model pieces and metadata. Model pieces have versioned URLs and SHA-256 hashes to prevent stale cached pieces from being silently combined with a newly generated model. In a secure browser context with WebGPU available, the site requests a high-performance GPU adapter and tries GPU inference; if WebGPU session initialization fails, it falls back to CPU-based WebAssembly. The browser may not have a discrete GPU to select, and actual adapter selection remains up to the browser and operating system. The status badge indicates the initialized provider and batch size, and the completion message reports throughput, highest raw model score, and average preparation, inference, decoding, and annotation time per successful image. GPU support and performance depend on the browser, operating system, graphics hardware, and model operator support, so compare results and timing on target devices. Batching changes the ONNX export shape, not the model weights, input size, or detection thresholds. The page displays previews for at most the first 50 selected and annotated images, but processes the full folder and includes all successful detections in the downloads. On browsers that support the File System Access API (including current desktop Chrome and Edge), the annotated ZIP is streamed to a save location instead of building a second full-size ZIP blob in memory. Other browsers use an in-memory ZIP fallback, which may need substantial free memory for very large folders. Processing time and available memory still depend on the computer and the images' dimensions.

## Prepare or replace the model

The checkpoint is intentionally not published. The checked-in files in `assets/model/` are the browser-ready ONNX model split into pieces smaller than GitHub's per-file size limit.

To rebuild those files after replacing `SAT Asset Detection Model.pt`, use Python 3.10 or newer in a virtual environment:

```powershell
python -m pip install ultralytics onnx
python scripts/prepare_model.py
```

The script exports a 640 × 640 ONNX model and writes the model pieces and class metadata used by the site. If the ONNX file already exists, regenerate just the pieces and metadata with:

```powershell
python scripts/prepare_model.py --skip-export
```

The generated `.onnx` and `.pt` files are ignored by Git. The model pieces under `assets/model/` are the public files that must be committed with the website.

## Publish with GitHub Pages

1. Create a **public** GitHub repository and add these project files, including `assets/model/`.
2. Push the site's default branch as `main`.
3. In the repository, open **Settings → Pages** and choose **GitHub Actions** as the build and deployment source.
4. The workflow in `.github/workflows/deploy-pages.yml` publishes the static site on each push to `main`. The site URL appears in the Pages settings and deployment run.

The ONNX model is about 102 MB and is stored as four smaller files to stay below GitHub's individual file-size limit. A visitor downloads the model on the first detection run. Processing speed depends on the visitor's device and the number and dimensions of their images.

## Results

The workbook has the columns **Image Filename**, **Confidence**, **Asset Type**, **x1**, **y1**, **x2**, and **y2**. Confidence is a decimal (for example, `0.927`) in both the workbook and preview. `(x1, y1)` and `(x2, y2)` are the top-left and bottom-right bounding-box corners, in pixels relative to the original image; coordinates are rounded to two decimal places. Images with no detections receive a `No Detection` row with confidence `0` and blank coordinates.

Annotated images download together in a ZIP file named `Annotated_Asset_ImagesMMDDYY.zip`, containing a folder named `Annotated_Asset_ImagesMMDDYY`. The workbook downloads as `Annotated_Asset_SpreadsheetMMDDYY.xlsx`. The date uses the visitor's local date.
