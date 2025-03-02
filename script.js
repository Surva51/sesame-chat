const API_KEY = "AIzaSyDtC7Uwb5pGAsdmrH2T4Gqdk5Mga07jYPM";
let idToken = null;
let socket = null;
let sessionId = null;
let callId = null;
let lastPingTime = null;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const connectionStatus = document.getElementById('connectionStatus');
const messageLog = document.getElementById('messageLog');
const statsDisplay = document.getElementById('statsDisplay');

// Initialize the application
startBtn.addEventListener('click', startConversation);
stopBtn.addEventListener('click', stopConversation);

// Add debug elements to display metrics
function updateStats() {
    if (!statsDisplay) return;
    
    // Create stats display if it doesn't exist
    if (!document.getElementById('statsDisplay')) {
        const statsContainer = document.createElement('div');
        statsContainer.id = 'statsDisplay';
        statsContainer.className = 'stats-container';
        document.querySelector('.container').appendChild(statsContainer);
    }
    
    // Update stats
    document.getElementById('statsDisplay').innerHTML = `
        <div>RTT: ${currentRtt.toFixed(0)}ms</div>
        <div>Buffer: ${(audioBufferHealth * 100).toFixed(0)}%</div>
        <div>Playback: ${currentPlaybackRate.toFixed(2)}x</div>
    `;
}

// Set up stats update interval
setInterval(updateStats, 500);

// Get anonymous auth token from Firebase
async function getAuthToken() {
    try {
        const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                returnSecureToken: true
            })
        });
        
        const data = await response.json();
        if (data.idToken) {
            idToken = data.idToken;
            return data.idToken;
        } else {
            throw new Error('Failed to get ID token');
        }
    } catch (error) {
        console.error('Authentication error:', error);
        updateStatus('Auth Failed');
        throw error;
    }
}

// Start the conversation
async function startConversation() {
    try {
        updateStatus('Authenticating...');
        const token = await getAuthToken();
        
        updateStatus('Connecting...');
        connectWebSocket(token);
        
        startBtn.disabled = true;
        stopBtn.disabled = false;
    } catch (error) {
        console.error('Failed to start conversation:', error);
        updateStatus('Failed to start');
    }
}

