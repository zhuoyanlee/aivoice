// Cloudflare Worker for Twilio-Gemini Voice Bridge
import { Router } from 'itty-router';

import * as speechSdk from 'microsoft-cognitiveservices-speech-sdk';

const router = Router();

// Twilio voice webhook - handles incoming calls
router.post('/webhook/voice', async (request, env) => {
    const formData = await request.formData();
    const callSid = formData.get('CallSid');
    const from = formData.get('From');
    const to = formData.get('To');
    const callStatus = formData.get('CallStatus');
  
    console.log(`Incoming call: ${callSid} from ${from} to ${to}, status: ${callStatus}`);
  
    // Store call data in KV
    const callData = {
      from,
      to,
      startTime: new Date().toISOString(),
      transcriptions: [],
      realtimeTranscript: '',
      status: callStatus,
      isRealTime: true
    };
  
    await env.TRANSCRIPTIONS.put(`call:${callSid}`, JSON.stringify(callData));
  
    // Get WebSocket URL for this request
    const url = new URL(request.url);
    const wsUrl = `wss://${url.host}/media-stream`;
  
    // TwiML response with Media Stream
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
        <Say>Hello!</Say>
        <Start>
          <Stream url="${wsUrl}" />
        </Start>
        <Say>speak.</Say>
        <Pause length="60"/>
      </Response>`;
  
    return new Response(twiml, {
      headers: { 'Content-Type': 'text/xml' }
    });
  });

export default {
    
    async fetch(request, env, ctx) {
      try {
        const url = new URL(request.url);
        
        // Handle Twilio webhook for incoming calls
        if (url.pathname === '/voice' && request.method === 'POST') {
          return handleVoiceCall(request, env);
        }
        
        // Handle WebSocket upgrade for media streaming
        if (url.pathname === '/media-stream') {
          return handleWebSocket(request, env);
        }
        
        // Health check endpoint
        if (url.pathname === '/health') {
          return new Response('OK', { status: 200 });
        }
        
        return router.handle(request, env, ctx);
      } catch (error) {
        console.error('Worker fetch error:', error);
        return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
      }
    }
  };
  
  async function handleVoiceCall(request, env) {
    // Generate TwiML response to start media stream
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say>Hello! I'm connecting you to an AI assistant. Please wait a moment.</Say>
        <Start>
          <Stream url="wss://${request.headers.get('host')}/media-stream" />
        </Start>
        <Say>You are now connected. Please speak.</Say>
        <Pause length="60"/>
      </Response>`;
  
    return new Response(twiml, {
      headers: {
        'Content-Type': 'application/xml',
      },
    });
  }
  
  async function handleWebSocket(request, env) {
    try {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }
  
      // Check if WebSocketPair is available
      if (typeof WebSocketPair === 'undefined') {
        console.error('WebSocketPair is not available in this environment');
        return new Response('WebSocket not supported', { status: 501 });
      }
  
      const webSocketPair = new WebSocketPair();
      const [client, server] = [webSocketPair[0], webSocketPair[1]];
      
      // Handle the WebSocket connection
      server.accept();
      
      // Create connection to Gemini AI with error handling
      let geminiHandler, mediaProcessor;
      
      try {
        geminiHandler = new GeminiHandler(env);
        mediaProcessor = new MediaStreamProcessor(server, geminiHandler);
      } catch (initError) {
        console.error('Failed to initialize handlers:', initError);
        server.close(1011, 'Initialization failed');
        return new Response(null, {
          status: 101,
          webSocket: client,
        });
      }
      
      server.addEventListener('message', async (event) => {
        try {
          console.log('Received WebSocket message:', event.data);
          const message = JSON.parse(event.data);
          await mediaProcessor.handleMessage(message);
        } catch (error) {
          console.error('WebSocket message error:', error);
          server.send(JSON.stringify({ 
            event: 'error', 
            error: `Message processing failed: ${error.message}` 
          }));
        }
      });
  
      server.addEventListener('close', (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        if (mediaProcessor) {
          mediaProcessor.cleanup();
        }
      });
  
      server.addEventListener('error', (event) => {
        console.error('WebSocket error:', event);
        if (mediaProcessor) {
          mediaProcessor.cleanup();
        }
      });
  
      return new Response(null, {
        status: 101,
        webSocket: client,
      });
      
    } catch (error) {
      console.error('WebSocket handler error:', error);
      return new Response(`WebSocket Error: ${error.message}`, { status: 500 });
    }
  }
  
  class MediaStreamProcessor {
    constructor(websocket, geminiHandler) {
      this.websocket = websocket;
      this.geminiHandler = geminiHandler;
      this.audioBuffer = [];
      this.isProcessing = false;
      this.streamSid = null;
      this.callSid = null;
    }
  
    async handleMessage(message) {
      try {
        console.log('Processing message event:', message.event);
        
        switch (message.event) {
          case 'start':
            this.streamSid = message.start?.streamSid;
            this.callSid = message.start?.callSid;
            console.log('Stream started:', this.streamSid);
            await this.geminiHandler.initialize();
            
            // Send acknowledgment
            this.websocket.send(JSON.stringify({
              event: 'stream_started',
              streamSid: this.streamSid,
              status: 'ready',
              message: 'AI assistant is ready to receive audio'
            }));
            break;
  
          case 'media':
            if (!message.media?.payload) {
              console.warn('Received media message without payload');
              return;
            }
            
            const audioData = message.media.payload;
            await this.processAudioChunk(audioData);
            break;
  
          case 'stop':
            console.log('Stream stopped');
            
            // Send stop acknowledgment
            this.websocket.send(JSON.stringify({
              event: 'stream_stopped',
              streamSid: this.streamSid,
              message: 'Stream ended successfully',
              total_chunks_processed: this.audioBuffer.length
            }));
            
            this.cleanup();
            break;
            
          case 'test':
            // Test message for debugging
            console.log('Test message received');
            this.websocket.send(JSON.stringify({
              event: 'test_response',
              message: 'WebSocket connection is working!',
              timestamp: new Date().toISOString()
            }));
            break;
            
          case 'text_test':
            // Test Gemini API with text input (bypass STT/TTS)
            if (message.text) {
              console.log('Testing Gemini API with text:', message.text);
              try {
                const response = await this.geminiHandler.processText(message.text);
                this.websocket.send(JSON.stringify({
                  event: 'text_response',
                  input: message.text,
                  response: response,
                  timestamp: new Date().toISOString()
                }));
              } catch (error) {
                this.websocket.send(JSON.stringify({
                  event: 'text_error',
                  error: error.message
                }));
              }
            }
            break;
            
          default:
            console.log('Unknown message event:', message.event);
            this.websocket.send(JSON.stringify({
              event: 'unknown_event',
              received_event: message.event,
              message: 'Event type not recognized but connection is working'
            }));
        }
      } catch (error) {
        console.error('Error handling message:', error);
        this.websocket.send(JSON.stringify({
          event: 'error',
          error: error.message,
          stack: error.stack
        }));
      }
    }
  
    async processAudioChunk(base64Audio) {
        // Validate input
        if (!base64Audio || typeof base64Audio !== 'string') {
          console.warn('Invalid audio chunk received:', typeof base64Audio);
          return;
        }
        
        if (base64Audio.length === 0) {
          console.warn('Empty audio chunk received');
          return;
        }
        
        // Log some info about the incoming audio
        console.log(`Audio chunk received - Length: ${base64Audio.length}, Sample: "${base64Audio.substring(0, 20)}..."`);
        
        // Convert base64 to audio buffer
        this.audioBuffer.push(base64Audio);
        
        // Send acknowledgment that we received the audio
        this.websocket.send(JSON.stringify({
          event: 'media_ack',
          streamSid: this.streamSid,
          received_chunks: this.audioBuffer.length,
          chunk_length: base64Audio.length,
          chunk_sample: base64Audio.substring(0, 20)
        }));
        
        // Process audio in smaller chunks initially for testing
        if (this.audioBuffer.length >= 5 && !this.isProcessing) {
            this.isProcessing = true;
            
            try {
                const chunksToProcess = this.audioBuffer.splice(0, 5);
                console.log(`Processing ${chunksToProcess.length} audio chunks`);
                
                // Option 1: Send raw μ-law data directly to transcription
                // Combine all base64 chunks
                const combinedBase64 = chunksToProcess.join('');
                
                // Send directly to transcription (it will handle the conversion)
                const response = await this.geminiHandler.processRawAudio(combinedBase64);
                
                this.websocket.send(JSON.stringify({
                    event: 'transcription_complete',
                    streamSid: this.streamSid,
                    transcription: response
                }));
                
            } catch (error) {
                console.error('Audio processing error:', error);
            } finally {
                this.isProcessing = false;
            }
        }
        
      }
      convertULawToPCM(base64ULaw) {
        try {
          // Validate and clean base64 data
          if (!base64ULaw || typeof base64ULaw !== 'string') {
            console.warn('Invalid base64 input: not a string');
            return new Int16Array(0);
          }
          
          // Remove any whitespace and newlines
          let cleanBase64 = base64ULaw.replace(/\s+/g, '');
          
          // Remove any non-base64 characters (be more permissive)
          cleanBase64 = cleanBase64.replace(/[^A-Za-z0-9+/=]/g, '');
          
          // Skip validation if string is empty after cleaning
          if (cleanBase64.length === 0) {
            console.warn('Empty base64 string after cleaning');
            return new Int16Array(0);
          }
          
          // More lenient base64 validation - just check for basic structure
          if (cleanBase64.length < 4) {
            console.warn('Base64 string too short:', cleanBase64.length);
            return new Int16Array(0);
          }
          
          // Ensure proper padding - be more flexible
          while (cleanBase64.length % 4 !== 0) {
            cleanBase64 += '=';
          }
          
          // Try to decode - if it fails, we'll catch the error
          let ulawData;
          try {
            const binaryString = atob(cleanBase64);
            ulawData = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              ulawData[i] = binaryString.charCodeAt(i);
            }
          } catch (decodeError) {
            console.error('Base64 decode failed:', decodeError);
            console.log('Problematic base64 (first 100 chars):', cleanBase64.substring(0, 100));
            return new Int16Array(0);
          }
          
          // μ-law to linear PCM conversion
          const pcmData = new Int16Array(ulawData.length);
          
          for (let i = 0; i < ulawData.length; i++) {
            pcmData[i] = this.ulawToPcm(ulawData[i]);
          }
          
          console.log(`Successfully converted ${cleanBase64.length} base64 chars to ${pcmData.length} PCM samples`);
          return pcmData;
          
        } catch (error) {
          console.error('Base64 conversion error:', error);
          console.log('Input length:', base64ULaw?.length);
          console.log('Input sample (first 50 chars):', base64ULaw?.substring(0, 50));
          console.log('Input sample (last 50 chars):', base64ULaw?.substring(Math.max(0, base64ULaw.length - 50)));
          
          // Return empty array instead of throwing
          return new Int16Array(0);
        }
      }
    
      ulawToPcm(ulaw) {
        const BIAS = 0x84;
        const CLIP = 32635;
        
        ulaw = ~ulaw;
        const sign = ulaw & 0x80;
        const exponent = (ulaw >> 4) & 0x07;
        const mantissa = ulaw & 0x0F;
        
        let sample = mantissa << (exponent + 3);
        if (exponent !== 0) {
          sample += BIAS << exponent;
        }
        
        return sign ? -sample : sample;
      }
    
      convertPCMToULaw(pcmData) {
        try {
          if (!pcmData || pcmData.length === 0) {
            console.warn('No PCM data to convert');
            return '';
          }
          
          const ulawData = new Uint8Array(pcmData.length);
          
          for (let i = 0; i < pcmData.length; i++) {
            ulawData[i] = this.pcmToUlaw(pcmData[i]);
          }
          
          return btoa(String.fromCharCode(...ulawData));
          
        } catch (error) {
          console.error('PCM to μ-law conversion error:', error);
          return '';
        }
      }
    
      pcmToUlaw(pcm) {
        const BIAS = 0x84;
        const CLIP = 32635;
        
        if (pcm < 0) {
          pcm = -pcm;
          var sign = 0x80;
        } else {
          var sign = 0x00;
        }
        
        if (pcm > CLIP) pcm = CLIP;
        pcm += BIAS;
        
        let exponent = 7;
        for (let exp = 0; exp < 8; exp++) {
          if (pcm <= (0x1F << (exp + 3))) {
            exponent = exp;
            break;
          }
        }
        
        const mantissa = (pcm >> (exponent + 3)) & 0x0F;
        return ~(sign | (exponent << 4) | mantissa);
      }
    
      async sendAudioToTwilio(base64Audio) {
        const mediaMessage = {
          event: 'media',
          streamSid: this.streamSid,
          media: {
            payload: base64Audio
          }
        };
        
        this.websocket.send(JSON.stringify(mediaMessage));
      }
  
    cleanup() {
      this.geminiHandler.cleanup();
      this.audioBuffer = [];
    }
  }
  
  class GeminiHandler {
    constructor(env) {
      this.env = env;
      this.apiKey = env?.GEMINI_API_KEY;
      this.conversationHistory = [];
      this.isInitialized = false;
      
      // Validate API key
      if (!this.apiKey) {
        console.warn('GEMINI_API_KEY not found in environment variables');
      }
    }
  
    async initialize() {
      if (this.isInitialized) return;
      
      try {
        // Initialize Gemini session
        this.conversationHistory.push({
          role: 'user',
          parts: [{ text: 'You are a helpful AI assistant in a phone conversation. Keep responses concise and natural for voice interaction. Respond as if you are speaking directly to the person.' }]
        });
        
        this.isInitialized = true;

        await this.setupAzureRecognizer();
        console.log('Gemini handler initialized');
      } catch (error) {
        console.error('Failed to initialize Gemini handler:', error);
        throw error;
      }
    }
  
    async processAudio(pcmAudio) {
      try {
        // Convert PCM audio to base64 for Gemini API
        const audioBase64 = this.pcmToBase64(pcmAudio);
        
        // Call Gemini API with audio input
        const response = await this.callGeminiAPI(audioBase64);
        
        if (response && response.audioResponse) {
          return this.base64ToPCM(response.audioResponse);
        }
        
        return null;
      } catch (error) {
        console.error('Gemini processing error:', error);
        return null;
      }
    }
  
    pcmToBase64(pcmData) {
      const buffer = new ArrayBuffer(pcmData.length * 2);
      const view = new DataView(buffer);
      
      for (let i = 0; i < pcmData.length; i++) {
        view.setInt16(i * 2, pcmData[i], true);
      }
      
      const bytes = new Uint8Array(buffer);
      return btoa(String.fromCharCode(...bytes));
    }
  
    base64ToPCM(base64) {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const pcmData = new Int16Array(bytes.length / 2);
      
      for (let i = 0; i < pcmData.length; i++) {
        pcmData[i] = (bytes[i * 2 + 1] << 8) | bytes[i * 2];
      }
      
      return pcmData;
    }
    

    async setupAzureRecognizer() {
        console.log(`Setting up Azure recognizer `);
      
        const speechConfig = speechSdk.SpeechConfig.fromSubscription(
          this.env.AZURE_SPEECH_KEY,
          this.env.AZURE_SPEECH_REGION
        );
        speechConfig.speechRecognitionLanguage = 'en-US';
      
        const pushStream = speechSdk.AudioInputStream.createPushStream();
        const audioConfig = speechSdk.AudioConfig.fromStreamInput(pushStream);
        const recognizer = new speechSdk.SpeechRecognizer(speechConfig, audioConfig);
      
        // 🔹 Intermediate results while caller is speaking
        recognizer.recognizing = (s, e) => {
          if (e.result.reason === speechSdk.ResultReason.RecognizingSpeech) {
            console.log(`Partial: "${e.result.text}"`);
          }
        };
      
        // 🔹 Finalized sentences
        recognizer.recognized = async (s, e) => {
          if (e.result.reason === speechSdk.ResultReason.RecognizedSpeech) {
            const transcript = e.result.text;
            console.log(`Final: "${transcript}"`);
            await this.updateCallTranscript(callSid, transcript);
            this.broadcastTranscription(callSid, transcript, 'final');
          } else if (e.result.reason === speechSdk.ResultReason.NoMatch) {
            console.warn(`No speech recognized for`);
          }
        };
      
        recognizer.canceled = (s, e) => {
          console.error(`Recognition canceled: ${e.errorDetails}`);
        };
      
        recognizer.sessionStopped = () => {
          console.log(`Recognition session stopped`);
        };
      
        // 🔹 Must call like this (not with await)
        recognizer.startContinuousRecognitionAsync(
          () => console.log(`Continuous recognition started`),
          err => console.error("Failed to start recognition:", err)
        );
      
        return { recognizer, pushStream };
      }
// Azure Speech API transcription function
async transcribeWithAzureAPI(audioUrl, audioBuffer = null) {
    try {
      let finalAudioBuffer;
  
      if (audioBuffer) {
        // Audio data already provided (for direct upload)
        finalAudioBuffer = audioBuffer;
      } 

      // Convert Twilio μ-law WAV to PCM WAV
        const pcmBuffer = this.convertMuLawToPcmWav(finalAudioBuffer);


      // Configure Azure Speech SDK for REST API
      const speechConfig = speechSdk.SpeechConfig.fromSubscription(this.env.AZURE_SPEECH_KEY, this.env.AZURE_SPEECH_REGION);
      speechConfig.speechRecognitionLanguage = 'en-AU';
      speechConfig.setProperty(
        speechSdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
        "1500" // 1.5 sec pause = end of sentence
      );
  
      const audioConfig = speechSdk.AudioConfig.fromWavFileInput(new Uint8Array(pcmBuffer));
      const recognizer = new speechSdk.SpeechRecognizer(speechConfig, audioConfig);
  
      return new Promise((resolve, reject) => {
        recognizer.recognizeOnceAsync(
          result => {
            if (result.reason === speechSdk.ResultReason.RecognizedSpeech) {
              resolve(result.text || 'No speech detected');
            } else {
              reject(new Error(`Recognition failed: ${result.errorDetails}`));
            }
            recognizer.close();
          },
          error => {
            reject(new Error(`Recognition error: ${error}`));
            recognizer.close();
          }
        );
      });
    } catch (error) {
      console.error('Azure transcription error:', error);
      throw error;
    }
  }
  // Process raw μ-law audio from Twilio
  async processRawAudio(base64MuLawAudio) {
    try {
        console.log('Processing raw μ-law audio, original length:', base64MuLawAudio.length);
        
        // Try multiple approaches to handle the base64 data
        let wavBuffer;
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                attempts++;
                console.log(`Attempt ${attempts} to create WAV buffer`);
                
                if (attempts === 1) {
                    // First attempt: use the data as-is
                    wavBuffer = this.createMuLawWav(base64MuLawAudio);
                } else if (attempts === 2) {
                    // Second attempt: try additional cleaning
                    const extraCleanedAudio = this.extraCleanBase64(base64MuLawAudio);
                    wavBuffer = this.createMuLawWav(extraCleanedAudio);
                } else {
                    // Third attempt: try to salvage what we can
                    const salvagedAudio = this.salvageBase64(base64MuLawAudio);
                    wavBuffer = this.createMuLawWav(salvagedAudio);
                }
                
                if (wavBuffer && wavBuffer.byteLength > 44) {
                    console.log(`Successfully created WAV buffer on attempt ${attempts}`);
                    break;
                }
                
            } catch (attemptError) {
                console.warn(`Attempt ${attempts} failed:`, attemptError.message);
                if (attempts === maxAttempts) {
                    throw attemptError;
                }
            }
        }
        
        if (!wavBuffer || wavBuffer.byteLength <= 44) {
            throw new Error('Failed to create valid WAV buffer after all attempts');
        }
        
        // Send to Azure for transcription
        const transcription = await this.transcribeWithAzureRESTAPI(wavBuffer);
        console.log('Transcription result:', transcription);
        
        if (transcription && transcription.trim() && transcription !== 'No speech detected') {
            // Process with Gemini
            const aiResponse = await this.processText(transcription);
            return aiResponse;
        }
        
        return "No speech detected";
        
    } catch (error) {
        console.error('Raw audio processing error:', error);
        return `Audio processing failed: ${error.message}`;
    }
    
}

    // Robust base64 cleaning function
    cleanBase64(base64String) {
        try {
            if (!base64String || typeof base64String !== 'string') {
                console.warn('Invalid base64 input: not a string');
                return '';
            }
            
            // Remove all whitespace (spaces, tabs, newlines, etc.)
            let cleaned = base64String.replace(/\s+/g, '');
            
            // Remove any characters that aren't valid base64
            // Valid base64 chars: A-Z, a-z, 0-9, +, /, =
            cleaned = cleaned.replace(/[^A-Za-z0-9+/=]/g, '');
            
            if (cleaned.length === 0) {
                console.warn('Empty string after cleaning');
                return '';
            }
            
            // Check for obviously invalid patterns
            if (cleaned.includes('==') && !cleaned.endsWith('==')) {
                console.warn('Invalid padding in middle of string');
            }
            
            if (cleaned.includes('=') && !cleaned.endsWith('=') && !cleaned.endsWith('==')) {
                console.warn('Invalid padding position');
            }
            
            // Ensure proper padding
            const remainder = cleaned.length % 4;
            if (remainder > 0) {
                const paddingNeeded = 4 - remainder;
                cleaned += '='.repeat(paddingNeeded);
                console.log(`Added ${paddingNeeded} padding characters`);
            }
            
            // Final validation - try to validate it's actually valid base64
            if (cleaned.length < 4) {
                console.warn('Base64 string too short after cleaning');
                return '';
            }
            
            // Test decode a small portion to validate
            try {
                const testSample = cleaned.substring(0, Math.min(100, cleaned.length));
                // Ensure test sample has proper padding
                const testRemainder = testSample.length % 4;
                const testString = testRemainder === 0 ? testSample : testSample + '='.repeat(4 - testRemainder);
                atob(testString);
                console.log('Base64 validation test passed');
            } catch (testError) {
                console.warn('Base64 validation test failed:', testError.message);
                console.log('Test string was:', cleaned.substring(0, Math.min(100, cleaned.length)));
                // Don't throw here, maybe the full string is valid even if the sample isn't
            }
            
            return cleaned;
            
        } catch (error) {
            console.error('Base64 cleaning error:', error);
            return '';
        }
    }
    
    // Extra aggressive base64 cleaning
    extraCleanBase64(base64String) {
        try {
            console.log('Applying extra base64 cleaning...');
            
            if (!base64String) return '';
            
            // Start with basic cleaning
            let cleaned = this.cleanBase64(base64String);
            
            if (!cleaned) {
                // Try character-by-character filtering
                cleaned = '';
                for (let i = 0; i < base64String.length; i++) {
                    const char = base64String[i];
                    if (/[A-Za-z0-9+/=]/.test(char)) {
                        cleaned += char;
                    }
                }
                
                // Re-pad
                const remainder = cleaned.length % 4;
                if (remainder > 0) {
                    cleaned += '='.repeat(4 - remainder);
                }
            }
            
            return cleaned;
            
        } catch (error) {
            console.error('Extra cleaning error:', error);
            return '';
        }
    }
    // Salvage whatever base64 data we can
    salvageBase64(base64String) {
        try {
            console.log('Attempting to salvage base64 data...');
            
            if (!base64String) return '';
            
            // Find the longest valid base64 sequence
            const validChars = base64String.match(/[A-Za-z0-9+/=]+/g);
            
            if (!validChars || validChars.length === 0) {
                console.warn('No valid base64 sequences found');
                return '';
            }
            
            // Use the longest sequence
            const longestSequence = validChars.reduce((longest, current) => 
                current.length > longest.length ? current : longest, '');
            
            console.log(`Salvaged ${longestSequence.length} chars from ${base64String.length}`);
            
            // Ensure proper padding
            const remainder = longestSequence.length % 4;
            let salvaged = longestSequence;
            if (remainder > 0) {
                salvaged += '='.repeat(4 - remainder);
            }
            
            // Minimum viable size check
            if (salvaged.length < 100) {
                console.warn('Salvaged data too small to be useful');
                return '';
            }
            
            return salvaged;
            
         
        } catch (error) {
            console.error('Salvage Audio processing error:', error);
        } finally {
            this.isProcessing = false;
        }
    }
