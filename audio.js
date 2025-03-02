let audioContext = null;
let mediaStream = null;
let audioInput = null;
let audioProcessor = null;
let scriptProcessor = null; // For fallback
let pingInterval = null;
let audioStartTime = null;
let volumeControl = null;
let audioIndicator = null;
let gainNode = null;
let sampleRate = 24000;
let isRecording = false;

// Network and buffer health tracking
let networkRttHistory = [];
let currentRtt = 0;
let lastRttUpdateTime = 0;
const MAX_RTT_HISTORY = 5;
const MIN_BUFFER_MS = 60;
const MAX_BUFFER_MS = 800;
const TARGET_BUFFER_MS = 120;
const BUFFER_PADDING_MULTIPLIER = 1.25;
let bufferUnderrunInstances = [];
let audioBufferHealth = 0;
let currentPlaybackRate = 1.0;

// Audio playback queue (for ScriptProcessor fallback)
let audioQueue = [];
let isPlaying = false;

// Start audio streaming
async function startAudioStream() {
    try {
        // Get DOM elements
        volumeControl = document.getElementById('volume');
        audioIndicator = document.getElementById('audioIndicator');
        
        // Create audio context with proper sample rate
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: sampleRate
            });
        } catch(e) {
            // Fall back to default
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.warn("Could not create AudioContext with 24000Hz sample rate, using", audioContext.sampleRate);
        }
        sampleRate = audioContext.sampleRate;
        console.log("Using audio context with sample rate:", sampleRate);
        
        // Create gain node for volume control
        gainNode = audioContext.createGain();
        gainNode.gain.value = volumeControl ? volumeControl.value : 0.7;
        gainNode.connect(audioContext.destination);
        
        // Add volume control event listener
        if (volumeControl) {
            volumeControl.addEventListener('input', () => {
                if (gainNode) {
                    gainNode.gain.value = volumeControl.value;
                }
            });
        }
        
        // Get user media (microphone)
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        
        // Create audio input from microphone
        audioInput = audioContext.createMediaStreamSource(mediaStream);
        
        // Try AudioWorklet first, fall back to ScriptProcessor
        let usingModernAPI = false;
        
        try {
            console.log("Attempting to load AudioWorklet from:", new URL('audio-processor.js', window.location.href).href);
            
            // Try to load the AudioWorklet
            await audioContext.audioWorklet.addModule('audio-processor.js');
            audioProcessor = new AudioWorkletNode(audioContext, 'audio-processor');
            
            // Connect the audio graph
            audioInput.connect(audioProcessor);
            audioProcessor.connect(gainNode);
            
            // Set up AudioWorklet message handling
            audioProcessor.port.onmessage = handleWorkletMessage;
            
            // Start recording with AudioWorklet
            audioProcessor.port.postMessage({
                type: 'startRecording'
            });
            
            usingModernAPI = true;
            addToMessageLog("Using modern AudioWorklet API");
            
        } catch (workletError) {
            // Log detailed error for debugging
            console.error('AudioWorklet failed to load:', workletError);
            addToMessageLog(`Using fallback audio system (${workletError.message})`);
            
            // Fall back to ScriptProcessor
            const bufferSize = 2048;
            scriptProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
            
            // Set up input processing
            scriptProcessor.onaudioprocess = function(audioProcessingEvent) {
                const inputBuffer = audioProcessingEvent.inputBuffer;
                const inputData = inputBuffer.getChannelData(0);
                
                // Convert to Int16 for sending
                const int16Data = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    int16Data[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
                }
                
                // Send audio data
                sendAudioData(int16Data);
                
                // Show activity indicator
                if (audioIndicator) {
                    audioIndicator.classList.add('active');
                    setTimeout(() => {
                        audioIndicator.classList.remove('active');
                    }, 100);
                }
            };
            
            // Connect script processor
            audioInput.connect(scriptProcessor);
            scriptProcessor.connect(audioContext.destination);
        }
        
        isRecording = true;
        audioStartTime = Date.now();
        
        // Send ping every second to keep connection alive and measure RTT
        pingInterval = setInterval(sendPing, 1000);
        
        addToMessageLog("Microphone connected - audio streaming active");
        updateStatus("Listening...");
        
    } catch (error) {
        console.error('Error starting audio stream:', error);
        addToMessageLog(`Error accessing microphone: ${error.message}`);
        updateStatus("Microphone Error");
    }
}

