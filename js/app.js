/**
 * Main application entry point.
 * Handles directory selection, recursive DLT file discovery,
 * step-by-step progress display, and orchestrates parsing → rendering.
 */

'use strict';

import { extractLogs, formatTimestamp } from './extractor.js';
import { initMap, renderLogs, toggleLayer } from './map-viewer.js';

// ---- DOM refs ------------------------------------------------------------ //

const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const browseBtn      = document.getElementById('browse-btn');
const progressSection= document.getElementById('progress-section');
const progressBar    = document.getElementById('progress-bar');
const progressLabel  = document.getElementById('progress-label');
const progressDetail = document.getElementById('progress-detail');
const progressFiles  = document.getElementById('progress-files');
const statsSection   = document.getElementById('stats-section');
const statPoints     = document.getElementById('stat-points');
const statGps        = document.getElementById('stat-gps');
const statDrGps      = document.getElementById('stat-drgps');
const statMmGps      = document.getElementById('stat-mmgps');
const statMmMatch    = document.getElementById('stat-mmmatch');
const statRoute      = document.getElementById('stat-route');
const statTts        = document.getElementById('stat-tts');
const statTimeRange  = document.getElementById('stat-timerange');
const layerPanel     = document.getElementById('layer-panel');

// ---- Layer toggle wiring ------------------------------------------------- //

document.querySelectorAll('[data-layer]').forEach(cb => {
  cb.addEventListener('change', e => {
    toggleLayer(e.target.dataset.layer, e.target.checked);
  });
});

// ---- File drop / browse -------------------------------------------------- //

browseBtn.addEventListener('click', () => fileInput.click());

// webkitdirectory input: all files inside the selected folder arrive at once
fileInput.addEventListener('change', () => {
  const dltFiles = [...fileInput.files].filter(f => f.name.endsWith('.dlt'));
  if (dltFiles.length) handleFiles(dltFiles);
  else alert('선택한 폴더에서 .dlt 파일을 찾을 수 없습니다.');
  fileInput.value = '';
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  setProgress(0, '폴더 스캔 중...', 'DLT 파일을 탐색하고 있습니다.');
  progressSection.hidden = false;
  statsSection.hidden = true;
  layerPanel.hidden = true;
  progressFiles.innerHTML = '';

  const files = await getFilesFromDataTransfer(e.dataTransfer);
  if (files.length) handleFiles(files);
  else {
    setProgress(0, '파일 없음', '드롭한 항목에서 .dlt 파일을 찾을 수 없습니다.');
  }
});

// ---- Directory traversal via DataTransfer API ---------------------------- //

async function getFilesFromDataTransfer(dataTransfer) {
  const files = [];

  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const entries = [];
    for (const item of dataTransfer.items) {
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
    }
    if (entries.length > 0) {
      for (const entry of entries) {
        await collectFromEntry(entry, files);
      }
      return files;
    }
  }

  // Fallback: plain File list
  return [...dataTransfer.files].filter(f => f.name.endsWith('.dlt'));
}

/**
 * Recursively collect .dlt files from a FileSystemEntry.
 */
async function collectFromEntry(entry, files) {
  if (entry.isFile) {
    if (entry.name.endsWith('.dlt')) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push(file);
    }
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) {
        await collectFromEntry(child, files);
      }
    } while (batch.length > 0);
  }
}

// ---- Progress helpers ---------------------------------------------------- //

function setProgress(pct, label, detail = '') {
  progressBar.style.width = `${pct}%`;
  progressBar.setAttribute('aria-valuenow', pct.toFixed(0));
  progressLabel.textContent = label;
  progressDetail.textContent = detail;
}

/**
 * Render the file list panel.
 * @param {string[]} names      display names (relative paths)
 * @param {number}   currentIdx index of the file currently being parsed (-1 = none)
 * @param {number}   doneCount  number of files already finished
 */
function renderFileList(names, currentIdx, doneCount) {
  progressFiles.innerHTML = '';
  names.forEach((name, i) => {
    const row = document.createElement('div');
    let cls, icon;
    if (i < doneCount) {
      cls = 'done';   icon = '✓';
    } else if (i === currentIdx) {
      cls = 'active'; icon = '▶';
    } else {
      cls = 'pending'; icon = '·';
    }
    row.className = `pf-row ${cls}`;
    row.innerHTML = `<span class="pf-icon">${icon}</span><span class="pf-name" title="${name}">${name}</span>`;
    progressFiles.appendChild(row);

    // Auto-scroll to keep active item visible
    if (i === currentIdx) {
      requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
    }
  });
}

