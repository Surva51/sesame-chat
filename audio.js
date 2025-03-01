let audioContext = null;
let mediaStream = null;
let audioInput = null;
let scriptProcessor = null;
let pingInterval = null;
let audioQueue = [];
let isPlaying = false;
let volumeControl = null;
let audioIndicator = null;
let gainNode = null;
let audioSendInterval = null;

// Start audio streaming
async function startAudioStream() {
    try {
        // Get DOM elements
        volumeControl = document.getElementById('volume');
        audioIndicator = document.getElementById('audioIndicator');
        
        // Create audio context with preferred sample rate of 24000Hz
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 24000 // Request the correct sample rate
            });
        } catch(e) {
            // Fall back to default if specific rate not supported
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.warn("Could not create AudioContext with 24000Hz sample rate, using", audioContext.sampleRate);
        }
        console.log("Using audio context with sample rate:", audioContext.sampleRate);
        
        // Create gain node for volume control
        gainNode = audioContext.createGain();
        gainNode.gain.value = volumeControl ? volumeControl.value : 0.7;
        
        // Add volume control event listener
        if (volumeControl) {
            volumeControl.addEventListener('input', () => {
                if (gainNode) {
                    gainNode.gain.value = volumeControl.value;
                }
            });
        }
        
        // Connect gain node to output
        gainNode.connect(audioContext.destination);
        
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
        
        // Create script processor for audio processing
        scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);
        
        // Process audio data
        scriptProcessor.onaudioprocess = function(audioProcessingEvent) {
            const inputBuffer = audioProcessingEvent.inputBuffer;
            const inputData = inputBuffer.getChannelData(0);
            
            // Send audio data regardless of content
            sendAudioData(inputData);
            
            // Show activity indicator
            if (audioIndicator) {
                audioIndicator.classList.add('active');
                setTimeout(() => {
                    audioIndicator.classList.remove('active');
                }, 100);
            }
        };
        
        // Connect the audio graph
        audioInput.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);
        
        // Send ping every second to keep connection alive
        pingInterval = setInterval(sendPing, 1000);
        
        // Ensure audio is sent periodically even if the onaudioprocess doesn't trigger
        audioSendInterval = setInterval(() => {
            // Create and send silent audio if needed
            const silentData = new Float32Array(2048);
            sendAudioData(silentData);
        }, 500);
        
        addToMessageLog("Microphone connected - audio streaming active");
        updateStatus("Listening...");
        
    } catch (error) {
        console.error('Error starting audio stream:', error);
        addToMessageLog(`Error accessing microphone: ${error.message}`);
        updateStatus("Microphone Error");
    }
}

// Stop audio streaming
function stopAudioStream() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    
    if (audioSendInterval) {
        clearInterval(audioSendInterval);
        audioSendInterval = null;
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
    
    audioQueue = [];
    isPlaying = false;
    
    if (audioIndicator) {
        audioIndicator.classList.remove('active');
    }
}

// Send audio data to the server
function sendAudioData(audioData) {
    if (!socket || !sessionId || !callId) return;
    
    // Convert Float32Array to 16-bit PCM
    const pcmData = new Int16Array(audioData.length);
    for (let i = 0; i < audioData.length; i++) {
        // Convert float (-1 to 1) to int16 (-32768 to 32767)
        pcmData[i] = Math.max(-1, Math.min(1, audioData[i])) * 0x7FFF;
    }
    
    // Convert to base64
    const arrayBuffer = pcmData.buffer;
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
    console.log("Sent audio data, length:", base64.length);
}

// Handle incoming audio data
function handleAudioData(base64Audio) {
    if (!audioContext) return;
    
    try {
        console.log("Received audio data length:", base64Audio.length);
        
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
        
        // Queue audio for playback
        audioQueue.push(floatArray);
        
        // Start playing if not already playing
        if (!isPlaying) {
            playNextAudio();
        }
        
        updateStatus("Receiving audio...");
        
    } catch (error) {
        console.error('Error handling audio data:', error);
        addToMessageLog(`Error processing audio: ${error.message}`);
    }
}

// Play queued audio
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
        const audioBuffer = audioContext.createBuffer(1, audioData.length, 24000);
        audioBuffer.getChannelData(0).set(audioData);
        
        // Create source and play
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        
        // Connect through gain node for volume control
        source.connect(gainNode);
        
        source.onended = playNextAudio;
        source.start();
        
        console.log("Playing audio chunk with 24000Hz sample rate, length:", audioData.length);
        
    } catch (error) {
        console.error('Error playing audio:', error);
        addToMessageLog(`Error playing audio: ${error.message}`);
        setTimeout(playNextAudio, 100);
    }
}