// Handle messages from AudioWorklet
function handleWorkletMessage(event) {
    const { eventType, ...data } = event.data;
    
    switch (eventType) {
        case 'inputData':
            // Process and send audio input data to server
            const int16Array = new Int16Array(data.data);
            sendAudioData(int16Array);
            
            // Show activity indicator
            if (audioIndicator) {
                audioIndicator.classList.add('active');
                setTimeout(() => {
                    audioIndicator.classList.remove('active');
                }, 100);
            }
            break;
            
        case 'playbackMetrics':
            // Update buffer health metrics
            audioBufferHealth = data.bufferHealth;
            currentPlaybackRate = data.playbackRate;
            
            // Handle underrun if detected
            if (data.underrun) {
                const underrunTime = Date.now();
                bufferUnderrunInstances.push({
                    time_since_call_start_ms: underrunTime - audioStartTime,
                    empty_time_ms: 0,
                    rtt_ms: currentRtt
                });
                
                // Log underrun
                console.warn("Buffer underrun detected with RTT:", currentRtt);
                addToMessageLog(`Buffer underrun with RTT: ${currentRtt.toFixed(0)}ms`);
            }
            
            // Show activity indicator
            if (audioIndicator) {
                audioIndicator.classList.add('active');
                setTimeout(() => {
                    audioIndicator.classList.remove('active');
                }, 100);
            }
            
            updateStatus(`Playing (Buffer: ${(audioBufferHealth * 100).toFixed(0)}%, Rate: ${currentPlaybackRate.toFixed(2)}x)`);
            break;
            
        case 'bufferingStatus':
            // Update buffer status
            audioBufferHealth = data.bufferHealth;
            updateStatus(`Buffering ${(audioBufferHealth * 100).toFixed(0)}%`);
            break;
    }
}

// Stop audio streaming
function stopAudioStream() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    
    if (audioProcessor) {
        try {
            audioProcessor.port.postMessage({
                type: 'stopRecording'
            });
        } catch (e) {
            console.warn("Error stopping AudioWorklet:", e);
        }
        
        audioProcessor.disconnect();
        audioProcessor = null;
    }
    
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor = null;
    }
    
    if (audioInput) {
        audioInput.disconnect();
        audioInput = null;
    }
    
    if (gainNode) {
        gainNode.disconnect();
        gainNode = null;
    }
    
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
    
    if (audioContext) {
        audioContext.close().catch(err => console.error("Error closing audio context:", err));
        audioContext = null;
    }
    
    isRecording = false;
    audioQueue = [];
    isPlaying = false;
    
    if (audioIndicator) {
        audioIndicator.classList.remove('active');
    }
}

// Send audio data to the server
function sendAudioData(int16Array) {
    if (!socket || !sessionId || !callId || !isRecording) return;
    
    // Convert to base64
    const arrayBuffer = int16Array.buffer;
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = window.btoa(binary);
    
    // Send audio data message
    const message = {
        type: 'audio',
        session_id: sessionId,
        call_id: callId,
        content: {
            audio_data: base64
        }
    };
    
    sendSocketMessage(message);
}

