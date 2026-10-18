(() => {
  "use strict";

  const IMAGE_SIZE = 640;
  const CONFIDENCE_THRESHOLD = 0.25;
  const IOU_THRESHOLD = 0.7;
  const MAX_DETECTIONS = 300;
  const PREVIEW_LIMIT = 50;
  const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]);
  const SPREADSHEET_HEADERS = ["Image Filename", "Confidence", "Asset Type"];

  const elements = {
    singleMode: document.querySelector("#single-mode"),
    folderMode: document.querySelector("#folder-mode"),
    dropZone: document.querySelector("#drop-zone"),
    dropTitle: document.querySelector("#drop-title"),
    dropHint: document.querySelector("#drop-hint"),
    imageInput: document.querySelector("#image-input"),
    imageFilesInput: document.querySelector("#image-files-input"),
    folderFilePicker: document.querySelector("#folder-file-picker"),
    browseImagesButton: document.querySelector("#browse-images-button"),
    selectionCount: document.querySelector("#selection-count"),
    selectedPreviewNote: document.querySelector("#selected-preview-note"),
    selectedGrid: document.querySelector("#selected-grid"),
    resetButton: document.querySelector("#reset-button"),
    runButton: document.querySelector("#run-button"),
    statusBadge: document.querySelector("#status-badge"),
    progressArea: document.querySelector("#progress-area"),
    progressLabel: document.querySelector("#progress-label"),
    progressValue: document.querySelector("#progress-value"),
    progressTrack: document.querySelector("#progress-track"),
    progressBar: document.querySelector("#progress-bar"),
    errorMessage: document.querySelector("#error-message"),
    successMessage: document.querySelector("#success-message"),
    resultsGrid: document.querySelector("#results-grid"),
    resultsPreviewNote: document.querySelector("#results-preview-note"),
    downloadImages: document.querySelector("#download-images"),
    downloadSpreadsheet: document.querySelector("#download-spreadsheet"),
    spreadsheetPreview: document.querySelector("#spreadsheet-preview"),
    tableNote: document.querySelector("#table-note"),
  };

  let uploadMode = "single";
  let selectedFiles = [];
  let modelSession;
  let modelMetadata;
  let modelExecutionProvider = "wasm";
  let modelThreadCount = 1;
  let annotatedImages = [];
  let spreadsheetRows = [];
  let isProcessing = false;

  function setStatus(message, state = "") {
    elements.statusBadge.textContent = message;
    elements.statusBadge.className = `status-badge${state ? ` ${state}` : ""}`;
  }

  function setProgress(message, percent) {
    const normalized = Math.max(0, Math.min(100, percent));
    elements.progressArea.hidden = false;
    elements.progressLabel.textContent = message;
    elements.progressValue.textContent = `${Math.round(normalized)}%`;
    elements.progressTrack.setAttribute("aria-valuenow", String(Math.round(normalized)));
    elements.progressBar.style.width = `${normalized}%`;
  }

  function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorMessage.hidden = false;
  }

  function formatDuration(milliseconds) {
    return milliseconds >= 1000
      ? `${(milliseconds / 1000).toFixed(1)} s`
      : `${Math.round(milliseconds)} ms`;
  }

  function clearMessages() {
    elements.errorMessage.hidden = true;
    elements.errorMessage.textContent = "";
    elements.successMessage.hidden = true;
    elements.successMessage.textContent = "";
  }

  function setUploadMode(mode) {
    if (isProcessing) {
      return;
    }
    uploadMode = mode;
    const isSingle = mode === "single";
    elements.singleMode.classList.toggle("active", isSingle);
    elements.singleMode.setAttribute("aria-pressed", String(isSingle));
    elements.folderMode.classList.toggle("active", !isSingle);
    elements.folderMode.setAttribute("aria-pressed", String(!isSingle));
    elements.folderFilePicker.hidden = isSingle;
    elements.imageInput.multiple = !isSingle;
    if (isSingle) {
      elements.imageInput.removeAttribute("webkitdirectory");
      elements.imageInput.setAttribute("accept", "image/jpeg,image/png,image/webp,image/bmp");
      elements.dropTitle.textContent = "Choose an image to get started";
      elements.dropHint.textContent = "JPG, PNG, WebP, or BMP";
    } else {
      elements.imageInput.setAttribute("webkitdirectory", "");
      elements.imageInput.removeAttribute("accept");
      elements.dropTitle.textContent = "Choose a folder of images";
      elements.dropHint.textContent = "Images inside the selected folder will be included";
    }
    elements.imageInput.value = "";
    elements.imageFilesInput.value = "";
    setSelectedFiles([]);
  }

  function setSelectedFiles(files) {
    if (isProcessing) {
      return;
    }
    selectedFiles = files
      .filter((file) => SUPPORTED_TYPES.has(file.type) || /\.(jpe?g|png|webp|bmp)$/i.test(file.name))
      .sort((left, right) => imageFilename(left).localeCompare(imageFilename(right)));
    clearMessages();
    resetResults();
    renderSelectedImages();
    elements.runButton.disabled = selectedFiles.length === 0;
    elements.selectionCount.textContent = `${selectedFiles.length} ${selectedFiles.length === 1 ? "image" : "images"}`;
    elements.resetButton.disabled = false;

    if (files.length > 0 && selectedFiles.length === 0) {
      showError("No supported images were found. Please select JPG, PNG, WebP, or BMP images.");
      setStatus("No supported images");
      return;
    }

    if (files.length !== selectedFiles.length) {
      showError(`${files.length - selectedFiles.length} unsupported file${files.length - selectedFiles.length === 1 ? " was" : "s were"} skipped. Supported formats are JPG, PNG, WebP, and BMP.`);
    }
    setStatus(selectedFiles.length ? "Ready to detect" : "Waiting for images", selectedFiles.length ? "ready" : "");
  }

  function resetInput() {
    if (isProcessing) {
      return;
    }
    elements.imageInput.value = "";
    elements.imageFilesInput.value = "";
    setSelectedFiles([]);
    elements.selectionCount.textContent = "0 images";
    elements.resetButton.disabled = false;
    setStatus("Waiting for images");
  }

  function imageFilename(file) {
    return file.webkitRelativePath || file.name;
  }

  function resetResults() {
    annotatedImages = [];
    spreadsheetRows = [];
    elements.progressArea.hidden = true;
    elements.successMessage.hidden = true;
    elements.resultsGrid.innerHTML = '<p class="empty-state">Annotated previews will appear here after detection.</p>';
    elements.resultsPreviewNote.hidden = true;
    elements.spreadsheetPreview.innerHTML = '<tr><td class="empty-table" colspan="3">The spreadsheet preview will appear here after detection.</td></tr>';
    elements.downloadImages.disabled = true;
    elements.downloadSpreadsheet.disabled = true;
    elements.tableNote.hidden = true;
  }

  function renderSelectedImages() {
    elements.selectedGrid.replaceChildren();
    if (selectedFiles.length === 0) {
      elements.selectedGrid.innerHTML = '<p class="empty-state">Your image previews will appear here.</p>';
      elements.selectedPreviewNote.hidden = true;
      return;
    }

    const fragment = document.createDocumentFragment();
    const previewFiles = selectedFiles.slice(0, PREVIEW_LIMIT);
    for (const file of previewFiles) {
      const card = document.createElement("article");
      card.className = "image-card";
      const image = document.createElement("img");
      const caption = document.createElement("p");
      image.alt = `Preview of ${imageFilename(file)}`;
      image.loading = "lazy";
      image.decoding = "async";
      image.src = URL.createObjectURL(file);
      image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
      image.addEventListener("error", () => URL.revokeObjectURL(image.src), { once: true });
      caption.className = "image-caption";
      caption.textContent = imageFilename(file);
      caption.title = imageFilename(file);
      card.append(image, caption);
      fragment.append(card);
    }
    elements.selectedGrid.append(fragment);
    elements.selectedPreviewNote.hidden = selectedFiles.length <= PREVIEW_LIMIT;
    elements.selectedPreviewNote.textContent = `Showing previews for the first ${PREVIEW_LIMIT} of ${selectedFiles.length} selected images. All selected images will be processed.`;
  }

  function drawImagePreview(container, imageBlob, filename) {
    const card = document.createElement("article");
    card.className = "image-card";
    const image = document.createElement("img");
    const caption = document.createElement("p");
    image.alt = `Annotated preview of ${filename}`;
    image.loading = "lazy";
    image.decoding = "async";
    image.src = URL.createObjectURL(imageBlob);
    image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
    image.addEventListener("error", () => URL.revokeObjectURL(image.src), { once: true });
    caption.className = "image-caption";
    caption.textContent = filename;
    caption.title = filename;
    card.append(image, caption);
    container.append(card);
  }

  async function loadModel() {
    if (modelSession) {
      return modelSession;
    }
    if (!window.ort || !window.XLSX || !window.JSZip) {
      throw new Error("A required browser library could not be loaded. Refresh the page and check your internet connection.");
    }

    window.ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
    window.ort.env.wasm.numThreads = window.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 1)
      : 1;
    modelThreadCount = window.ort.env.wasm.numThreads;
    if (window.ort.env.webgpu) {
      window.ort.env.webgpu.powerPreference = "high-performance";
    }
    const metadataResponse = await fetch("./assets/model/metadata.json", { cache: "no-cache" });
    if (!metadataResponse.ok) {
      throw new Error(`Could not load model metadata (HTTP ${metadataResponse.status}).`);
    }
    modelMetadata = await metadataResponse.json();
    if (
      !Array.isArray(modelMetadata.classNames) ||
      modelMetadata.classNames.length === 0 ||
      modelMetadata.inputSize !== IMAGE_SIZE
    ) {
      throw new Error("The model metadata does not match the expected detection model.");
    }
    if (
      !Number.isInteger(modelMetadata.partCount) ||
      modelMetadata.partCount < 1 ||
      !Array.isArray(modelMetadata.partSizes) ||
      modelMetadata.partSizes.length !== modelMetadata.partCount ||
      typeof modelMetadata.modelVersion !== "string" ||
      !Array.isArray(modelMetadata.partHashes) ||
      modelMetadata.partHashes.length !== modelMetadata.partCount
    ) {
      throw new Error("The model asset package is incomplete or out of date.");
    }
    if (
      modelMetadata.dynamicBatch &&
      (!Number.isInteger(modelMetadata.maxBatchSize) || modelMetadata.maxBatchSize < 1)
    ) {
      throw new Error("The model's batch configuration is invalid.");
    }

    const parts = [];
    let totalBytes = 0;
    for (let index = 0; index < modelMetadata.partCount; index += 1) {
      const partUrl = `./assets/model/model-part-${String(index + 1).padStart(3, "0")}.bin?v=${modelMetadata.modelVersion}`;
      const response = await fetch(partUrl, { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`Could not load model file ${index + 1} of ${modelMetadata.partCount} (HTTP ${response.status}).`);
      }
      const part = await response.arrayBuffer();
      if (part.byteLength !== modelMetadata.partSizes[index]) {
        throw new Error(`Model file ${index + 1} has an unexpected size. Please refresh and try again.`);
      }
      if (window.crypto?.subtle) {
        const digest = await window.crypto.subtle.digest("SHA-256", part);
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (hash !== modelMetadata.partHashes[index]) {
          throw new Error(`Model file ${index + 1} failed its integrity check. Refresh the page and try again.`);
        }
      }
      parts.push(new Uint8Array(part));
      totalBytes += part.byteLength;
      setProgress(`Loading detection model (${index + 1} of ${modelMetadata.partCount})…`, totalBytes / modelMetadata.modelBytes * 25);
    }

    if (totalBytes !== modelMetadata.modelBytes) {
      throw new Error("The downloaded model files are incomplete. Please refresh and try again.");
    }
    const modelBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const part of parts) {
      modelBytes.set(part, offset);
      offset += part.byteLength;
    }

    const sessionOptions = { graphOptimizationLevel: "all" };
    const requestedProvider = new URLSearchParams(window.location.search).get("provider");
    if (requestedProvider === "wasm") {
      setProgress(
        modelThreadCount > 1
          ? `Starting CPU inference with ${modelThreadCount} WASM threads…`
          : "Starting CPU inference with one WASM thread…",
        28,
      );
      modelSession = await window.ort.InferenceSession.create(modelBytes, {
        ...sessionOptions,
        executionProviders: ["wasm"],
      });
      modelExecutionProvider = "wasm";
    } else if (window.isSecureContext && navigator.gpu) {
      setProgress("Starting the detection model with WebGPU…", 28);
      try {
        modelSession = await window.ort.InferenceSession.create(modelBytes, {
          ...sessionOptions,
          executionProviders: ["webgpu"],
        });
        modelExecutionProvider = "webgpu";
      } catch (webgpuError) {
        setProgress("WebGPU could not be initialized; starting the CPU fallback…", 28);
        try {
          modelSession = await window.ort.InferenceSession.create(modelBytes, {
            ...sessionOptions,
            executionProviders: ["wasm"],
          });
          modelExecutionProvider = "wasm";
        } catch (wasmError) {
          throw new Error(
            `WebGPU initialization failed (${webgpuError.message || "unknown error"}); the CPU fallback also failed (${wasmError.message || "unknown error"}).`,
          );
        }
      }
    } else {
      setProgress("Starting the detection model with the CPU runtime…", 28);
      modelSession = await window.ort.InferenceSession.create(modelBytes, {
        ...sessionOptions,
        executionProviders: ["wasm"],
      });
      modelExecutionProvider = "wasm";
    }
    if (modelSession.inputNames.length !== 1 || modelSession.outputNames.length < 1) {
      throw new Error("The model has an unsupported input or output format.");
    }
    return modelSession;
  }

  async function prepareImage(file) {
    const bitmap = await createImageBitmap(file);
    try {
      const originalWidth = bitmap.width;
      const originalHeight = bitmap.height;
      const scale = Math.min(IMAGE_SIZE / originalWidth, IMAGE_SIZE / originalHeight);
      const resizedWidth = Math.round(originalWidth * scale);
      const resizedHeight = Math.round(originalHeight * scale);
      const left = Math.round((IMAGE_SIZE - resizedWidth) / 2 - 0.1);
      const top = Math.round((IMAGE_SIZE - resizedHeight) / 2 - 0.1);
      const canvas = document.createElement("canvas");
      canvas.width = IMAGE_SIZE;
      canvas.height = IMAGE_SIZE;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("This browser could not prepare the image for detection.");
      }
      context.fillStyle = "rgb(114, 114, 114)";
      context.fillRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
      context.drawImage(bitmap, left, top, resizedWidth, resizedHeight);
      const pixels = context.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
      const planeSize = IMAGE_SIZE * IMAGE_SIZE;
      const input = new Float32Array(3 * planeSize);
      for (let pixel = 0; pixel < planeSize; pixel += 1) {
        const sourceIndex = pixel * 4;
        input[pixel] = pixels[sourceIndex] / 255;
        input[planeSize + pixel] = pixels[sourceIndex + 1] / 255;
        input[2 * planeSize + pixel] = pixels[sourceIndex + 2] / 255;
      }
      return {
        tensor: new window.ort.Tensor("float32", input, [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
        originalWidth,
        originalHeight,
        resizedWidth,
        resizedHeight,
        left,
        top,
        bitmap,
      };
    } catch (error) {
      bitmap.close();
      throw error;
    }
  }

  function intersectionOverUnion(left, right) {
    const width = Math.max(0, Math.min(left.x2, right.x2) - Math.max(left.x1, right.x1));
    const height = Math.max(0, Math.min(left.y2, right.y2) - Math.max(left.y1, right.y1));
    const intersection = width * height;
    const leftArea = Math.max(0, left.x2 - left.x1) * Math.max(0, left.y2 - left.y1);
    const rightArea = Math.max(0, right.x2 - right.x1) * Math.max(0, right.y2 - right.y1);
    return intersection / Math.max(leftArea + rightArea - intersection, Number.EPSILON);
  }

  function suppressOverlaps(candidates) {
    candidates.sort((left, right) => right.confidence - left.confidence);
    candidates = candidates.slice(0, 30000);
    const byClass = new Map();
    for (const candidate of candidates) {
      if (!byClass.has(candidate.classIndex)) {
        byClass.set(candidate.classIndex, []);
      }
      byClass.get(candidate.classIndex).push(candidate);
    }

    const kept = [];
    for (const classCandidates of byClass.values()) {
      classCandidates.sort((left, right) => right.confidence - left.confidence);
      const selected = [];
      for (const candidate of classCandidates) {
        if (selected.every((existing) => intersectionOverUnion(existing, candidate) <= IOU_THRESHOLD)) {
          selected.push(candidate);
          kept.push(candidate);
        }
      }
    }
    return kept.sort((left, right) => right.confidence - left.confidence).slice(0, MAX_DETECTIONS);
  }

  function decodeDetections(tensorResult, imageInfo) {
    const output = tensorResult.data;
    const dimensions = tensorResult.dims;
    const classCount = modelMetadata.classNames.length;
    const batchIndex = imageInfo.batchIndex || 0;
    let anchors;
    let channels;
    let channelsFirst;
    if (dimensions.length !== 3 || batchIndex >= dimensions[0]) {
      throw new Error(`The model returned an unsupported output shape: ${dimensions.join(" × ")}.`);
    }
    if (dimensions[1] === classCount + 4) {
      channels = dimensions[1];
      anchors = dimensions[2];
      channelsFirst = true;
    } else if (dimensions[2] === classCount + 4) {
      anchors = dimensions[1];
      channels = dimensions[2];
      channelsFirst = false;
    } else {
      throw new Error(`The model returned an unexpected detection shape: ${dimensions.join(" × ")}.`);
    }

    const batchOffset = batchIndex * channels * anchors;
    const getValue = (anchor, channel) =>
      batchOffset + (channelsFirst ? channel * anchors + anchor : anchor * channels + channel);
    const scaleX = imageInfo.originalWidth / imageInfo.resizedWidth;
    const scaleY = imageInfo.originalHeight / imageInfo.resizedHeight;
    const candidates = [];
    let maxConfidence = 0;
    for (let anchor = 0; anchor < anchors; anchor += 1) {
      let classIndex = -1;
      let confidence = CONFIDENCE_THRESHOLD;
      for (let classChannel = 0; classChannel < classCount; classChannel += 1) {
        const score = output[getValue(anchor, classChannel + 4)];
        maxConfidence = Math.max(maxConfidence, score);
        if (score > confidence) {
          confidence = score;
          classIndex = classChannel;
        }
      }
      if (classIndex < 0) {
        continue;
      }

      const centerX = output[getValue(anchor, 0)];
      const centerY = output[getValue(anchor, 1)];
      const width = output[getValue(anchor, 2)];
      const height = output[getValue(anchor, 3)];
      candidates.push({
        classIndex,
        confidence,
        x1: Math.max(0, Math.min(imageInfo.originalWidth, (centerX - width / 2 - imageInfo.left) * scaleX)),
        y1: Math.max(0, Math.min(imageInfo.originalHeight, (centerY - height / 2 - imageInfo.top) * scaleY)),
        x2: Math.max(0, Math.min(imageInfo.originalWidth, (centerX + width / 2 - imageInfo.left) * scaleX)),
        y2: Math.max(0, Math.min(imageInfo.originalHeight, (centerY + height / 2 - imageInfo.top) * scaleY)),
      });
    }
    return { detections: suppressOverlaps(candidates), maxConfidence };
  }

  function annotateImage(bitmap, detections) {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("This browser could not draw the annotated image.");
    }
    context.drawImage(bitmap, 0, 0);
    const lineWidth = Math.max(2, Math.min(canvas.width, canvas.height) / 260);
    const fontSize = Math.max(14, Math.min(canvas.width, canvas.height) / 38);
    context.lineWidth = lineWidth;
    context.font = `600 ${fontSize}px Arial, sans-serif`;
    context.textBaseline = "top";

    for (const detection of detections) {
      const label = `${modelMetadata.classNames[detection.classIndex]} ${(detection.confidence * 100).toFixed(1)}%`;
      const textWidth = context.measureText(label).width;
      const labelHeight = fontSize + 8;
      context.strokeStyle = "#f07a24";
      context.fillStyle = "rgba(232, 117, 36, 0.12)";
      context.fillRect(detection.x1, detection.y1, detection.x2 - detection.x1, detection.y2 - detection.y1);
      context.strokeRect(detection.x1, detection.y1, detection.x2 - detection.x1, detection.y2 - detection.y1);
      const labelY = Math.max(0, detection.y1 - labelHeight);
      context.fillStyle = "#e87524";
      context.fillRect(detection.x1, labelY, textWidth + 10, labelHeight);
      context.fillStyle = "#fff";
      const labelX = Math.min(detection.x1, Math.max(0, canvas.width - textWidth - 10));
      context.fillText(label, labelX + 5, labelY + 4);
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("The annotated image could not be generated."));
          }
        },
        "image/jpeg",
        0.92,
      );
    });
  }

  function resultPath(filename) {
    const parts = filename.split("/");
    const originalName = parts.pop();
    const extension = originalName.includes(".") ? originalName.split(".").pop().toLowerCase() : "image";
    const stem = originalName.replace(/\.[^.]*$/, "");
    parts.push(`${stem}_${extension}_annotated.jpg`);
    return parts.join("/");
  }

  async function detectBatch(files, session) {
    const preparedImages = [];
    const failures = [];
    let preparationMs = 0;
    let inferenceMs = 0;
    let decodeMs = 0;
    let annotationMs = 0;
    let maxConfidence = 0;
    const planeSize = IMAGE_SIZE * IMAGE_SIZE;
    const inputSize = 3 * planeSize;

    for (const file of files) {
      const start = performance.now();
      try {
        preparedImages.push({ file, prepared: await prepareImage(file) });
      } catch (error) {
        failures.push({
          file,
          message: error.message || "Could not prepare this image.",
        });
      } finally {
        preparationMs += performance.now() - start;
      }
    }

    if (preparedImages.length === 0) {
      return { results: [], failures, maxConfidence, timings: { preparationMs, inferenceMs, decodeMs, annotationMs } };
    }

    const batchData = new Float32Array(preparedImages.length * inputSize);
    for (const [index, item] of preparedImages.entries()) {
      batchData.set(item.prepared.tensor.data, index * inputSize);
      item.prepared.tensor.dispose();
    }
    const batchTensor = new window.ort.Tensor(
      "float32",
      batchData,
      [preparedImages.length, 3, IMAGE_SIZE, IMAGE_SIZE],
    );
    let outputs;
    let outputTensor;
    let inferenceError;
    try {
      const inferenceStart = performance.now();
      outputs = await session.run({ [session.inputNames[0]]: batchTensor });
      inferenceMs = performance.now() - inferenceStart;
      outputTensor = outputs[session.outputNames[0]];
    } catch (error) {
      inferenceError = error;
    } finally {
      batchTensor.dispose();
    }
    if (inferenceError) {
      for (const item of preparedImages) {
        item.prepared.bitmap.close();
        failures.push({
          file: item.file,
          message: `Batch inference failed: ${inferenceError.message || "Unknown model error"}`,
        });
      }
      return { results: [], failures, maxConfidence, timings: { preparationMs, inferenceMs, decodeMs, annotationMs } };
    }

    const results = [];
    try {
      for (const [batchIndex, item] of preparedImages.entries()) {
        try {
          const decodeStart = performance.now();
          const decoded = decodeDetections(outputTensor, {
            batchIndex,
            originalWidth: item.prepared.originalWidth,
            originalHeight: item.prepared.originalHeight,
            resizedWidth: item.prepared.resizedWidth,
            resizedHeight: item.prepared.resizedHeight,
            left: item.prepared.left,
            top: item.prepared.top,
          });
          maxConfidence = Math.max(maxConfidence, decoded.maxConfidence);
          const detections = decoded.detections;
          decodeMs += performance.now() - decodeStart;
          const filename = imageFilename(item.file);
          const annotationStart = performance.now();
          const annotatedBlob = await annotateImage(item.prepared.bitmap, detections);
          annotationMs += performance.now() - annotationStart;
          const rows = detections.length
            ? detections.map((detection) => ({
                "Image Filename": filename,
                Confidence: Math.round(detection.confidence * 1000) / 1000,
                "Asset Type": modelMetadata.classNames[detection.classIndex],
              }))
            : [{ "Image Filename": filename, Confidence: 0, "Asset Type": "No Detection" }];
          results.push({
            file: item.file,
            imageResult: { blob: annotatedBlob, filename, archivePath: resultPath(filename) },
            rows,
            detectionCount: detections.length,
          });
        } catch (error) {
          failures.push({
            file: item.file,
            message: error.message || "Could not process this image.",
          });
        } finally {
          item.prepared.bitmap.close();
        }
      }
    } finally {
      outputTensor.dispose();
    }

    return {
      results,
      failures,
      timings: {
        preparationMs,
        inferenceMs,
        decodeMs,
        annotationMs,
        maxConfidence,
      },
    };
  }

  function renderSpreadsheetPreview(rows) {
    elements.spreadsheetPreview.replaceChildren();
    if (rows.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 3;
      cell.className = "empty-table";
      cell.textContent = "No images were processed.";
      row.append(cell);
      elements.spreadsheetPreview.append(row);
      return;
    }

    const previewRows = rows.slice(0, 100);
    const fragment = document.createDocumentFragment();
    for (const result of previewRows) {
      const row = document.createElement("tr");
      for (const [index, header] of SPREADSHEET_HEADERS.entries()) {
        const cell = document.createElement("td");
        const value = result[header];
        cell.textContent = header === "Confidence" && result["Asset Type"] !== "No Detection"
          ? `${(value * 100).toFixed(1)}%`
          : String(value);
        row.append(cell);
      }
      fragment.append(row);
    }
    elements.spreadsheetPreview.append(fragment);
    elements.tableNote.hidden = rows.length <= previewRows.length;
    elements.tableNote.textContent = `Showing the first ${previewRows.length} of ${rows.length} spreadsheet rows. Download the workbook to view all results.`;
  }

  async function runDetection() {
    if (selectedFiles.length === 0) {
      return;
    }
    clearMessages();
    isProcessing = true;
    elements.singleMode.disabled = true;
    elements.folderMode.disabled = true;
    elements.imageInput.disabled = true;
    elements.imageFilesInput.disabled = true;
    elements.browseImagesButton.disabled = true;
    elements.resetButton.disabled = true;
    elements.runButton.disabled = true;
    elements.downloadImages.disabled = true;
    elements.downloadSpreadsheet.disabled = true;
    annotatedImages = [];
    spreadsheetRows = [];
    elements.resultsGrid.replaceChildren();
    elements.resultsPreviewNote.hidden = selectedFiles.length <= PREVIEW_LIMIT;
    elements.resultsPreviewNote.textContent = `Showing previews for the first ${PREVIEW_LIMIT} images only. The ZIP and spreadsheet include results for the full folder.`;
    elements.spreadsheetPreview.innerHTML = '<tr><td class="empty-table" colspan="3">Detection is running…</td></tr>';
    setStatus("Loading model", "busy");
    let failedCount = 0;
    let detectionCount = 0;
    let preparationMs = 0;
    let inferenceMs = 0;
    let decodeMs = 0;
    let annotationMs = 0;
    let maxConfidence = 0;
    const imageErrors = [];
    const batchStart = performance.now();

    try {
      const modelLoadStart = performance.now();
      const session = await loadModel();
      const modelLoadMs = performance.now() - modelLoadStart;
      const batchSize = modelMetadata.dynamicBatch ? modelMetadata.maxBatchSize : 1;
      const processingStart = performance.now();
      const selectedFileIndexes = new Map(selectedFiles.map((file, index) => [file, index]));
      const providerLabel = modelExecutionProvider === "wasm"
        ? `WASM, ${modelThreadCount} thread${modelThreadCount === 1 ? "" : "s"}`
        : modelExecutionProvider;
      setStatus(`Detecting (${providerLabel}, batch ${batchSize})`, "busy");
      for (let index = 0; index < selectedFiles.length; index += batchSize) {
        const files = selectedFiles.slice(index, index + batchSize);
        const lastIndex = index + files.length;
        setProgress(
          `Detecting images ${index + 1}–${lastIndex} of ${selectedFiles.length}…`,
          28 + (lastIndex / selectedFiles.length) * 70,
        );
        if (index > 0 && index % 10 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const batch = await detectBatch(files, session);
        preparationMs += batch.timings.preparationMs;
        inferenceMs += batch.timings.inferenceMs;
        decodeMs += batch.timings.decodeMs;
        annotationMs += batch.timings.annotationMs;
        maxConfidence = Math.max(maxConfidence, batch.timings.maxConfidence);
        for (const result of batch.results) {
          annotatedImages.push(result.imageResult);
          spreadsheetRows.push(...result.rows);
          detectionCount += result.detectionCount;
          const imageIndex = selectedFileIndexes.get(result.file);
          if (imageIndex < PREVIEW_LIMIT) {
            drawImagePreview(elements.resultsGrid, result.imageResult.blob, imageFilename(result.file));
          }
        }
        for (const failure of batch.failures) {
          failedCount += 1;
          if (imageErrors.length < PREVIEW_LIMIT) {
            imageErrors.push(`${imageFilename(failure.file)} — ${failure.message}`);
          }
        }
      }

      for (const message of imageErrors) {
        const card = document.createElement("p");
        card.className = "empty-state";
        card.textContent = message;
        elements.resultsGrid.append(card);
      }
      renderSpreadsheetPreview(spreadsheetRows);
      elements.downloadImages.disabled = annotatedImages.length === 0;
      elements.downloadSpreadsheet.disabled = spreadsheetRows.length === 0;
      elements.progressArea.hidden = true;
      elements.successMessage.hidden = false;
      const summary = `${selectedFiles.length - failedCount} of ${selectedFiles.length} images processed; ${detectionCount} asset${detectionCount === 1 ? "" : "s"} detected.`;
      const elapsedMs = performance.now() - batchStart;
      const processingElapsedMs = performance.now() - processingStart;
      const processedCount = selectedFiles.length - failedCount;
      const average = (time) => formatDuration(time / Math.max(1, processedCount));
      const throughput = (processedCount * 1000 / Math.max(1, processingElapsedMs)).toFixed(2);
      const performanceSummary = `Total: ${formatDuration(elapsedMs)}; model startup: ${formatDuration(modelLoadMs)}; throughput: ${throughput} images/s; highest model score: ${(maxConfidence * 100).toFixed(2)}% (detection threshold ${CONFIDENCE_THRESHOLD * 100}%); per image avg — preparation ${average(preparationMs)}, inference ${average(inferenceMs)}, decode ${average(decodeMs)}, annotation ${average(annotationMs)}.`;
      elements.successMessage.textContent = failedCount
        ? `${summary} ${failedCount} image${failedCount === 1 ? " could" : "s could"} not be processed; the annotated image area lists up to ${PREVIEW_LIMIT} errors. ${performanceSummary}`
        : `${summary} ${performanceSummary}`;
      if (failedCount) {
        elements.successMessage.classList.add("partial");
      } else {
        elements.successMessage.classList.remove("partial");
      }
      setStatus(
        failedCount ? "Finished with errors" : `Detection complete (${providerLabel})`,
        failedCount ? "" : "ready",
      );
    } catch (error) {
      elements.progressArea.hidden = true;
      showError(error.message || "Detection could not be completed. Please try again.");
      setStatus("Detection failed");
    } finally {
      isProcessing = false;
      elements.singleMode.disabled = false;
      elements.folderMode.disabled = false;
      elements.imageInput.disabled = false;
      elements.imageFilesInput.disabled = false;
      elements.browseImagesButton.disabled = false;
      elements.resetButton.disabled = false;
      elements.runButton.disabled = selectedFiles.length === 0;
    }
  }

  function dateStamp() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const year = String(now.getFullYear()).slice(-2);
    return `${month}${day}${year}`;
  }

  async function downloadAnnotatedImages() {
    if (annotatedImages.length === 0) {
      return;
    }
    elements.downloadImages.disabled = true;
    try {
      const zip = new window.JSZip();
      const folderName = `Annotated_Asset_Images${dateStamp()}`;
      const folder = zip.folder(folderName);
      for (const image of annotatedImages) {
        folder.file(image.archivePath, image.blob);
      }
      const filename = `${folderName}.zip`;
      if (typeof window.showSaveFilePicker === "function") {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
        });
        const writable = await fileHandle.createWritable();
        const stream = zip.generateInternalStream({
          type: "uint8array",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
          streamFiles: true,
        });
        await new Promise((resolve, reject) => {
          let writeChain = Promise.resolve();
          let settled = false;
          const fail = (error) => {
            if (settled) {
              return;
            }
            settled = true;
            writable.abort(error).catch(() => {});
            reject(error);
          };
          // Pause ZIP generation while each output chunk is written to disk.
          stream.on("data", (chunk) => {
            stream.pause();
            writeChain = writeChain
              .then(() => writable.write(chunk))
              .then(() => {
                if (!settled) {
                  stream.resume();
                }
              })
              .catch(fail);
          });
          stream.on("error", fail);
          stream.on("end", () => {
            writeChain
              .then(() => writable.close())
              .then(() => {
                settled = true;
                resolve();
              })
              .catch(fail);
          });
          stream.resume();
        });
      } else {
        const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
        downloadBlob(archive, filename);
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        showError(`The annotated image archive could not be created: ${error.message || "Unknown error"}`);
      }
    } finally {
      elements.downloadImages.disabled = annotatedImages.length === 0;
    }
  }

  function downloadSpreadsheet() {
    if (spreadsheetRows.length === 0) {
      return;
    }
    const worksheet = window.XLSX.utils.json_to_sheet(spreadsheetRows, { header: SPREADSHEET_HEADERS });
    worksheet["!cols"] = [{ wch: 44 }, { wch: 14 }, { wch: 34 }];
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, "Asset Detections");
    window.XLSX.writeFile(workbook, `Annotated_Asset_Spreadsheet${dateStamp()}.xlsx`);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  elements.singleMode.addEventListener("click", () => setUploadMode("single"));
  elements.folderMode.addEventListener("click", () => setUploadMode("folder"));
  elements.imageInput.addEventListener("change", () => setSelectedFiles(Array.from(elements.imageInput.files || [])));
  elements.browseImagesButton.addEventListener("click", () => elements.imageFilesInput.click());
  elements.imageFilesInput.addEventListener("change", () => setSelectedFiles(Array.from(elements.imageFilesInput.files || [])));
  elements.resetButton.addEventListener("click", resetInput);
  elements.runButton.addEventListener("click", runDetection);
  elements.downloadImages.addEventListener("click", downloadAnnotatedImages);
  elements.downloadSpreadsheet.addEventListener("click", downloadSpreadsheet);

  elements.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("drag-over");
  });
  elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("drag-over"));
  elements.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("drag-over");
    if (isProcessing) {
      return;
    }
    const files = Array.from(event.dataTransfer.files || []);
    if (uploadMode === "single" && files.length > 1) {
      setSelectedFiles(files.slice(0, 1));
      showError("Single image mode accepts one image. The first supported image was selected.");
      return;
    }
    setSelectedFiles(files);
  });
})();
