// ES Modules format for Cloudflare Workers
import { Router } from 'itty-router';
import * as speechSdk from 'microsoft-cognitiveservices-speech-sdk';

const router = Router();

// Root endpoint
router.get('/', () => {
  return new Response(JSON.stringify({
    message: 'Twilio Real-Time Voice-to-Text Backend API - Cloudflare Workers',
    endpoints: {
      '/webhook/voice': 'POST - Twilio voice webhook',
      '/webhook/recording': 'POST - Twilio recording webhook (fallback)',
      '/transcribe': 'POST - Direct transcription endpoint',
      '/call/:callSid/transcript': 'GET - Get call transcript',
      '/ws': 'WebSocket - Real-time transcription updates',
      '/health': 'GET - Health check'
    }
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
});

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
  const wsUrl = `wss://${url.host}/ws`;

  // TwiML response with Media Stream
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Hello! This is Fong's Kitchen</Say>
    <Start>
        <Stream name="realtime-transcription" url="${wsUrl}" />
    </Start>
    <Say>Talk.</Say>
    <Pause length="1" />
    <Record maxLength="1000" playBeep="true" recordingStatusCallback="/webhook/recording" recordingStatusCallbackEvent="completed" />
    <Say>Thank you for your call.</Say>
</Response>`;

  return new Response(twiml, {
    headers: { 'Content-Type': 'text/xml' }
  });
});

// WebSocket endpoint
router.get('/ws', async (request, env) => {
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  // Get Durable Object instance
  const id = env.WEBSOCKET_HANDLER.idFromName('websocket-session');
  const obj = env.WEBSOCKET_HANDLER.get(id);

  // Forward the request to the Durable Object
  return obj.fetch(request);
});

// Fallback recording webhook
router.post('/webhook/recording', async (request, env) => {
  const formData = await request.formData();
  const callSid = formData.get('CallSid');
  const recordingUrl = formData.get('RecordingUrl');
  const recordingSid = formData.get('RecordingSid');
  const recordingDuration = formData.get('RecordingDuration');

  console.log(`Recording completed for call ${callSid}: ${recordingUrl}`);

  try {
    // Get call data from KV
    const callDataStr = await env.TRANSCRIPTIONS.get(`call:${callSid}`);
    const callData = callDataStr ? JSON.parse(callDataStr) : null;

    if (callData && !callData.realtimeTranscript) {
      // Download audio from Twilio and get buffer
      const audioUrl = `${recordingUrl}.wav`;
      const audioResponse = await fetch(audioUrl, {
        headers: {
          'Authorization': `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`
        }
      });

      if (audioResponse.ok) {
        const audioBuffer = await audioResponse.arrayBuffer();

        // Store in R2 for backup (optional)
        const fileName = `recording-${recordingSid}.wav`;
        await env.AUDIO_BUCKET.put(fileName, audioBuffer);

        // Transcribe using audio buffer
        const transcript = await transcribeWithAzureAPI(null, env, audioBuffer);

        callData.transcriptions.push({
          recordingSid,
          transcript,
          duration: recordingDuration,
          timestamp: new Date().toISOString(),
          type: 'fallback',
          audioFile: fileName
        });
        callData.status = 'transcribed';

        await env.TRANSCRIPTIONS.put(`call:${callSid}`, JSON.stringify(callData));

        console.log(`Fallback transcription completed for ${callSid}:`, transcript);
      } else {
        console.error(`Failed to download recording: ${audioResponse.statusText}`);
      }
    }
  } catch (error) {
    console.error('Error processing fallback recording:', error);
  }

  return new Response('OK');
});

// Direct transcription endpoint
router.post('/transcribe', async (request, env) => {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio');

    if (!audioFile) {
      return new Response(JSON.stringify({ error: 'No audio file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Store audio in R2 bucket
    const fileName = `transcribe-${Date.now()}.wav`;
    await env.AUDIO_BUCKET.put(fileName, audioFile.stream());

    // Get signed URL for Azure Speech API
    const audioUrl = `https://your-domain.com/audio/${fileName}`;
    const transcript = await transcribeWithAzureAPI(audioUrl, env);

    // Clean up
    await env.AUDIO_BUCKET.delete(fileName);

    return new Response(JSON.stringify({
      transcript,
      filename: audioFile.name
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Transcription error:', error);
    return new Response(JSON.stringify({
      error: 'Transcription failed: ' + error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Get call transcript
router.get('/call/:callSid/transcript', async (request, env) => {
  const { callSid } = request.params;

  const callDataStr = await env.TRANSCRIPTIONS.get(`call:${callSid}`);
  if (!callDataStr) {
    return new Response(JSON.stringify({ error: 'Call not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const callData = JSON.parse(callDataStr);

  return new Response(JSON.stringify({
    callSid,
    ...callData
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Get all calls
router.get('/calls', async (request, env) => {
  try {
    // List all call keys from KV
    const list = await env.TRANSCRIPTIONS.list({ prefix: 'call:' });
    const calls = [];

    for (const key of list.keys) {
      const callDataStr = await env.TRANSCRIPTIONS.get(key.name);
      if (callDataStr) {
        const callData = JSON.parse(callDataStr);
        calls.push({
          callSid: key.name.replace('call:', ''),
          ...callData
        });
      }
    }

    return new Response(JSON.stringify({ calls }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Health check
router.get('/health', () => {
  return new Response(JSON.stringify({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    platform: 'cloudflare-workers'
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Azure Speech API transcription function
async function transcribeWithAzureAPI(audioUrl, env, audioBuffer = null) {
  try {
    let finalAudioBuffer;

    if (audioBuffer) {
      // Audio data already provided (for direct upload)
      finalAudioBuffer = audioBuffer;
    } else {
      // Download audio from URL (for Twilio recordings)
      const audioResponse = await fetch(audioUrl, {
        headers: {
          'Authorization': `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`
        }
      });

      if (!audioResponse.ok) {
        throw new Error('Failed to download audio');
      }

      finalAudioBuffer = await audioResponse.arrayBuffer();
    }

    // Configure Azure Speech SDK for REST API
    const speechConfig = speechSdk.SpeechConfig.fromSubscription(env.AZURE_SPEECH_KEY, env.AZURE_SPEECH_REGION);
    speechConfig.speechRecognitionLanguage = 'en-US';
    
    const audioConfig = speechSdk.AudioConfig.fromWavFileInput(new Uint8Array(finalAudioBuffer));
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

// Durable Object for WebSocket handling
export class WebSocketHandler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.pushStreams = new Map();
    this.recognizers = new Map();
    this.audioBuffers = new Map();
  }

  async fetch(request) {
    return await this.handleWebSocket(request);
  }

  async handleWebSocket(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleSession(webSocket) {
    webSocket.accept();
    this.sessions.add(webSocket);

    let callSid = null;
    let recognizer = null;
    let pushStream = null;

    webSocket.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('Twilio event:', message.event);

        switch (message.event) {
          case 'start':
            callSid = message.start.callSid;
            this.audioBuffers.set(callSid, []);
            console.log(`Media stream started: ${callSid}`);

            try {
              const result = await this.setupAzureRecognizer(callSid);
              recognizer = result.recognizer;
              pushStream = result.pushStream;
              this.recognizers.set(callSid, recognizer);
              this.pushStreams.set(callSid, pushStream);
              console.log(`Azure recognizer ready for ${callSid}`);
            } catch (error) {
              console.error(`Failed to setup Azure recognizer: ${error.message}`);
            }
            break;

          case 'media':
            if (recognizer && pushStream && message.media.payload) {
              try {
                const mulawData = Uint8Array.from(atob(message.media.payload), c => c.charCodeAt(0));
                const pcmData = this.convertMulawToPcm(mulawData);
                const wavBuffer = this.createWavChunk(pcmData);
                
                pushStream.write(wavBuffer);
                
                if (parseInt(message.media.chunk) % 10 === 0) {
                  console.log(`Chunk ${message.media.chunk}: ${mulawData.length} µ-law -> ${pcmData.length} PCM -> ${wavBuffer.length} WAV bytes`);
                }
              } catch (error) {
                console.error(`Error processing media chunk ${message.media.chunk}:`, error.message);
              }
            }
            break;

          case 'stop':
            console.log(`Call ${callSid} ended`);
            if (pushStream) {
              pushStream.close();
            }
            if (recognizer) {
              await this.cleanupRecognizer(callSid);
            }
            this.audioBuffers.delete(callSid);
            break;
        }
      } catch (error) {
        console.error('WebSocket message error:', error.message);
      }
    });

    webSocket.addEventListener('close', () => {
      console.log(`Twilio WebSocket closed for ${callSid}`);
      this.sessions.delete(webSocket);
      if (callSid && this.recognizers.has(callSid)) {
        this.cleanupRecognizer(callSid).catch(err => console.error('Cleanup error:', err));
        this.audioBuffers.delete(callSid);
      }
    });
  }

  async setupAzureRecognizer(callSid) {
    try {
      console.log(`Setting up Azure recognizer for ${callSid}`);
      console.log(`Azure Region: ${this.env.AZURE_SPEECH_REGION}`);
      console.log(`Azure Key exists: ${!!this.env.AZURE_SPEECH_KEY}`);
      
      const speechConfig = speechSdk.SpeechConfig.fromSubscription(this.env.AZURE_SPEECH_KEY, this.env.AZURE_SPEECH_REGION);
      speechConfig.speechRecognitionLanguage = 'en-US';
      
      // Configure for streaming audio
      speechConfig.setProperty(speechSdk.PropertyId.SpeechServiceConnection_EnableAudioLogging, "true");
      speechConfig.setProperty(speechSdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, "3000");
      speechConfig.setProperty(speechSdk.PropertyId.Speech_InitialSilenceTimeoutMs, "3000");
      speechConfig.setProperty(speechSdk.PropertyId.Speech_EndSilenceTimeoutMs, "1000");

      // Create push stream with proper audio format
      const audioFormat = speechSdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1);
      const pushStream = speechSdk.AudioInputStream.createPushStream(audioFormat);
      const audioConfig = speechSdk.AudioConfig.fromStreamInput(pushStream);
      
      const recognizer = new speechSdk.SpeechRecognizer(speechConfig, audioConfig);

      // Handle recognition results
      recognizer.recognizing = (s, e) => {
        if (e.result.reason === speechSdk.ResultReason.RecognizingSpeech && e.result.text) {
          console.log(`Recognizing: "${e.result.text}"`);
        }
      };

      recognizer.recognized = async (s, e) => {
        if (e.result.reason === speechSdk.ResultReason.RecognizedSpeech && e.result.text) {
          const transcript = e.result.text.trim();
          console.log(`RECOGNIZED: "${transcript}"`);
          
          await this.updateCallTranscript(callSid, transcript);
          this.broadcastTranscription(callSid, transcript, 'realtime');
        } else if (e.result.reason === speechSdk.ResultReason.NoMatch) {
          console.log(`No speech could be recognized: ${e.result.noMatchReason}`);
        }
      };

      recognizer.canceled = (s, e) => {
        console.error(`Recognition canceled: ${e.reason}, ${e.errorDetails}`);
        if (e.reason === speechSdk.CancellationReason.Error) {
          console.error(`Error details: ${e.errorDetails}`);
        }
      };

      recognizer.sessionStopped = () => {
        console.log(`Recognition session stopped for ${callSid}`);
      };

      // Start continuous recognition
      recognizer.startContinuousRecognitionAsync(
        () => {
          console.log(`Started continuous recognition for ${callSid}`);
        },
        (err) => {
          console.error(`Failed to start recognition: ${err}`);
        }
      );

      return { recognizer, pushStream };
    } catch (error) {
      console.error(`Error in setupAzureRecognizer:`, error);
      throw error;
    }
  }

  async cleanupRecognizer(callSid) {
    const recognizer = this.recognizers.get(callSid);
    const pushStream = this.pushStreams.get(callSid);

    if (recognizer) {
      try {
        recognizer.stopContinuousRecognitionAsync(
          () => {
            console.log(`Recognition stopped for ${callSid}`);
            recognizer.close();
          },
          (err) => {
            console.error(`Error stopping recognition: ${err}`);
            recognizer.close();
          }
        );
        this.recognizers.delete(callSid);
      } catch (error) {
        console.error(`Error cleaning up recognizer: ${error.message}`);
      }
    }

    if (pushStream) {
      try {
        pushStream.close();
        this.pushStreams.delete(callSid);
        console.log(`Push stream closed for ${callSid}`);
      } catch (error) {
        console.error(`Error closing push stream: ${error.message}`);
      }
    }
  }

  convertMulawToPcm(mulawData) {
    // µ-law to linear PCM conversion table (more accurate)
    const mulawToPcm = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
      const mulaw = i;
      const sign = (mulaw & 0x80) ? -1 : 1;
      const exponent = (mulaw >> 4) & 0x07;
      const mantissa = mulaw & 0x0F;
      
      let sample = (mantissa << 3) + 33;
      sample = sample << exponent;
      sample = sample - 33;
      sample = sample * sign;
      
      // Clamp to 16-bit range
      sample = Math.max(-32768, Math.min(32767, sample));
      mulawToPcm[i] = sample;
    }

    const pcmData = new Int16Array(mulawData.length);
    for (let i = 0; i < mulawData.length; i++) {
      pcmData[i] = mulawToPcm[mulawData[i]];
    }

    return pcmData;
  }

  createWavChunk(pcmData) {
    // Convert Int16Array to Uint8Array (little-endian)
    const buffer = new ArrayBuffer(pcmData.length * 2);
    const view = new DataView(buffer);
    
    for (let i = 0; i < pcmData.length; i++) {
      view.setInt16(i * 2, pcmData[i], true); // true for little-endian
    }
    
    return new Uint8Array(buffer);
  }

  // Update call transcript in KV storage
  async updateCallTranscript(callSid, transcript) {
    try {
      const callDataStr = await this.env.TRANSCRIPTIONS.get(`call:${callSid}`);
      if (callDataStr) {
        const callData = JSON.parse(callDataStr);
        callData.realtimeTranscript += transcript + ' ';
        callData.transcriptions.push({
          transcript,
          timestamp: new Date().toISOString(),
          type: 'realtime'
        });

        await this.env.TRANSCRIPTIONS.put(`call:${callSid}`, JSON.stringify(callData));
        console.log(`Updated transcript for ${callSid}: "${transcript}"`);
      } else {
        console.warn(`No call data found for ${callSid}`);
      }
    } catch (error) {
      console.error('Error updating call transcript:', error);
    }
  }

  broadcastTranscription(callSid, transcript, type) {
    const message = JSON.stringify({
      event: 'transcription',
      callSid,
      transcript,
      type,
      timestamp: new Date().toISOString()
    });

    console.log(`Broadcasting to ${this.sessions.size} sessions: "${transcript}"`);
    
    this.sessions.forEach(session => {
      try {
        if (session.readyState === WebSocket.OPEN) {
          session.send(message);
        }
      } catch (error) {
        console.error('Error broadcasting to session:', error);
      }
    });
  }
}

// Main fetch handler
export default {
  async fetch(request, env, ctx) {
    return router.handle(request, env, ctx);
  }
};