// Create a proper μ-law WAV file from base64 μ-law data
createMuLawWav(base64MuLawData) {
    try {
        console.log('=== Base64 Cleaning Debug ===');
        console.log('Original base64 length:', base64MuLawData.length);
        console.log('First 100 chars:', base64MuLawData.substring(0, 100));
        console.log('Last 100 chars:', base64MuLawData.substring(Math.max(0, base64MuLawData.length - 100)));
        
        // Clean and validate base64 data
        let cleanedBase64 = this.cleanBase64(base64MuLawData);
        
        if (!cleanedBase64 || cleanedBase64.length === 0) {
            throw new Error('No valid base64 data after cleaning');
        }
        
        console.log('Cleaned base64 length:', cleanedBase64.length);
        console.log('Cleaned first 50 chars:', cleanedBase64.substring(0, 50));
        
        // Decode base64 to get raw μ-law bytes
        let binaryString;
        try {
            binaryString = atob(cleanedBase64);
        } catch (atobError) {
            console.error('atob failed on cleaned data:', atobError);
            console.log('Problematic base64 sample:', cleanedBase64.substring(0, 200));
            throw new Error(`Base64 decode failed: ${atobError.message}`);
        }
        
        const muLawBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            muLawBytes[i] = binaryString.charCodeAt(i);
        }
        
        console.log('Decoded μ-law data, size:', muLawBytes.length);
        
        // Create WAV header for μ-law format
        const sampleRate = 8000;
        const channels = 1;
        const bitsPerSample = 8;
        const byteRate = sampleRate * channels * (bitsPerSample / 8);
        const blockAlign = channels * (bitsPerSample / 8);
        const dataSize = muLawBytes.length;
        const fileSize = 44 + dataSize - 8;
        
        const wavBuffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(wavBuffer);
        
        // RIFF header
        view.setUint32(0, 0x46464952, true); // 'RIFF'
        view.setUint32(4, fileSize, true);
        view.setUint32(8, 0x45564157, true); // 'WAVE'
        
        // fmt chunk
        view.setUint32(12, 0x20746D66, true); // 'fmt '
        view.setUint32(16, 16, true); // fmt chunk size
        view.setUint16(20, 7, true); // μ-law format (7)
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        
        // data chunk
        view.setUint32(36, 0x61746164, true); // 'data'
        view.setUint32(40, dataSize, true);
        
        // Copy μ-law data
        new Uint8Array(wavBuffer, 44).set(muLawBytes);
        
        console.log('Created μ-law WAV file, total size:', wavBuffer.byteLength);
        return wavBuffer;
        
    } catch (error) {
        console.error('Error creating μ-law WAV:', error);
        throw error;
    }
}

