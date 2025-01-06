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
    const elapsedTime = (now - transferStartTime) / 1000;
    const timeSinceLastUpdate = (now - lastUpdateTime) / 1000;
    
    if (timeSinceLastUpdate >= 0.5) {
        const bytesPerSecond = (transferred - lastBytes) / timeSinceLastUpdate;
        const remainingBytes = total - transferred;
        const remainingTime = remainingBytes / bytesPerSecond;
        
        const speed = formatBytes(bytesPerSecond) + '/s';
        const progress = Math.round((transferred / total) * 100);
        const timeLeft = formatTime(remainingTime);
        
        transferStatus.textContent = `${isReceiving ? 'Receiving' : 'Sending'}: ${formatBytes(transferred)} / ${formatBytes(total)} (${progress}%) | ${speed} | ETA: ${timeLeft}`;
        
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

    let receiveBuffer = [];
    let receivedSize = 0;
    let fileInfo = null;

    connection.on('data', (data) => {
        if (data.type === 'file-start') {
            fileInfo = data;
            receiveBuffer = [];
            receivedSize = 0;
            transferStartTime = Date.now();
            lastUpdateTime = transferStartTime;
            lastBytes = 0;
            updateProgress(0);
        } else if (data.type === 'file-chunk') {
            receiveBuffer.push(data.chunk);
            receivedSize += data.chunk.byteLength;
            const progress = (receivedSize / fileInfo.fileSize) * 100;
            updateProgress(progress);
            updateTransferStatus(receivedSize, fileInfo.fileSize, true);
        } else if (data.type === 'file-end') {
            const blob = new Blob(receiveBuffer);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileInfo.filename;
            a.click();
            URL.revokeObjectURL(url);
            updateProgress(0);
            transferStatus.textContent = '';
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
    transferStartTime = Date.now();
    lastUpdateTime = transferStartTime;
    lastBytes = 0;
    
    connection.send({
        type: 'file-start',
        filename: file.name,
        fileSize: file.size
    });

    const buffer = await file.arrayBuffer();
    let offset = 0;
    let throttleTimeout = 1;

    while (offset < buffer.byteLength) {
        const chunk = buffer.slice(offset, offset + currentChunkSize);
        connection.send({
            type: 'file-chunk',
            chunk: chunk
        });
        
        offset += chunk.byteLength;
        const progress = (offset / buffer.byteLength) * 100;
        updateProgress(progress);
        
        const now = Date.now();
        const timeSinceLastUpdate = (now - lastUpdateTime) / 1000;
        if (timeSinceLastUpdate >= 0.5) {
            const currentSpeed = (offset - lastBytes) / timeSinceLastUpdate;
            
            if (currentSpeed > lastTransferSpeed) {
                currentChunkSize = Math.min(currentChunkSize * 1.25, MAX_CHUNK_SIZE);
                throttleTimeout = Math.max(throttleTimeout - 1, 0);
            } else {
                currentChunkSize = Math.max(currentChunkSize * 0.75, MIN_CHUNK_SIZE);
                throttleTimeout = Math.min(throttleTimeout + 1, 5);
            }
            
            lastTransferSpeed = currentSpeed;
            updateTransferStatus(offset, buffer.byteLength);
            lastBytes = offset;
            lastUpdateTime = now;
        }

        await new Promise(resolve => setTimeout(resolve, throttleTimeout));
    }

    connection.send({ type: 'file-end' });
    setTimeout(() => {
        updateProgress(0);
        currentChunkSize = CHUNK_SIZE;
        lastTransferSpeed = 0;
    }, 1000);
    transferStatus.textContent = '';
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
