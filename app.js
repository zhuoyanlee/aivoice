const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const port = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Environment variables validation
const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'AZURE_SPEECH_KEY',
  'AZURE_SPEECH_REGION'
];

requiredEnvVars.forEach(envVar => {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
});

// Initialize Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Azure Speech configuration
const speechConfig = sdk.SpeechConfig.fromSubscription(
  process.env.AZURE_SPEECH_KEY,
  process.env.AZURE_SPEECH_REGION
);
speechConfig.speechRecognitionLanguage = 'en-US';

// Store active calls and their real-time transcriptions
const activeCalls = new Map();
const activeStreams = new Map();

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Twilio Real-Time Voice-to-Text Backend API',
    endpoints: {
      '/webhook/voice': 'POST - Twilio voice webhook',
      '/webhook/recording': 'POST - Twilio recording webhook (fallback)',
      '/transcribe': 'POST - Direct transcription endpoint',
      '/call/:callSid/transcript': 'GET - Get call transcript',
      '/call/:callSid/realtime': 'GET - Get real-time transcript stream',
      '/ws': 'WebSocket - Real-time transcription updates'
    }
  });
});

// Twilio voice webhook - handles incoming calls with real-time streaming
app.post('/webhook/voice', (req, res) => {
  const { CallSid, From, To, CallStatus } = req.body;
  
  console.log(`Incoming call: ${CallSid} from ${From} to ${To}, status: ${CallStatus}`);
  
  // Initialize call data
  activeCalls.set(CallSid, {
    from: From,
    to: To,
    startTime: new Date(),
    transcriptions: [],
    realtimeTranscript: '',
    status: CallStatus,
    isRealTime: true
  });
  
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Greet the caller
  twiml.say('Hello! Your call is being transcribed in real-time. Please speak clearly.');
  
  // Start media stream for real-time transcription
  const start = twiml.start();
  start.stream({
    name: 'realtime-transcription',
    url: `wss://${req.get('host')}/media-stream`
  });
  
  // Keep the call active and listen
  twiml.say('I\'m listening. Please speak, and I\'ll transcribe what you say in real-time.');
  
  // Pause to allow streaming
  twiml.pause({ length: 30 });
  
  // Optional: Also record as backup
  twiml.record({
    maxLength: 300,
    playBeep: false,
    recordingStatusCallback: '/webhook/recording',
    recordingStatusCallbackEvent: ['completed']
  });
  
  twiml.say('Thank you for your call.');
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// WebSocket server for media streams
wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection');
  
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);
      
      switch (msg.event) {
        case 'start':
          console.log(`Media stream started: ${msg.start.callSid}`);
          await handleStreamStart(ws, msg.start);
          break;
          
        case 'media':
          await handleMediaMessage(ws, msg);
          break;
          
        case 'stop':
          console.log(`Media stream stopped: ${msg.stop.callSid}`);
          await handleStreamStop(ws, msg.stop);
          break;
          
        default:
          console.log('Unknown message type:', msg.event);
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

// Handle stream start
async function handleStreamStart(ws, startData) {
  const { callSid } = startData;
  
  try {
    // Create Azure Speech recognizer for real-time processing
    const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
    const recognizer = new sdk.SpeechRecognizer(speechConfig);
    
    // Create push audio input stream for Azure Speech
    const pushStream = sdk.AudioInputStream.createPushStream();
    const audioConfigFromStream = sdk.AudioConfig.fromStreamInput(pushStream);
    const streamRecognizer = new sdk.SpeechRecognizer(speechConfig, audioConfigFromStream);
    
    // Store stream data
    activeStreams.set(callSid, {
      ws,
      recognizer: streamRecognizer,
      pushStream,
      audioBuffer: Buffer.alloc(0),
      isProcessing: false
    });
    
    // Set up real-time transcription events
    streamRecognizer.recognizing = (sender, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizingSpeech) {
        const partialTranscript = e.result.text;
        console.log(`RECOGNIZING (${callSid}): ${partialTranscript}`);
        
        // Update call data with partial transcript
        const callData = activeCalls.get(callSid);
        if (callData) {
          callData.partialTranscript = partialTranscript;
        }
        
        // Broadcast to WebSocket clients
        broadcastTranscription(callSid, partialTranscript, 'partial');
      }
    };
    
    streamRecognizer.recognized = (sender, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
        const finalTranscript = e.result.text;
        console.log(`RECOGNIZED (${callSid}): ${finalTranscript}`);
        
        // Update call data with final transcript
        const callData = activeCalls.get(callSid);
        if (callData) {
          callData.realtimeTranscript += finalTranscript + ' ';
          callData.transcriptions.push({
            transcript: finalTranscript,
            timestamp: new Date(),
            type: 'realtime'
          });
        }
        
        // Broadcast to WebSocket clients
        broadcastTranscription(callSid, finalTranscript, 'final');
      }
    };
    
    streamRecognizer.canceled = (sender, e) => {
      console.log(`CANCELED (${callSid}): Reason=${e.reason}`);
      if (e.reason === sdk.CancellationReason.Error) {
        console.log(`CANCELED: ErrorDetails=${e.errorDetails}`);
      }
    };
    
    // Start continuous recognition
    streamRecognizer.startContinuousRecognitionAsync(
      () => {
        console.log(`Real-time transcription started for call ${callSid}`);
      },
      (error) => {
        console.error(`Failed to start transcription for ${callSid}:`, error);
      }
    );
    
  } catch (error) {
    console.error('Error setting up real-time transcription:', error);
  }
}