// Updated transcription method that works with the corrected input
async transcribeWithAzureRESTAPI(audioBuffer) {
    try {
        console.log('=== Azure Transcription ===');
        console.log('Input buffer size:', audioBuffer.byteLength);
        
        // The buffer should now be a proper μ-law WAV file
        // Convert it to PCM for Azure (Azure expects PCM, not μ-law)
        const pcmBuffer = this.convertMuLawToPcmWav(audioBuffer);
        
        const baseUrl = `https://${this.env.AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`;
        const params = new URLSearchParams({
            'language': 'en-AU',
            'format': 'detailed',
            'profanity': 'raw'
        });
        
        const url = `${baseUrl}?${params.toString()}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': this.env.AZURE_SPEECH_KEY,
                'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=8000',
                'Accept': 'application/json'
            },
            body: pcmBuffer
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Azure Speech API error: ${response.status} - ${errorText}`);
        }
        
        const result = await response.json();
        console.log('Azure result:', result);
        
        if (result.RecognitionStatus === 'Success' && result.DisplayText) {
            return result.DisplayText.trim();
        } else {
            return 'No speech detected';
        }
        
    } catch (error) {
        console.error('Azure transcription error:', error);
        throw error;
    }
}
    async callGeminiAPI(audioBase64) {
      // Note: Current Gemini API doesn't support direct audio input
      // This is a conceptual implementation - you'll need to use STT first
      
      // For now, let's implement a text-based conversation
      // You would need to convert audio to text first using something like:
      // - Google Speech-to-Text API
      // - OpenAI Whisper API
      // - Assembly AI
      
      try {
        // Placeholder for speech-to-text conversion
        // const transcribedText = await this.speechToText(audioBase64);
        // Transcribe using audio buffer
        const transcribedText = await this.transcribeWithAzureRESTAPI(audioBase64);

        console.log(`transcribed text: ${transcribedText}`);

        if (!transcribedText) return null;
        
        // Add to conversation history
        this.conversationHistory.push({
          role: 'user',
          content: transcribedText
        });
        
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${this.apiKey}`;
        
        const requestBody = {
          contents: this.conversationHistory.slice(-6), // Keep last 6 messages for context
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 150,
            topK: 40,
            topP: 0.95,
          }
        };
  
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
        });
  
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Gemini API error: ${response.status} - ${errorText}`);
          return null;
        }
  
        const data = await response.json();
        
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const text = data.candidates[0].content.parts[0].text;
          
          // Add AI response to conversation history
          this.conversationHistory.push({
            role: 'model',
            content: text
          });
          
          console.log('AI Response:', text);
          
          // Convert text to speech
          return await this.textToSpeech(text);
        }
        
        return null;
      } catch (error) {
        console.error('Gemini API call failed:', error);
        return null;
      }
    }
  
    async processText(text) {
      try {
        if (!this.apiKey) {
          return "Error: GEMINI_API_KEY not configured";
        }
        
        await this.initialize();
        
        // Add user message to conversation history
        this.conversationHistory.push({
          role: 'user',
          parts: [{ text: text }]
        });
        
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${this.apiKey}`;
        
        const requestBody = {
          contents: this.conversationHistory.slice(-6), // Keep last 6 messages for context
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 150,
            topK: 40,
            topP: 0.95,
          }
        };
  
        console.log('Calling Gemini API...');
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
        });
  
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Gemini API error: ${response.status} - ${errorText}`);
          return `API Error: ${response.status} - ${errorText}`;
        }
  
        const data = await response.json();
        
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const responseText = data.candidates[0].content.parts[0].text;
          
          // Add AI response to conversation history
          this.conversationHistory.push({
            role: 'model',
            parts: [{ text: responseText }]
          });
          
          console.log('Gemini Response:', responseText);
          return responseText;
        }
        
        return "No response from Gemini API";
      } catch (error) {
        console.error('Gemini text processing error:', error);
        return `Error: ${error.message}`;
      }
    }
      
  
    async textToSpeech(text) {
      // Placeholder for Text-to-Speech conversion
      // You'll need to integrate with a TTS service like:
      // - Google Cloud Text-to-Speech
      // - Amazon Polly
      // - Azure Cognitive Services
      // - ElevenLabs API
      // - OpenAI TTS API
      
      console.log('Converting to speech:', text);
      
      // Example implementation with Google Cloud TTS:
      /*
      try {
        const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${this.env.GOOGLE_API_KEY}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: { text: text },
            voice: {
              languageCode: 'en-US',
              name: 'en-US-Neural2-F',
              ssmlGender: 'FEMALE'
            },
            audioConfig: {
              audioEncoding: 'LINEAR16',
              sampleRateHertz: 8000
            }
          })
        });
        
        const data = await response.json();
        if (data.audioContent) {
          return this.base64ToPCM(data.audioContent);
        }
      } catch (error) {
        console.error('TTS error:', error);
      }
      */
      
      // For testing, you could generate a simple tone or return null
      return null;
    }
  
    cleanup() {
      this.conversationHistory = [];
      this.isInitialized = false;
    }
  }
  
  // Wrangler configuration (wrangler.toml):
  /*
  name = "twilio-gemini-bridge"
  main = "src/index.js"
  compatibility_date = "2024-01-01"
  node_compat = true
  
  [vars]
  # Required environment variables:
  GEMINI_API_KEY = "your-gemini-api-key"
  # Optional - if using Google services for STT/TTS:
  # GOOGLE_API_KEY = "your-google-cloud-api-key"
  
  # For custom domains:
  # [[routes]]
  # pattern = "your-domain.com/*"
  # zone_name = "your-domain.com"
  
  # If you need to store conversation state:
  # [durable_objects]
  # bindings = [
  #   { name = "CONVERSATION_STATE", class_name = "ConversationState" }
  # ]
  */
// Durable Object for WebSocket handling
export class WebSocketHandler {
    constructor(controller, env) {
      this.controller = controller;
      this.env = env;
      this.sessions = new Set();
      this.pushStreams = new Map();
      this.recognizers = new Map();
      this.audioBuffers = new Map(); // Buffer for accumulating audio chunks
    }
};