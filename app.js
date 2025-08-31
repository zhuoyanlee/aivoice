const express = require('express');
const JsSIP = require('jssip');
const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const EventEmitter = require('events');

// Azure Speech SDK
const sdk = require('microsoft-cognitiveservices-speech-sdk');

// Configuration
const config = {
  port: 3000,
  sip: {
    port: 5060,
    host: '0.0.0.0',
    username: process.env.ONSIP_USERNAME || 'alex',
    password: process.env.ONSIP_PASSWORD || 'your_onsip_password',
    domain: process.env.ONSIP_DOMAIN || 'beanit.onsip.com'
  },
  asterisk: {
    host: process.env.ASTERISK_HOST || 'localhost',
    port: process.env.ASTERISK_PORT || 8088,
    username: process.env.ASTERISK_USERNAME || 'admin',
    password: process.env.ASTERISK_PASSWORD || 'admin'
  },
  azure: {
    speechKey: process.env.AZURE_SPEECH_KEY || 'your_azure_speech_key',
    speechRegion: process.env.AZURE_SPEECH_REGION || 'eastus',
    openaiKey: process.env.OPENAI_API_KEY || 'your_openai_key'
  },
  audio: {
    tempDir: './temp_audio',
    sampleRate: 8000,
    channels: 1,
    format: 'wav'
  }
};

class VoiceCallRouter extends EventEmitter {
  constructor() {
    super();
    this.app = express();
    this.activeCalls = new Map();
    this.setupDirectories();
    this.setupExpress();
    this.setupSIP();
  }

  setupDirectories() {
    if (!fs.existsSync(config.audio.tempDir)) {
      fs.mkdirSync(config.audio.tempDir, { recursive: true });
    }
  }

