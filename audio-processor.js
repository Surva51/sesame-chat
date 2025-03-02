// AudioWorklet processor for audio input/output handling
class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.initialized = false;
      this.inputChunks = [];
      this.isRecording = false;
      this.hasFoundAudio = false;
      
      // Output playback settings
      this.outputBuffers = [];
      this.playbackRate = 1.0;
      this.playbackRateMin = 0.8;
      this.playbackRateMax = 1.5;
      this.playbackRateAffordance = 0.2;
      this.playbackSmoothing = 0.9;
      this.playbackOutputOffset = 0;
      this.playbackMinBuffers = 24; // (~120ms @ 24kHz with 128 samples)
      this.bufferLength = 128;
      this.isInPlayback = false;
      this.playbackSkipDigitalSilence = true;
      
      // Handle messages from main thread
      this.port.onmessage = this.handleMessage.bind(this);
    }
    
    handleMessage(event) {
      const { type, data } = event.data;
      
      switch(type) {
        case 'configure':
          if (data.playbackMinBuffers) this.playbackMinBuffers = data.playbackMinBuffers;
          if (data.playbackRateMin) this.playbackRateMin = data.playbackRateMin;
          if (data.playbackRateMax) this.playbackRateMax = data.playbackRateMax;
          if (data.playbackSmoothing) this.playbackSmoothing = data.playbackSmoothing;
          if (data.playbackSkipDigitalSilence !== undefined) 
            this.playbackSkipDigitalSilence = data.playbackSkipDigitalSilence;
          break;
          
        case 'startRecording':
          this.isRecording = true;
          this.inputChunks = [];
          break;
          
        case 'stopRecording':
          this.isRecording = false;
          break;
          
        case 'addOutputBuffer':
          const buffer = data.buffer;
          const isSilence = this.isDigitalSilence(buffer);
          this.outputBuffers.push({ buffer, isSilence });
          break;
      }
    }
    
    // Check if buffer is digital silence (all zeros)
    isDigitalSilence(buffer) {
      for (let i = 0; i < buffer.length; i++) {
        if (Math.abs(buffer[i]) > 0.0001) return false;
      }
      return true;
    }
    
    // Determine playback rate based on buffer health
    determinePlaybackRate(availableSamples, targetSamples) {
      let playbackRate = 1.0;
      
      if (this.playbackRateMin < this.playbackRateMax) {
        const samplesDelta = availableSamples - targetSamples;
        const affordanceThreshold = this.playbackRateAffordance * targetSamples;
        
        if (Math.abs(samplesDelta) > affordanceThreshold) {
          if (samplesDelta <= 0) {
            // Buffer too low - slow down playback
            playbackRate = 1.0 + Math.max(-0.975, samplesDelta / targetSamples);
          } else {
            // Buffer too high - speed up playback
            playbackRate = 1.0 / (1.0 - Math.min(0.975, samplesDelta / targetSamples));
          }
        }
        
        // Clamp to min/max values
        playbackRate = Math.min(this.playbackRateMax, Math.max(this.playbackRateMin, playbackRate));
      }
      
      return playbackRate;
    }
    
    // Resample audio data for playback rate changes
    resampleAudioData(float32Array, targetSamples) {
      if (targetSamples === float32Array.length) {
        return float32Array;
      }
      
      // Create resized buffer
      const resampledBuffer = new Float32Array(targetSamples);
      const playbackRate = float32Array.length / targetSamples;
      
      for (let i = 0; i < targetSamples; i++) {
        const originalIndex = i * playbackRate;
        const start = Math.floor(originalIndex);
        const end = Math.ceil(originalIndex);
        
        if (start === end || end >= float32Array.length) {
          // Direct sample copy
          resampledBuffer[i] = float32Array[start];
        } else {
          // Linear interpolation between samples
          const ratio = originalIndex - start;
          resampledBuffer[i] = float32Array[start] * (1 - ratio) + 
                              float32Array[end] * ratio;
        }
      }
      
      return resampledBuffer;
    }
    
    process(inputs, outputs) {
      const input = inputs[0];
      const output = outputs[0];
      
      // 1. Process input (microphone) data
      if (input && input[0] && input[0].length > 0 && this.isRecording) {
        const inputChannel = input[0];
        this.hasFoundAudio = true;
        
        // Convert to Int16, then back to float to simulate same processing as server side
        const int16Data = new Int16Array(inputChannel.length);
        for (let i = 0; i < inputChannel.length; i++) {
          int16Data[i] = Math.max(-1, Math.min(1, inputChannel[i])) * 0x7FFF;
        }
        
        // Send chunk to main thread
        this.port.postMessage({
          eventType: 'inputData',
          data: int16Data.buffer
        }, [int16Data.buffer]);
      }
      
      // 2. Process output (playback) data
      if (output && output[0] && this.outputBuffers.length > 0) {
        const outputChannel = output[0];
        const outputChannelLength = outputChannel.length;
        let totalSamples = -this.playbackOutputOffset;
        let consumableSamples = -this.playbackOutputOffset;
        
        // Count available samples
        for (let i = 0; i < this.outputBuffers.length; i++) {
          const { buffer, isSilence } = this.outputBuffers[i];
          totalSamples += buffer.length;
          
          // Skip silent buffers if enabled and not in playback
          if (this.playbackSkipDigitalSilence && !this.isInPlayback && isSilence) {
            continue;
          }
          
          consumableSamples += buffer.length;
        }
        
        const serverSamplesTarget = this.playbackMinBuffers * this.bufferLength;
        let consumeBuffer = this.isInPlayback || consumableSamples >= serverSamplesTarget;
        
        // If we have enough data, process it
        if (consumeBuffer && consumableSamples > 0) {
          // Calculate ideal playback rate
          const playbackRateTarget = this.determinePlaybackRate(consumableSamples, serverSamplesTarget);
          
          // Apply smoothing to playback rate changes
          this.playbackRate = this.playbackRate * this.playbackSmoothing + 
                             playbackRateTarget * (1 - this.playbackSmoothing);
          
          // Calculate how many samples we need at current playback rate
          const samplesNeeded = Math.floor(outputChannelLength * this.playbackRate);
          const tempBuffer = new Float32Array(samplesNeeded);
          
          // Fill the buffer with needed samples
          let samplesRead = 0;
          let bufferIndex = 0;
          let bufferOffset = this.playbackOutputOffset;
          let underrun = false;
          
          while (bufferIndex < this.outputBuffers.length && samplesRead < samplesNeeded) {
            const { buffer, isSilence } = this.outputBuffers[bufferIndex];
            
            // Skip silent buffers if enabled and not in playback
            if (this.playbackSkipDigitalSilence && !this.isInPlayback && isSilence) {
              bufferIndex++;
              continue;
            }
            
            // Copy samples from buffer
            for (let j = bufferOffset; j < buffer.length && samplesRead < samplesNeeded; j++) {
              tempBuffer[samplesRead++] = buffer[j];
              
              if (j === buffer.length - 1) {
                bufferOffset = 0;
                bufferIndex++;
              } else {
                bufferOffset++;
              }
            }
          }
          
          // Check for buffer underrun
          if (samplesRead < samplesNeeded) {
            underrun = true;
          }
          
          // Apply playback rate to output buffer
          const resampledBuffer = this.resampleAudioData(tempBuffer, outputChannelLength);
          
          // Copy to output
          for (let i = 0; i < outputChannelLength; i++) {
            outputChannel[i] = resampledBuffer[i];
          }
          
          // Update state
          this.outputBuffers = this.outputBuffers.slice(bufferIndex);
          this.playbackOutputOffset = bufferOffset;
          this.isInPlayback = true;
          
          // Report metrics to main thread
          this.port.postMessage({
            eventType: 'playbackMetrics',
            bufferHealth: consumableSamples / serverSamplesTarget,
            playbackRate: this.playbackRate,
            underrun: underrun,
            sampleCount: samplesRead
          });
        } else {
          // Not enough data in buffer yet
          this.isInPlayback = false;
          
          // Clear output channel
          for (let i = 0; i < outputChannelLength; i++) {
            outputChannel[i] = 0;
          }
          
          // Report buffer status to main thread
          this.port.postMessage({
            eventType: 'bufferingStatus',
            bufferHealth: consumableSamples / serverSamplesTarget,
            totalBuffered: totalSamples
          });
        }
      }
      
      return true;
    }
  }
  
  registerProcessor('audio-processor', AudioProcessor);