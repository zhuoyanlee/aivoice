// ES Modules format for Cloudflare Workers
import { Router } from 'itty-router';

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
    <Say>Hello! Your call is being transcribed in real-time. Please speak clearly.</Say>
    <Start>
        <Stream name="realtime-transcription" url="${wsUrl}" />
    </Start>
    <Say>I'm listening. Please speak, and I'll transcribe what you say in real-time.</Say>
    <Pause length="30" />
    <Record maxLength="300" playBeep="false" recordingStatusCallback="/webhook/recording" recordingStatusCallbackEvent="completed" />
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

    // Call Azure Speech-to-Text REST API
    const speechEndpoint = `https://${env.AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`;

    const speechResponse = await fetch(speechEndpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
        'Content-Type': 'audio/wav',
        'Accept': 'application/json'
      },
      body: finalAudioBuffer
    });

    if (!speechResponse.ok) {
      throw new Error(`Azure Speech API error: ${speechResponse.statusText}`);
    }

    const result = await speechResponse.json();
    return result.DisplayText || result.NBest?.[0]?.Display || 'No speech detected';

  } catch (error) {
    console.error('Azure transcription error:', error);
    throw error;
  }
}

// Durable Object for WebSocket handling
export class WebSocketHandler {
  constructor(controller, env) {
    this.controller = controller;
    this.env = env;
    this.sessions = new Set();
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
    let azureSocket = null;

    webSocket.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.event) {
          case 'start':
            callSid = message.start.callSid;
            console.log(`Media stream started: ${callSid}`);

            this.isFirstChunk = true;   // reset per call
            azureSocket = await this.connectAzureWebSocket(callSid);
            break;


          case 'media':
            console.log("Sending audio chunk:", message.media.payload.byteLength);

            if (azureSocket && azureSocket.readyState === WebSocket.OPEN) {
              const audioData = Uint8Array.from(atob(message.media.payload), c => c.charCodeAt(0));
              const pcmData = this.convertMulawToPcm(audioData);

              // Send first chunk with header, others raw
              const wavChunk = this.createWavBuffer(pcmData, this.isFirstChunk);
              azureSocket.send(wavChunk);

              this.isFirstChunk = false; // flip after first send
            }
            break;

          case 'stop':
            console.log(`Call ${callSid} ended.`);
            azureSocket.send(JSON.stringify({ type: "endOfStream" }));
            if (azureSocket && azureSocket.readyState === WebSocket.OPEN) {
              try {
                // 🔥 Tell Azure no more audio is coming
                azureSocket.send(JSON.stringify({ type: "endOfStream" }));

                // Give Azure a short moment to respond with the last transcript
                setTimeout(() => {
                  azureSocket.close();
                }, 1000);
              } catch (err) {
                console.error("Error sending endOfStream:", err);
                azureSocket.close();
              }
            }
            break;

        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    webSocket.addEventListener('close', () => {
      this.sessions.delete(webSocket);
      if (azureSocket) {
        azureSocket.close();
      }
    });
  }


  async processMediaMessage(message, callSid) {
    const { media } = message;

    try {
      const audioData = Uint8Array.from(atob(media.payload), c => c.charCodeAt(0));
      const pcmData = this.convertMulawToPcm(audioData);

      const transcript = await this.transcribeRealTime(pcmData, callSid);

      if (transcript) {
        await this.updateCallTranscript(callSid, transcript);
        this.broadcastTranscription(callSid, transcript, 'realtime');
        console.log(`Real-time transcript for ${callSid}: ${transcript}`);
      }
    } catch (error) {
      console.error('Error processing real-time audio:', error);
    }
  }

  // Convert mulaw to PCM for Azure Speech (Workers-compatible)
  convertMulawToPcm(mulawData) {
    const pcmData = new Int16Array(mulawData.length);

    for (let i = 0; i < mulawData.length; i++) {
      const mulaw = mulawData[i];

      // Mulaw to linear PCM conversion
      const sign = (mulaw & 0x80) !== 0;
      const exponent = (mulaw >> 4) & 0x07;
      const mantissa = mulaw & 0x0F;

      let sample = ((mantissa << 3) + 33) << exponent;

      if (sign) sample = -sample;

      // Clamp to 16-bit range
      sample = Math.max(-32768, Math.min(32767, sample));
      pcmData[i] = sample;
    }

    return pcmData.buffer;
  }
  async getAzureToken() {
    const resp = await fetch(`https://${this.env.AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST',
      headers: {
        "Content-type": "application/x-www-form-urlencoded",
        "Content-length": 0, 
        "Ocp-Apim-Subscription-Key": this.env.AZURE_SPEECH_KEY
      }
    });

    if (!resp.ok) {
      throw new Error(`Azure token request failed: ${resp.status}`);
    }

    return await resp.text(); // JWT token string
  }

  async connectAzureWebSocket(callSid) {
    const token = await this.getAzureToken();

    const url = `wss://${this.env.AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed&authorization=Bearer%20${encodeURIComponent(token)}`;

    const ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      console.log(`Azure WebSocket connected for call ${ callSid }`);
    });

    ws.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log(`data: ${ data } `);
        if (data.RecognitionStatus === "Success" && data.DisplayText) {
          const transcript = data.DisplayText;

          await this.updateCallTranscript(callSid, transcript);
          this.broadcastTranscription(callSid, transcript, 'realtime');

          console.log(`Azure transcript[${ callSid }]: ${ transcript } `);
        }
        if (data.type === "speech.hypothesis" || data.type === "speech.phrase") {
          console.log("Transcript:", data.text);

        }
      } catch (err) {
        console.error("Azure WebSocket message error:", err);
      }
    });

    ws.addEventListener('close', () => {
      console.log(`Azure WebSocket closed for call ${ callSid }`);
    });

    ws.addEventListener('error', (err) => {
      console.error(`Azure WebSocket error for ${ callSid }: `, err);
    });

    return ws;
  }

  // Real-time transcription using Azure Speech API
  async transcribeRealTime(pcmBuffer, callSid) {
    try {
      const speechEndpoint = `https://${this.env.AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=simple`;

    const response = await fetch(speechEndpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.env.AZURE_SPEECH_KEY,
        'Content-Type': 'audio/wav',
        'Accept': 'application/json'
      },
      body: this.createWavBuffer(pcmBuffer)
    });

    if (response.ok) {
      const result = await response.json();
      return result.DisplayText || '';
    }

  } catch(error) {
    console.error('Azure real-time transcription error:', error);
  }

    return null;
  }

// Create WAV buffer for Azure Speech API
// Create WAV buffer for Azure Speech API (streaming mode)
createWavBuffer(pcmBuffer, includeHeader = false) {
  const sampleRate = 8000; // Twilio uses 8kHz
  const channels = 1;
  const bitsPerSample = 16;

  if (!includeHeader) {
    // Subsequent chunks → just raw PCM
    return pcmBuffer;
  }

  // First chunk → include WAV header
  const wavHeader = new ArrayBuffer(44);
  const view = new DataView(wavHeader);

  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcmBuffer.byteLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1 size
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, pcmBuffer.byteLength, true);

  const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength);
  new Uint8Array(wavBuffer).set(new Uint8Array(wavHeader), 0);
  new Uint8Array(wavBuffer).set(new Uint8Array(pcmBuffer), wavHeader.byteLength);

  return wavBuffer;
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

  this.sessions.forEach(session => {
    try {
      session.send(message);
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