// ---- Main flow ----------------------------------------------------------- //

async function handleFiles(dltFiles) {
  if (!dltFiles.length) return;

  progressSection.hidden = false;
  statsSection.hidden = true;
  layerPanel.hidden = true;
  progressFiles.innerHTML = '';

  // --- Step 1: 스캔 완료 표시 ---
  setProgress(0, `[1단계] 스캔 완료`, `DLT 파일 ${dltFiles.length}개 발견 — 분석을 시작합니다.`);

  // Build display names (use webkitRelativePath when available, else file.name)
  const displayNames = dltFiles.map(f =>
    (f.webkitRelativePath && f.webkitRelativePath.length > 0)
      ? f.webkitRelativePath
      : f.name
  );

  renderFileList(displayNames, 0, 0);

  // --- Step 2: 분석 ---
  let lastProgressUpdate = 0;
  let currentFileIdx = 0;
  let currentFilePct = 0;

  function onProgress(filePath, fileIndex, fileCount, overallBytes, totalBytes, fileBytes, fileTotal) {
    const now = Date.now();
    if (now - lastProgressUpdate < 80) return;   // throttle to ~12 fps
    lastProgressUpdate = now;

    currentFileIdx = fileIndex - 1;              // 0-based index of current file
    currentFilePct = fileTotal > 0 ? (fileBytes / fileTotal) * 100 : 0;
    const overallPct = totalBytes > 0 ? (overallBytes / totalBytes) * 100 : 0;

    setProgress(
      overallPct,
      `[2단계] 파일 분석 중 — ${overallPct.toFixed(1)}%`,
      `[${fileIndex}/${fileCount}] ${displayNames[currentFileIdx] ?? filePath}  (${currentFilePct.toFixed(1)}%)`
    );

    renderFileList(displayNames, currentFileIdx, fileIndex - 1);
  }

  try {
    const result = await extractLogs(dltFiles, onProgress);

    // --- Step 3: 완료 ---
    setProgress(100, `[3단계] 분석 완료`, `총 ${dltFiles.length}개 파일 처리 완료`);
    renderFileList(displayNames, -1, dltFiles.length);

    displayResults(result);
  } catch (err) {
    console.error(err);
    setProgress(0, '오류 발생', err.message);
  }
}

// ---- Results display ----------------------------------------------------- //

function displayResults({ locationLogs, mmLogs, routeRequests, ttsLogs }) {
  const gpsCount     = locationLogs.filter(p => p.sourceType === 'gps').length;
  const drGpsCount   = locationLogs.filter(p => p.sourceType === 'dr_gps').length;
  const mmGpsCount   = mmLogs.filter(p => p.sourceType === 'mm_gps').length;
  const mmMatchCount = mmLogs.filter(p => p.sourceType === 'mm_match').length;

  statPoints.textContent   = locationLogs.length;
  statGps.textContent      = gpsCount;
  statDrGps.textContent    = drGpsCount;
  statMmGps.textContent    = mmGpsCount;
  statMmMatch.textContent  = mmMatchCount;
  statRoute.textContent    = routeRequests.length;
  statTts.textContent      = ttsLogs.length;

  const allTimestamps = [
    ...locationLogs.map(p => p.timestamp),
    ...mmLogs.map(p => p.timestamp),
    ...routeRequests.map(r => r.timestamp),
    ...ttsLogs.map(t => t.timestamp),
  ].filter(Boolean).map(t => t.getTime());

  if (allTimestamps.length > 0) {
    const first = new Date(Math.min(...allTimestamps));
    const last  = new Date(Math.max(...allTimestamps));
    statTimeRange.textContent = `${formatTimestamp(first)}\n${formatTimestamp(last)}`;
  } else {
    statTimeRange.textContent = 'N/A';
  }

  statsSection.hidden = false;
  layerPanel.hidden   = false;

  // Map center
  const firstLoc = [...locationLogs, ...mmLogs, ...routeRequests, ...ttsLogs]
    .find(p => (p.lat ?? p.requestLat) != null);
  const center = firstLoc
    ? [firstLoc.lat ?? firstLoc.requestLat, firstLoc.lon ?? firstLoc.requestLon]
    : [37.5665, 126.9780];

  initMap('map', center);
  renderLogs(locationLogs, mmLogs, routeRequests, ttsLogs);
}