// Handle incoming audio data
function handleAudioData(base64Audio) {
    if (!audioContext) return;
    
    try {
        // Skip empty data
        if (!base64Audio || base64Audio.length < 10) {
            console.log("Received empty audio data");
            return;
        }
        
        // Decode base64 audio
        const binaryString = window.atob(base64Audio);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Convert to 16-bit PCM - using DataView for correct endianness
        const buffer = bytes.buffer;
        const view = new DataView(buffer);
        const int16Array = new Int16Array(buffer.byteLength / 2);
        
        for (let i = 0; i < int16Array.length; i++) {
            // Read as little-endian (true parameter)
            int16Array[i] = view.getInt16(i * 2, true);
        }
        
        // Convert to float audio data
        const floatArray = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            floatArray[i] = int16Array[i] / 32767.0;
        }
        
        if (audioProcessor) {
            // Use AudioWorklet for playback
            audioProcessor.port.postMessage({
                type: 'addOutputBuffer',
                data: {
                    buffer: floatArray
                }
            });
        } else {
            // Use fallback method (queuing for playback)
            audioQueue.push(floatArray);
            
            // Start playback if not already playing
            if (!isPlaying) {
                playNextAudio();
            }
        }
        
        updateStatus("Receiving audio...");
        
    } catch (error) {
        console.error('Error handling audio data:', error);
        addToMessageLog(`Error processing audio: ${error.message}`);
    }
}

// Play queued audio (fallback method when AudioWorklet is unavailable)
function playNextAudio() {
    if (audioQueue.length === 0) {
        isPlaying = false;
        updateStatus("Connected");
        return;
    }
    
    isPlaying = true;
    updateStatus("Playing...");
    
    // Show audio activity
    if (audioIndicator) {
        audioIndicator.classList.add('active');
        setTimeout(() => {
            audioIndicator.classList.remove('active');
        }, 100);
    }
    
    const audioData = audioQueue.shift();
    
    try {
        // Create buffer for playback with the correct sample rate
        const audioBuffer = audioContext.createBuffer(1, audioData.length, sampleRate);
        audioBuffer.getChannelData(0).set(audioData);
        
        // Create source and play
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        
        // Connect through gain node for volume control
        source.connect(gainNode);
        
        source.onended = playNextAudio;
        source.start();
        
    } catch (error) {
        console.error('Error playing audio:', error);
        addToMessageLog(`Error playing audio: ${error.message}`);
        setTimeout(playNextAudio, 100);
    }
}

// Update RTT and adjust buffer size
function updateRTT(latency) {
    networkRttHistory.push(latency);
    
    if (networkRttHistory.length > MAX_RTT_HISTORY) {
        networkRttHistory.shift();
    }
    
    // Calculate average RTT
    currentRtt = networkRttHistory.reduce((sum, rtt) => sum + rtt, 0) / networkRttHistory.length;
    
    // Only update every 5 seconds to avoid changing buffer too frequently
    const now = Date.now();
    if (now - lastRttUpdateTime > 5000) {
        lastRttUpdateTime = now;
        updateBufferSize();
    }
}

// Update buffer size based on network conditions
function updateBufferSize() {
    if (!audioProcessor) return;
    
    // Calculate adaptive buffer based on network RTT
    const extraBufferNeeded = Math.max(0, currentRtt - TARGET_BUFFER_MS);
    const bufferPadding = BUFFER_PADDING_MULTIPLIER * TARGET_BUFFER_MS;
    const bufferSizeMs = Math.max(MIN_BUFFER_MS, 
                          Math.min(MAX_BUFFER_MS, 
                              extraBufferNeeded + bufferPadding));
    
    // Convert ms to buffer blocks
    const bufferBlocks = Math.ceil(bufferSizeMs * sampleRate / 128 / 1000);
    
    // Configure the processor
    try {
        audioProcessor.port.postMessage({
            type: 'configure',
            data: {
                playbackMinBuffers: bufferBlocks
            }
        });
        
        console.log(`Adjusted buffer: ${bufferSizeMs.toFixed(0)}ms (${bufferBlocks} blocks) based on RTT: ${currentRtt.toFixed(0)}ms`);
    } catch (e) {
        console.warn("Error configuring AudioWorklet:", e);
    }
    
    // If RTT is very high, log a warning
    if (currentRtt > 500) {
        addToMessageLog(`Warning: High network latency (${currentRtt.toFixed(0)}ms)`);
    }
}