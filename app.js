let peer = null;
let connection = null;

const statusDiv = document.getElementById('status');
const sendFileBtn = document.getElementById('sendFile');
const fileInput = document.getElementById('fileInput');
const progress = document.getElementById('progress');
const transferStatus = document.getElementById('transferStatus');

const CHUNK_SIZE = 262144;
const MIN_CHUNK_SIZE = 32768;
const MAX_CHUNK_SIZE = 1048576;
let currentChunkSize = CHUNK_SIZE;
let lastTransferSpeed = 0;

let transferStartTime = 0;
let lastUpdateTime = 0;
let lastBytes = 0;

let sendQueue = [];
let isProcessingQueue = false;
let currentFileId = null;
let receivedChunks = new Map();
let expectedChunkIndex = 0;
let totalReceivedSize = 0;

let windowSize = 10;
const MAX_WINDOW_SIZE = 50;
const MIN_WINDOW_SIZE = 5;
let retryCount = new Map();
const MAX_RETRIES = 3;
let lastAdjustmentTime = 0;
const ADJUSTMENT_INTERVAL = 2000;
let consecutiveTimeouts = 0;

let fileQueue = [];
let isTransferring = false;

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    seconds = Math.round(seconds % 60);
    return `${minutes}m ${seconds}s`;
}

function updateTransferStatus(transferred, total, isReceiving = false, filename = '') {
    const now = Date.now();
    const timeSinceLastUpdate = (now - lastUpdateTime) / 1000;
    
    if (timeSinceLastUpdate >= 0.5) {
        const bytesPerSecond = (transferred - lastBytes) / timeSinceLastUpdate;
        const remainingBytes = Math.max(total - transferred, 0);
        const remainingTime = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : 0;
        
        const speed = formatBytes(bytesPerSecond) + '/s';
        const progress = Math.min(Math.round((transferred / total) * 100), 100);
        const timeLeft = remainingTime > 0 ? formatTime(remainingTime) : '0s';
        
        const currentFile = filename ? ` | File: ${filename}` : '';
        transferStatus.textContent = `${isReceiving ? 'Receiving' : 'Sending'}: ${formatBytes(Math.min(transferred, total))} / ${formatBytes(total)} (${progress}%) | ${speed} | ETA: ${timeLeft}${currentFile}`;
        
        lastBytes = transferred;
        lastUpdateTime = now;
    }
}

function updateStatus(message, className = '') {
    if (message) {
        statusDiv.textContent = message;
        statusDiv.className = className || 'mt-8 glass-morphism rounded-xl p-6 text-center text-blue-200 transform transition-all duration-300';
        statusDiv.style.display = 'block';
    } else {
        statusDiv.style.display = 'none';
    }
}

document.getElementById('createPeer').addEventListener('click', () => {
    const peerId = document.getElementById('peerId').value || Math.random().toString(36).substring(2, 6);
    peer = new Peer(peerId);
    
    peer.on('open', (id) => {
        updateStatus(`Your peer ID is: ${id}`);
    });

    peer.on('connection', (conn) => {
        connection = conn;
        setupConnection();
    });
});

document.getElementById('connect').addEventListener('click', () => {
    const connectTo = document.getElementById('connectTo').value;
    if (!peer) {
        const randomId = Math.random().toString(36).substring(2, 6);
        peer = new Peer(randomId);
        
        peer.on('open', (id) => {
            document.getElementById('peerId').value = id;
            updateStatus(`Your peer ID is: ${id}`);
            connection = peer.connect(connectTo);
            setupConnection();
        });

        peer.on('connection', (conn) => {
            connection = conn;
            setupConnection();
        });
    } else {
        connection = peer.connect(connectTo);
        setupConnection();
    }
});