// Connect to WebSocket server
function connectWebSocket(token) {
    const userContext = JSON.stringify({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
    
    const wsUrl = `wss://sesameai.app/agent-service-0/v1/connect?id_token=${token}&client_name=RP-Web&usercontext=${encodeURIComponent(userContext)}&character=Maya`;
    
    socket = new WebSocket(wsUrl);
    
    socket.onopen = () => {
        console.log('WebSocket connection established');
        updateStatus('Connected');
        addToMessageLog("WebSocket connection established");
    };
    
    socket.onmessage = (event) => {
        handleSocketMessage(event.data);
    };
    
    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('Connection Error');
        addToMessageLog(`WebSocket error: ${error}`);
    };
    
    socket.onclose = () => {
        console.log('WebSocket connection closed');
        updateStatus('Disconnected');
        addToMessageLog("WebSocket connection closed");
        startBtn.disabled = false;
        stopBtn.disabled = true;
    };
}

// Handle incoming WebSocket messages
function handleSocketMessage(data) {
    try {
        const message = JSON.parse(data);
        console.log('Received message type:', message.type);
        
        switch (message.type) {
            case 'initialize':
                sessionId = message.content.session_id;
                sendClientLocationState();
                sendCallConnect();
                break;
                
            case 'call_connect_response':
                callId = message.call_id;
                startAudioStream();
                addToMessageLog(`Call connected with ID: ${callId}`);
                break;
                
            case 'audio':
                // Handle incoming audio data
                if (message.content && message.content.audio_data) {
                    handleAudioData(message.content.audio_data);
                }
                break;
                
            case 'chat':
                if (message.content && message.content.messages && message.content.messages.length > 0) {
                    message.content.messages.forEach(msg => {
                        if (msg.content) {
                            addToMessageLog(`Chat message: ${msg.content}`);
                        }
                    });
                }
                break;
                
            case 'ping_response':
                // Calculate RTT
                if (lastPingTime) {
                    const rtt = Date.now() - lastPingTime;
                    updateRTT(rtt);
                }
                break;
                
            default:
                addToMessageLog(`Received message type: ${message.type}`);
        }
        
        // Log the message type (except frequent messages)
        if (message.type !== 'ping_response' && message.type !== 'audio') {
            addToMessageLog(`← ${message.type}`);
        }
        
    } catch (error) {
        console.error('Error handling message:', error);
        addToMessageLog(`Error handling message: ${error.message}`);
    }
}

// Send client location state
function sendClientLocationState() {
    if (!socket || !sessionId) return;
    
    const message = {
        type: 'client_location_state',
        session_id: sessionId,
        call_id: null,
        content: {
            latitude: 0,
            longitude: 0,
            address: '',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        }
    };
    
    sendSocketMessage(message);
}

// Send call connect message
function sendCallConnect() {
    if (!socket || !sessionId) return;
    
    const requestId = generateUUID();
    
    const message = {
        type: 'call_connect',
        session_id: sessionId,
        call_id: null,
        request_id: requestId,
        content: {
            sample_rate: 24000,
            audio_codec: 'none',
            reconnect: false,
            is_private: false,
            settings: {
                preset: 'Maya'
            },
            client_name: 'RP-Web',
            client_metadata: {
                user_agent: navigator.userAgent,
                mobile_browser: /Mobi|Android/i.test(navigator.userAgent),
                language: navigator.language,
                media_devices: [] // Will populate with actual devices
            }
        }
    };
    
    // Get available audio devices and add them to the message
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        navigator.mediaDevices.enumerateDevices()
            .then(devices => {
                const mediaDevices = [];
                devices.forEach(device => {
                    mediaDevices.push({
                        deviceId: device.deviceId || '',
                        kind: device.kind || '',
                        label: device.label || '',
                        groupId: device.groupId || ''
                    });
                });
                message.content.client_metadata.media_devices = mediaDevices;
                sendSocketMessage(message);
            })
            .catch(err => {
                console.error('Error getting media devices:', err);
                sendSocketMessage(message);
            });
    } else {
        sendSocketMessage(message);
    }
}

// Send ping to keep connection alive and measure RTT
function sendPing() {
    if (!socket || !sessionId) return;
    
    const message = {
        type: 'ping',
        session_id: sessionId,
        call_id: callId,
        request_id: generateUUID(),
        content: 'ping'
    };
    
    lastPingTime = Date.now();
    sendSocketMessage(message);
}

// Send message to the socket
function sendSocketMessage(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const messageStr = JSON.stringify(message);
        socket.send(messageStr);
        
        // Don't log ping messages to avoid cluttering the interface
        if (message.type !== 'ping' && message.type !== 'audio') {
            addToMessageLog(`→ ${message.type}`);
        }
        
        console.log('Sent message:', message);
    } else {
        console.error('Socket not connected');
        addToMessageLog('Error: Socket not connected');
    }
}

// Stop the conversation
function stopConversation() {
    // First disconnect the call if active
    if (callId) {
        const disconnectMessage = {
            type: 'call_disconnect',
            session_id: sessionId,
            call_id: callId,
            request_id: generateUUID(),
            content: {
                reason: 'user_request'
            }
        };
        
        sendSocketMessage(disconnectMessage);
    }
    
    // Stop audio processing
    stopAudioStream();
    
    // Close WebSocket
    if (socket) {
        socket.close();
        socket = null;
    }
    
    sessionId = null;
    callId = null;
    updateStatus('Disconnected');
    
    startBtn.disabled = false;
    stopBtn.disabled = true;
    
    addToMessageLog('Conversation ended');
}

// Helper functions
function updateStatus(status) {
    connectionStatus.textContent = status;
}

function addToMessageLog(message) {
    const logItem = document.createElement('div');
    logItem.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
    messageLog.prepend(logItem);
    
    // Limit log items
    if (messageLog.children.length > 50) {
        messageLog.removeChild(messageLog.lastChild);
    }
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}