// Handle media message (audio data)
async function handleMediaMessage(ws, msg) {
  const { media } = msg;
  const callSid = media.callSid;
  const streamData = activeStreams.get(callSid);
  
  if (!streamData) return;
  
  try {
    // Convert base64 audio to buffer
    const audioData = Buffer.from(media.payload, 'base64');
    
    // Convert mulaw to linear PCM (Azure Speech expects PCM)
    const pcmData = convertMulawToPcm(audioData);
    
    // Push audio data to Azure Speech stream
    streamData.pushStream.write(pcmData);
    
  } catch (error) {
    console.error('Error processing media message:', error);
  }
}

// Handle stream stop
async function handleStreamStop(ws, stopData) {
  const { callSid } = stopData;
  const streamData = activeStreams.get(callSid);
  
  if (streamData) {
    try {
      // Stop recognition
      streamData.recognizer.stopContinuousRecognitionAsync();
      
      // Close push stream
      streamData.pushStream.close();
      
      // Update call status
      const callData = activeCalls.get(callSid);
      if (callData) {
        callData.status = 'completed';
        callData.endTime = new Date();
      }
      
      // Clean up
      activeStreams.delete(callSid);
      
      console.log(`Real-time transcription ended for call ${callSid}`);
    } catch (error) {
      console.error('Error stopping stream:', error);
    }
  }
}

// Convert mulaw to PCM (simplified conversion)
function convertMulawToPcm(mulawData) {
  // This is a simplified mulaw to PCM conversion
  // For production, use a proper audio conversion library
  const pcmData = Buffer.alloc(mulawData.length * 2);
  
  for (let i = 0; i < mulawData.length; i++) {
    const mulaw = mulawData[i];
    const pcm = mulawToPcm(mulaw);
    pcmData.writeInt16LE(pcm, i * 2);
  }
  
  return pcmData;
}

// Mulaw to PCM conversion lookup
function mulawToPcm(mulaw) {
  const BIAS = 33;
  const CLIP = 32635;
  
  mulaw = ~mulaw;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;
  
  let sample = (mantissa << 3) + BIAS;
  sample <<= exponent;
  
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  if (sample < -CLIP) sample = -CLIP;
  
  return sample;
}