async function calculateChecksum(buffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function verifyChecksum(buffer, expectedChecksum) {
    const actualChecksum = await calculateChecksum(buffer);
    return actualChecksum === expectedChecksum;
}

function setupConnection() {
    sendFileBtn.disabled = false;
    
    connection.on('open', () => {
        updateStatus('Connected to peer!', 'mt-8 bg-green-500/20 text-green-400 backdrop-blur-lg rounded-xl p-6 text-center border border-green-500/50');
        updateProgress(0);
        sendFileBtn.disabled = fileQueue.length === 0;
    });

    let fileInfo = null;
    let totalFilesExpected = 0;
    let currentFileNumber = 0;

    connection.on('data', async (data) => {
        if (data.type === 'transfer-start') {
            totalFilesExpected = data.totalFiles;
            currentFileNumber = 0;
            updateStatus(`Receiving ${totalFilesExpected} file${totalFilesExpected > 1 ? 's' : ''}...`);
        }
        else if (data.type === 'file-start') {
            fileInfo = data;
            currentFileNumber++;
            currentFileId = data.fileId;
            receivedChunks.clear();
            expectedChunkIndex = 0;
            totalReceivedSize = 0;
            transferStartTime = Date.now();
            lastUpdateTime = transferStartTime;
            lastBytes = 0;
            updateProgress(0);
            updateStatus(`Receiving file ${currentFileNumber}/${totalFilesExpected}: ${data.filename}`);
        } 
        else if (data.type === 'file-chunk') {
            if (data.fileId !== currentFileId) return;
            
            receivedChunks.set(data.index, data.chunk);
            totalReceivedSize = 0;
            
            for (const chunk of receivedChunks.values()) {
                totalReceivedSize += chunk.byteLength;
            }
            
            connection.send({
                type: 'chunk-ack',
                fileId: data.fileId,
                index: data.index
            });

            while (receivedChunks.has(expectedChunkIndex)) {
                expectedChunkIndex++;
            }

            const progress = Math.min((totalReceivedSize / fileInfo.fileSize) * 100, 100);
            updateProgress(progress);
            updateTransferStatus(totalReceivedSize, fileInfo.fileSize, true, fileInfo.filename);
        } 
        else if (data.type === 'file-end') {
            if (data.fileId !== currentFileId) return;
            
            const orderedChunks = [];
            for (let i = 0; i < expectedChunkIndex; i++) {
                const chunk = receivedChunks.get(i);
                if (chunk) orderedChunks.push(chunk);
            }

            const blob = new Blob(orderedChunks);
            if (blob.size === fileInfo.fileSize) {
                const arrayBuffer = await blob.arrayBuffer();
                const isValid = await verifyChecksum(arrayBuffer, data.checksum);
                
                if (isValid) {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = fileInfo.filename;
                    a.click();
                    URL.revokeObjectURL(url);
                    updateStatus(`File "${fileInfo.filename}" received and verified successfully!`, 
                        'mt-8 bg-green-500/20 text-green-400 backdrop-blur-lg rounded-xl p-6 text-center border border-green-500/50');
                } else {
                    updateStatus(`Checksum verification failed for "${fileInfo.filename}"! File may be corrupted.`,
                        'mt-8 bg-red-500/20 text-red-400 backdrop-blur-lg rounded-xl p-6 text-center border border-red-500/50');
                }
                
                receivedChunks.clear();
                currentFileId = null;
                updateProgress(0);
                transferStatus.textContent = '';
            }
        }
        else if (data.type === 'chunk-ack') {
            sendQueue = sendQueue.filter(item => 
                !(item.fileId === data.fileId && item.index === data.index)
            );
            
            consecutiveTimeouts = 0;
            retryCount.delete(data.index);
            
            if (sendQueue.length === 0) {
                isProcessingQueue = false;
            }
        }
    });
}

function updateProgress(percent) {
    const progressBar = progress.querySelector('div');
    progressBar.style.width = `${percent}%`;
    
    const waveContainer = document.getElementById('waveContainer');
    const liquidContent = document.getElementById('liquidContent');
    const liquidFill = document.getElementById('liquidFill');
    
    if (percent === 0) {
        waveContainer.style.transform = 'translateY(100%)';
        liquidContent.style.transform = 'scaleY(0)';
        liquidFill.style.transform = 'scaleY(0)';
    } else {
        const fillPercent = 1 - (percent / 100);
        waveContainer.style.transform = `translateY(${fillPercent * 100}%)`;
        liquidContent.style.transform = 'scaleY(1)';
        liquidFill.style.transform = 'scaleY(1)';
    }
}

async function sendFileInChunks(file) {
    const fileId = Date.now().toString();
    transferStartTime = Date.now();
    lastUpdateTime = transferStartTime;
    lastBytes = 0;
    
    const buffer = await file.arrayBuffer();
    const checksum = await calculateChecksum(buffer);
    
    connection.send({
        type: 'file-start',
        filename: file.name,
        fileSize: file.size,
        fileId: fileId
    });

    let offset = 0;
    let chunkIndex = 0;

    while (offset < buffer.byteLength) {
        const chunk = buffer.slice(offset, offset + currentChunkSize);
        const chunkData = {
            type: 'file-chunk',
            fileId: fileId,
            index: chunkIndex,
            chunk: chunk,
            timestamp: Date.now()
        };

        sendQueue.push(chunkData);
        
        if (!isProcessingQueue) {
            processQueue();
        }

        offset += chunk.byteLength;
        chunkIndex++;
        
        const progress = (offset / buffer.byteLength) * 100;
        updateProgress(progress);
        updateTransferStatus(offset, buffer.byteLength);

        while (sendQueue.length > MAX_WINDOW_SIZE * 2) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    while (sendQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    connection.send({ 
        type: 'file-end',
        fileId: fileId,
        checksum: checksum
    });
    
    setTimeout(() => {
        updateProgress(0);
        transferStatus.textContent = '';
    }, 1000);
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (sendQueue.length > 0) {
        const activeChunks = sendQueue.slice(0, windowSize);
        const sendPromises = activeChunks.map(async (chunk) => {
            const retries = retryCount.get(chunk.index) || 0;
            
            if (retries >= MAX_RETRIES) {
                throw new Error(`Failed to send chunk ${chunk.index} after ${MAX_RETRIES} attempts`);
            }

            try {
                connection.send(chunk);
                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        consecutiveTimeouts++;
                        reject(new Error('Chunk acknowledgment timeout'));
                    }, 5000);

                    const checkAck = setInterval(() => {
                        if (!sendQueue.includes(chunk)) {
                            clearTimeout(timeout);
                            clearInterval(checkAck);
                            resolve();
                        }
                    }, 100);
                });
            } catch (error) {
                retryCount.set(chunk.index, retries + 1);
                console.error(`Chunk ${chunk.index} failed:`, error);
                throw error;
            }
        });

        try {
            await Promise.all(sendPromises);
            adjustTransferParameters();
        } catch (error) {
            console.error('Error in chunk transmission:', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    isProcessingQueue = false;
}

function adjustTransferParameters() {
    const now = Date.now();
    if (now - lastAdjustmentTime < ADJUSTMENT_INTERVAL) return;
    lastAdjustmentTime = now;

    const currentSpeed = (lastBytes - totalReceivedSize) / ((now - lastUpdateTime) / 1000);
    
    if (consecutiveTimeouts > 0) {
        windowSize = Math.max(MIN_WINDOW_SIZE, windowSize - 2);
        currentChunkSize = Math.max(MIN_CHUNK_SIZE, currentChunkSize / 2);
        consecutiveTimeouts = 0;
    } else if (currentSpeed > lastTransferSpeed && windowSize < MAX_WINDOW_SIZE) {
        windowSize = Math.min(MAX_WINDOW_SIZE, windowSize + 1);
        currentChunkSize = Math.min(MAX_CHUNK_SIZE, currentChunkSize * 1.1);
    }

    lastTransferSpeed = currentSpeed;
}

function updateFileQueue() {
    const queueElement = document.getElementById('fileQueue');
    queueElement.innerHTML = '';
    
    fileQueue.forEach((file, index) => {
        const fileElement = document.createElement('div');
        fileElement.className = 'flex items-center justify-between bg-gray-900/50 p-2 rounded-lg cursor-move group hover:bg-gray-800/50 transition-colors';
        fileElement.setAttribute('data-index', index);

        const extension = file.name.split('.').pop().toUpperCase();
        
        fileElement.innerHTML = `
            <div class="flex items-center min-w-0 flex-1">
                <i class="fas fa-grip-vertical text-gray-500 mr-2 group-hover:text-gray-400"></i>
                <div class="bg-blue-500/20 rounded px-2 py-1 mr-2 w-14 text-center">
                    <span class="text-xs font-mono text-blue-300">${extension}</span>
                </div>
                <div class="truncate flex-1">
                    <span class="text-gray-200 text-sm" title="${file.name}">${file.name}</span>
                    <div class="text-xs text-gray-400">${formatBytes(file.size)}</div>
                </div>
                <button class="text-red-400 hover:text-red-300 ml-2 opacity-0 group-hover:opacity-100 transition-opacity" onclick="removeFromQueue(${index})" title="Remove file">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;
        queueElement.appendChild(fileElement);
    });
    
    sendFileBtn.disabled = fileQueue.length === 0 || !connection;
}

document.addEventListener('DOMContentLoaded', () => {
    new Sortable(document.getElementById('fileQueue'), {
        animation: 150,
        ghostClass: 'bg-blue-900/30',
        handle: '.fa-grip-vertical',
        onEnd: function(evt) {
            const oldIndex = evt.oldIndex;
            const newIndex = evt.newIndex;
            
            if (oldIndex !== newIndex) {
                const item = fileQueue.splice(oldIndex, 1)[0];
                fileQueue.splice(newIndex, 0, item);
                updateFileQueue();
            }
        }
    });
});

function removeFromQueue(index) {
    fileQueue.splice(index, 1);
    updateFileQueue();
}

async function processFileQueue() {
    if (isTransferring || fileQueue.length === 0) return;
    
    isTransferring = true;
    
    connection.send({
        type: 'transfer-start',
        totalFiles: fileQueue.length
    });
    
    for (const file of fileQueue) {
        try {
            await sendFileInChunks(file);
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error('Error sending file:', error);
            updateStatus(`Error sending file: ${file.name}`, 'mt-8 bg-red-500/20 text-red-400 backdrop-blur-lg rounded-xl p-6 text-center border border-red-500/50');
            break;
        }
    }
    
    fileQueue = [];
    updateFileQueue();
    isTransferring = false;
}

fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    fileQueue.push(...files);
    updateFileQueue();
    
    const text = files.length > 1 
        ? `${files.length} files selected` 
        : files[0]?.name || 'Drop your files here or click to browse';
    
    fileInput.parentElement.querySelector('p').textContent = text;
    fileInput.parentElement.querySelector('div').classList.add('border-blue-500', 'bg-blue-500/10');
});

sendFileBtn.addEventListener('click', async () => {
    if (fileQueue.length === 0) return;
    
    try {
        sendFileBtn.disabled = true;
        await processFileQueue();
    } catch (error) {
        console.error('Error processing file queue:', error);
        updateStatus('Error processing file queue', 'mt-8 bg-red-500/20 text-red-400 backdrop-blur-lg rounded-xl p-6 text-center border border-red-500/50');
    } finally {
        sendFileBtn.disabled = false;
        updateProgress(0);
    }
});

const dropZone = document.getElementById('dropZone');
const dropArea = document.getElementById('dropArea');

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function highlight() {
    dropArea.classList.add('drag-over');
}

function unhighlight() {
    dropArea.classList.remove('drag-over');
}

function handleDrop(e) {
    preventDefaults(e);
    unhighlight();

    const dt = e.dataTransfer;
    const files = [...dt.files];
    
    fileQueue.push(...files);
    updateFileQueue();
    
    const text = files.length > 1 
        ? `${files.length} files selected` 
        : files[0]?.name || 'Drop your files here or click to browse';
    
    dropArea.querySelector('p').textContent = text;
    dropArea.classList.add('border-blue-500', 'bg-blue-500/10');
}

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
    document.body.addEventListener(eventName, preventDefaults, false);
});

['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, highlight, false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, unhighlight, false);
});

dropZone.addEventListener('drop', handleDrop, false);
