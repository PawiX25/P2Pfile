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

function updateTransferStatus(transferred, total, isReceiving = false) {
    const now = Date.now();
    const timeSinceLastUpdate = (now - lastUpdateTime) / 1000;
    
    if (timeSinceLastUpdate >= 0.5) {
        const bytesPerSecond = (transferred - lastBytes) / timeSinceLastUpdate;
        const remainingBytes = Math.max(total - transferred, 0);
        const remainingTime = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : 0;
        
        const speed = formatBytes(bytesPerSecond) + '/s';
        const progress = Math.min(Math.round((transferred / total) * 100), 100);
        const timeLeft = remainingTime > 0 ? formatTime(remainingTime) : '0s';
        
        transferStatus.textContent = `${isReceiving ? 'Receiving' : 'Sending'}: ${formatBytes(Math.min(transferred, total))} / ${formatBytes(total)} (${progress}%) | ${speed} | ETA: ${timeLeft}`;
        
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
    const peerId = document.getElementById('peerId').value;
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
    connection = peer.connect(connectTo);
    setupConnection();
});

function setupConnection() {
    sendFileBtn.disabled = false;
    
    connection.on('open', () => {
        updateStatus('Connected to peer!', 'mt-8 bg-green-500/20 text-green-400 backdrop-blur-lg rounded-xl p-6 text-center border border-green-500/50');
        updateProgress(0);
    });

    let fileInfo = null;

    connection.on('data', (data) => {
        if (data.type === 'file-start') {
            fileInfo = data;
            currentFileId = data.fileId;
            receivedChunks.clear();
            expectedChunkIndex = 0;
            totalReceivedSize = 0;
            transferStartTime = Date.now();
            lastUpdateTime = transferStartTime;
            lastBytes = 0;
            updateProgress(0);
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
            updateTransferStatus(totalReceivedSize, fileInfo.fileSize, true);
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
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileInfo.filename;
                a.click();
                URL.revokeObjectURL(url);
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
    
    if (percent === 0) {
        waveContainer.style.transform = 'translateY(100%)';
        liquidContent.style.transform = 'scaleY(0)';
    } else {
        const fillPercent = 1 - (percent / 100);
        waveContainer.style.transform = `translateY(${fillPercent * 100}%)`;
        liquidContent.style.transform = 'scaleY(1)';
    }
}

async function sendFileInChunks(file) {
    const fileId = Date.now().toString();
    transferStartTime = Date.now();
    lastUpdateTime = transferStartTime;
    lastBytes = 0;
    
    connection.send({
        type: 'file-start',
        filename: file.name,
        fileSize: file.size,
        fileId: fileId
    });

    const buffer = await file.arrayBuffer();
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
        fileId: fileId
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

fileInput.addEventListener('change', () => {
    const fileName = fileInput.files[0]?.name;
    if (fileName) {
        fileInput.parentElement.querySelector('p').textContent = fileName;
        fileInput.parentElement.querySelector('div').classList.add('border-blue-500', 'bg-blue-500/10');
    }
});

sendFileBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    
    try {
        sendFileBtn.disabled = true;
        await sendFileInChunks(file);
        sendFileBtn.disabled = false;
    } catch (error) {
        console.error('Error sending file:', error);
        updateStatus('Error sending file', 'mt-8 bg-red-500/20 text-red-400 backdrop-blur-lg rounded-xl p-6 text-center border border-red-500/50');
        sendFileBtn.disabled = false;
        updateProgress(0);
    }
});