  setupExpress() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        activeCalls: this.activeCalls.size,
        timestamp: new Date().toISOString()
      });
    });

    // Call status endpoint
    this.app.get('/calls', (req, res) => {
      const calls = Array.from(this.activeCalls.entries()).map(([id, call]) => ({
        id,
        status: call.status,
        startTime: call.startTime,
        duration: Date.now() - call.startTime
      }));
      res.json({ calls });
    });

    // Webhook for Asterisk events
    this.app.post('/asterisk/events', (req, res) => {
      this.handleAsteriskEvent(req.body);
      res.json({ received: true });
    });
  }

  setupSIP() {
    // JsSIP setup for OnSIP integration
    try {
      // Create JsSIP User Agent
      const socket = new JsSIP.WebSocketInterface(`wss://${config.sip.domain}:5061`);
      console.log(`setting up SIP ${config.sip.domain}`)
      this.userAgent = new JsSIP.UA({
        sockets: [socket],
        uri: `sip:${config.sip.username}@${config.sip.domain}`,
        password: config.sip.password,
        realm: config.sip.domain
      });

      // Set up event handlers
      this.userAgent.on('registered', () => {
        console.log('SIP registration successful');
      });

      this.userAgent.on('registrationFailed', (response) => {
        console.error('SIP registration failed:', response.cause);
      });

      this.userAgent.on('invite', (session) => {
        this.handleIncomingCall(session);
      });

      this.userAgent.on('message', (message) => {
        this.handleSIPMessage(message);
      });

      // Start the user agent
      this.userAgent.start();
      console.log(`JsSIP User Agent started for ${config.sip.username}@${config.sip.domain}`);
      
    } catch (error) {
      console.error('Error setting up JsSIP:', error);
    }
  }

  async handleSIPMessage(message) {
    console.log('Received SIP message:', message.request.method);

    switch (message.request.method) {
      case 'MESSAGE':
        await this.handleSIPMessage(message);
        break;
      default:
        console.log('Unhandled SIP method:', message.request.method);
    }
  }

  async handleIncomingCall(session) {
    const callId = this.generateCallId();
    const fromNumber = this.extractPhoneNumber(session.remote_identity.uri.user);
    
    console.log(`Incoming call ${callId} from ${fromNumber}`);

    // Create call session
    const callSession = {
      id: callId,
      fromNumber,
      status: 'ringing',
      startTime: Date.now(),
      sipSession: session,
      asteriskChannel: null,
      speechRecognizer: null,
      speechSynthesizer: null,
      conversationHistory: []
    };

    this.activeCalls.set(callId, callSession);

    try {
      // Accept the call
      session.accept({
        mediaConstraints: { audio: true, video: false },
        pcConfig: {
          iceServers: [
            { urls: ['stun:stun.l.google.com:19302'] }
          ]
        }
      });

      // Set up session event handlers
      session.on('accepted', () => {
        console.log(`Call ${callId} accepted`);
        callSession.status = 'connected';
      });

      session.on('ended', () => {
        console.log(`Call ${callId} ended`);
        this.endCall(callId);
      });

      session.on('failed', (response) => {
        console.error(`Call ${callId} failed:`, response.cause);
        this.endCall(callId);
      });

      // Route to Asterisk
      await this.routeToAsterisk(callSession, session);
      
    } catch (error) {
      console.error('Error handling incoming call:', error);
      session.terminate();
    }
  }

  async routeToAsterisk(callSession, invite) {
    try {
      // Create Asterisk channel via ARI (Asterisk REST Interface)
      const channelData = {
        endpoint: `SIP/${callSession.fromNumber}`,
        extension: 'ai-assistant',
        context: 'ai-context',
        priority: 1,
        callerId: callSession.fromNumber,
        variables: {
          CALL_ID: callSession.id
        }
      };

      const asteriskResponse = await this.makeAsteriskRequest('POST', '/channels', channelData);
      callSession.asteriskChannel = asteriskResponse.id;
      callSession.status = 'connected';

      console.log(`Call ${callSession.id} routed to Asterisk channel ${asteriskResponse.id}`);

      // Setup audio streaming
      await this.setupAudioStreaming(callSession);

    } catch (error) {
      console.error('Error routing to Asterisk:', error);
      callSession.status = 'error';
    }
  }

  async setupAudioStreaming(callSession) {
    try {
      // Setup Azure Speech Recognition
      const speechConfig = sdk.SpeechConfig.fromSubscription(
        config.azure.speechKey, 
        config.azure.speechRegion
      );
      speechConfig.speechRecognitionLanguage = 'en-US';

      // Setup audio config for streaming
      const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      
      callSession.speechRecognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      // Setup speech events
      callSession.speechRecognizer.recognizing = (s, e) => {
        console.log(`RECOGNIZING: Text=${e.result.text}`);
      };

      callSession.speechRecognizer.recognized = async (s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
          console.log(`RECOGNIZED: Text=${e.result.text}`);
          await this.processUserSpeech(callSession, e.result.text);
        }
      };

      callSession.speechRecognizer.canceled = (s, e) => {
        console.log(`CANCELED: Reason=${e.reason}`);
        if (e.reason === sdk.CancellationReason.Error) {
          console.log(`Error details: ${e.errorDetails}`);
        }
      };

      callSession.speechRecognizer.sessionStopped = (s, e) => {
        console.log('Speech recognition session stopped');
        callSession.speechRecognizer.stopContinuousRecognitionAsync();
      };

      // Start continuous recognition
      callSession.speechRecognizer.startContinuousRecognitionAsync();

      // Setup Text-to-Speech
      const ttsConfig = sdk.SpeechConfig.fromSubscription(
        config.azure.speechKey, 
        config.azure.speechRegion
      );
      ttsConfig.speechSynthesisVoiceName = 'en-US-JennyNeural';

      callSession.speechSynthesizer = new sdk.SpeechSynthesizer(ttsConfig);

      console.log(`Audio streaming setup complete for call ${callSession.id}`);

    } catch (error) {
      console.error('Error setting up audio streaming:', error);
    }
  }

  async processUserSpeech(callSession, recognizedText) {
    try {
      console.log(`Processing speech for call ${callSession.id}: "${recognizedText}"`);

      // Add user message to conversation history
      callSession.conversationHistory.push({
        role: 'user',
        content: recognizedText,
        timestamp: new Date().toISOString()
      });

      // Generate AI response using OpenAI
      const aiResponse = await this.generateAIResponse(callSession.conversationHistory);

      // Add AI response to conversation history
      callSession.conversationHistory.push({
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date().toISOString()
      });

      // Convert AI response to speech and play it
      await this.speakResponse(callSession, aiResponse);

    } catch (error) {
      console.error('Error processing user speech:', error);
      await this.speakResponse(callSession, "I'm sorry, I didn't understand that. Could you please repeat?");
    }
  }

  async generateAIResponse(conversationHistory) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.azure.openaiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful AI assistant in a phone conversation. Keep responses concise and natural for spoken dialogue. Avoid using formatting, bullet points, or long explanations.'
            },
            ...conversationHistory
          ],
          max_tokens: 150,
          temperature: 0.7
        })
      });

      const data = await response.json();
      return data.choices[0].message.content.trim();

    } catch (error) {
      console.error('Error generating AI response:', error);
      return "I'm experiencing some technical difficulties. How can I help you today?";
    }
  }

  async speakResponse(callSession, text) {
    try {
      console.log(`Speaking response for call ${callSession.id}: "${text}"`);

      // Generate speech using Azure TTS
      const audioFileName = `${callSession.id}_${Date.now()}.wav`;
      const audioPath = path.join(config.audio.tempDir, audioFileName);

      const audioConfig = sdk.AudioConfig.fromAudioFileOutput(audioPath);
      const synthesizer = new sdk.SpeechSynthesizer(
        callSession.speechSynthesizer.speechConfig, 
        audioConfig
      );

      return new Promise((resolve, reject) => {
        synthesizer.speakTextAsync(text, 
          async (result) => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
              console.log(`Speech synthesis completed for call ${callSession.id}`);
              
              // Play audio through Asterisk
              await this.playAudioThroughAsterisk(callSession, audioPath);
              
              // Cleanup
              synthesizer.close();
              setTimeout(() => {
                if (fs.existsSync(audioPath)) {
                  fs.unlinkSync(audioPath);
                }
              }, 5000);
              
              resolve();
            } else {
              console.error('Speech synthesis failed:', result.errorDetails);
              synthesizer.close();
              reject(new Error(result.errorDetails));
            }
          },
          (error) => {
            console.error('Speech synthesis error:', error);
            synthesizer.close();
            reject(error);
          }
        );
      });

    } catch (error) {
      console.error('Error in speakResponse:', error);
    }
  }

  async playAudioThroughAsterisk(callSession, audioPath) {
    try {
      if (!callSession.asteriskChannel) {
        console.error('No Asterisk channel available for call', callSession.id);
        return;
      }

      // Use Asterisk ARI to play the audio file
      const playData = {
        media: `sound:${audioPath}`,
        lang: 'en'
      };

      await this.makeAsteriskRequest(
        'POST', 
        `/channels/${callSession.asteriskChannel}/play`,
        playData
      );

      console.log(`Audio played through Asterisk for call ${callSession.id}`);

    } catch (error) {
      console.error('Error playing audio through Asterisk:', error);
    }
  }

  async makeAsteriskRequest(method, endpoint, data = null) {
    const url = `http://${config.asterisk.host}:${config.asterisk.port}/ari${endpoint}`;
    const auth = Buffer.from(`${config.asterisk.username}:${config.asterisk.password}`).toString('base64');

    const options = {
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    };

    if (data && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);
    
    if (!response.ok) {
      throw new Error(`Asterisk API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  handleAsteriskEvent(event) {
    console.log('Asterisk event:', event.type);

    switch (event.type) {
      case 'ChannelStateChange':
        this.handleChannelStateChange(event);
        break;
      case 'ChannelDestroyed':
        this.handleChannelDestroyed(event);
        break;
      case 'PlaybackFinished':
        this.handlePlaybackFinished(event);
        break;
      default:
        console.log('Unhandled Asterisk event:', event.type);
    }
  }

  handleChannelStateChange(event) {
    const callSession = this.findCallByAsteriskChannel(event.channel.id);
    if (callSession) {
      console.log(`Channel ${event.channel.id} state changed to ${event.channel.state}`);
      
      if (event.channel.state === 'Up') {
        callSession.status = 'active';
        this.startConversation(callSession);
      }
    }
  }

  async startConversation(callSession) {
    try {
      // Initial greeting
      const greeting = "Hello! I'm your AI assistant. How can I help you today?";
      await this.speakResponse(callSession, greeting);
      
      callSession.conversationHistory.push({
        role: 'assistant',
        content: greeting,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error starting conversation:', error);
    }
  }

  handleChannelDestroyed(event) {
    const callSession = this.findCallByAsteriskChannel(event.channel.id);
    if (callSession) {
      console.log(`Call ${callSession.id} ended - channel destroyed`);
      this.endCall(callSession.id);
    }
  }

  findCallByAsteriskChannel(channelId) {
    for (const [callId, session] of this.activeCalls.entries()) {
      if (session.asteriskChannel === channelId) {
        return session;
      }
    }
    return null;
  }

  async handleCallEnd(bye) {
    const callId = this.extractCallId(bye);
    if (callId) {
      await this.endCall(callId);
    }
  }

  async endCall(callId) {
    const callSession = this.activeCalls.get(callId);
    if (!callSession) return;

    console.log(`Ending call ${callId}`);

    try {
      // Terminate JsSIP session if it exists
      if (callSession.sipSession && callSession.sipSession.isEstablished()) {
        callSession.sipSession.terminate();
      }

      // Cleanup speech resources
      if (callSession.speechRecognizer) {
        callSession.speechRecognizer.stopContinuousRecognitionAsync();
        callSession.speechRecognizer.close();
      }

      if (callSession.speechSynthesizer) {
        callSession.speechSynthesizer.close();
      }

      // Hangup Asterisk channel
      if (callSession.asteriskChannel) {
        await this.makeAsteriskRequest('DELETE', `/channels/${callSession.asteriskChannel}`);
      }

      // Log conversation summary
      console.log(`Call ${callId} summary:`, {
        duration: Date.now() - callSession.startTime,
        messageCount: callSession.conversationHistory.length,
        fromNumber: callSession.fromNumber
      });

    } catch (error) {
      console.error('Error during call cleanup:', error);
    } finally {
      this.activeCalls.delete(callId);
    }
  }

  generateCallId() {
    return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  extractPhoneNumber(uri) {
    // Handle both string URIs and JsSIP URI objects
    if (typeof uri === 'string') {
      const match = uri.match(/sip:(\+?\d+)@/);
      return match ? match[1] : 'unknown';
    } else if (uri && uri.user) {
      return uri.user;
    }
    return 'unknown';
  }

  extractCallId(msg) {
    // Extract call ID from SIP message headers or content
    const callIdHeader = msg.headers['call-id'];
    return callIdHeader || null;
  }

  generateSDP() {
    // Basic SDP for audio call
    return `v=0
o=- ${Date.now()} ${Date.now()} IN IP4 ${config.sip.host}
s=AI Voice Assistant
c=IN IP4 ${config.sip.host}
t=0 0
m=audio 5004 RTP/AVP 0 8
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=sendrecv`;
  }

  async handleCallAcknowledge(ack) {
    console.log('Call acknowledged');
    // Additional setup if needed after ACK
  }

  start() {
    return new Promise((resolve) => {
      this.app.listen(config.port, () => {
        console.log(`AI Voice Call Router started on port ${config.port}`);
        console.log('Configuration:');
        console.log(`- SIP: ${config.sip.host}:${config.sip.port}`);
        console.log(`- Asterisk: ${config.asterisk.host}:${config.asterisk.port}`);
        console.log(`- Azure Speech Region: ${config.azure.speechRegion}`);
        resolve();
      });
    });
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  
  // End all active calls
  const router = global.voiceRouter;
  if (router) {
    for (const [callId] of router.activeCalls.entries()) {
      await router.endCall(callId);
    }
  }
  
  process.exit(0);
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start the application
async function main() {
  try {
    const router = new VoiceCallRouter();
    global.voiceRouter = router;
    await router.start();
    
    console.log('AI Voice Call Router is ready to handle calls!');
    console.log('Make sure your OnSIP account is configured to route calls to this server');
    
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Export for testing
module.exports = { VoiceCallRouter, config };

// Run if this file is executed directly
if (require.main === module) {
  main();
}