// Broadcast transcription to WebSocket clients
function broadcastTranscription(callSid, transcript, type) {
  const message = JSON.stringify({
    event: 'transcription',
    callSid,
    transcript,
    type,
    timestamp: new Date().toISOString()
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Fallback recording webhook (if real-time fails)
app.post('/webhook/recording', async (req, res) => {
  const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = req.body;
  
  console.log(`Fallback recording completed for call ${CallSid}: ${RecordingUrl}`);
  
  // Only process if real-time transcription wasn't successful
  const callData = activeCalls.get(CallSid);
  if (callData && !callData.realtimeTranscript) {
    try {
      const audioUrl = `${RecordingUrl}.wav`;
      const audioResponse = await axios({
        method: 'GET',
        url: audioUrl,
        responseType: 'stream',
        auth: {
          username: process.env.TWILIO_ACCOUNT_SID,
          password: process.env.TWILIO_AUTH_TOKEN
        }
      });
      
      const audioFilePath = path.join(__dirname, 'uploads', `${RecordingSid}.wav`);
      const writer = fs.createWriteStream(audioFilePath);
      audioResponse.data.pipe(writer);
      
      writer.on('finish', async () => {
        try {
          const transcript = await transcribeAudio(audioFilePath);
          
          callData.transcriptions.push({
            recordingSid: RecordingSid,
            transcript: transcript,
            duration: RecordingDuration,
            timestamp: new Date(),
            type: 'fallback'
          });
          callData.status = 'transcribed';
          
          fs.unlinkSync(audioFilePath);
          
          console.log(`Fallback transcription completed for ${CallSid}:`, transcript);
        } catch (error) {
          console.error('Fallback transcription error:', error);
        }
      });
      
    } catch (error) {
      console.error('Error processing fallback recording:', error);
    }
  }
  
  res.status(200).send('OK');
});

// Get real-time transcript
app.get('/call/:callSid/realtime', (req, res) => {
  const { callSid } = req.params;
  const callData = activeCalls.get(callSid);
  
  if (!callData) {
    return res.status(404).json({ error: 'Call not found' });
  }
  
  res.json({
    callSid: callSid,
    from: callData.from,
    to: callData.to,
    startTime: callData.startTime,
    endTime: callData.endTime,
    status: callData.status,
    realtimeTranscript: callData.realtimeTranscript,
    partialTranscript: callData.partialTranscript,
    transcriptions: callData.transcriptions.filter(t => t.type === 'realtime')
  });
});

// Direct transcription endpoint (unchanged)
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }
  
  try {
    const transcript = await transcribeAudio(req.file.path);
    fs.unlinkSync(req.file.path);
    
    res.json({
      transcript: transcript,
      filename: req.file.originalname
    });
  } catch (error) {
    console.error('Transcription error:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Transcription failed: ' + error.message });
  }
});

// Get call transcript (updated for real-time)
app.get('/call/:callSid/transcript', (req, res) => {
  const { callSid } = req.params;
  const callData = activeCalls.get(callSid);
  
  if (!callData) {
    return res.status(404).json({ error: 'Call not found' });
  }
  
  res.json({
    callSid: callSid,
    from: callData.from,
    to: callData.to,
    startTime: callData.startTime,
    endTime: callData.endTime,
    status: callData.status,
    isRealTime: callData.isRealTime,
    realtimeTranscript: callData.realtimeTranscript,
    transcriptions: callData.transcriptions
  });
});

// Get all calls
app.get('/calls', (req, res) => {
  const calls = Array.from(activeCalls.entries()).map(([callSid, data]) => ({
    callSid,
    ...data
  }));
  
  res.json({ calls });
});

// WebSocket endpoint for real-time updates
app.get('/ws', (req, res) => {
  res.json({
    message: 'WebSocket endpoint for real-time transcription updates',
    usage: 'Connect to ws://localhost:3000 to receive real-time transcription events'
  });
});

// Azure Speech-to-Text function (for fallback)
async function transcribeAudio(audioFilePath) {
  return new Promise((resolve, reject) => {
    try {
      const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(audioFilePath));
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      
      let transcript = '';
      
      recognizer.recognized = (s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
          transcript += e.result.text + ' ';
        }
      };
      
      recognizer.canceled = (s, e) => {
        if (e.reason === sdk.CancellationReason.Error) {
          reject(new Error(`Speech recognition canceled: ${e.errorDetails}`));
        }
        recognizer.stopContinuousRecognitionAsync();
      };
      
      recognizer.sessionStopped = (s, e) => {
        recognizer.stopContinuousRecognitionAsync();
        resolve(transcript.trim());
      };
      
      recognizer.startContinuousRecognitionAsync();
      
      setTimeout(() => {
        recognizer.stopContinuousRecognitionAsync();
      }, 30000);
      
    } catch (error) {
      reject(error);
    }
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeStreams: activeStreams.size,
    activeCalls: activeCalls.size
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Start server
server.listen(port, () => {
  console.log(`Twilio Real-Time Voice-to-Text Backend running on port ${port}`);
  console.log(`Voice Webhook URL: http://localhost:${port}/webhook/voice`);
  console.log(`Media Stream URL: wss://localhost:${port}/media-stream`);
  console.log(`WebSocket URL: ws://localhost:${port}`);
  console.log('Required environment variables:');
  requiredEnvVars.forEach(envVar => {
    console.log(`  ${envVar}: ${process.env[envVar] ? '✓' : '✗'}`);
  });
});

module.exports = { app, server };