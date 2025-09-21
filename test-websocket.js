const WebSocket = require('ws');

const ws = new WebSocket('wss://twilio.beanit-alex-lee.workers.dev/media-stream');

ws.on('open', function open() {
  console.log('Connected to WebSocket');
  
  // Send start message
  ws.send(JSON.stringify({
    event: "start",
    start: {
      streamSid: "MZ123456789abcdef",
      callSid: "CAabcdef1234567890",
      tracks: ["inbound"],
      mediaFormat: {
        encoding: "audio/x-mulaw",
        sampleRate: 8000,
        channels: 1
      }
    }
  }));
  
  // Send dummy media data after 1 second
  setTimeout(() => {
    ws.send(JSON.stringify({
      event: "media",
      sequenceNumber: "1",
      media: {
        track: "inbound",
        chunk: "1",
        timestamp: Date.now().toString(),
        payload: Buffer.from("test audio data").toString('base64')
      },
      streamSid: "MZ123456789abcdef"
    }));
  }, 1000);
  
  // Send stop message after 5 seconds
  setTimeout(() => {
    ws.send(JSON.stringify({
      event: "stop",
      streamSid: "MZ123456789abcdef"
    }));
  }, 5000);
});

ws.on('message', function message(data) {
  console.log('Received:', data.toString());
});

ws.on('close', function close() {
  console.log('Disconnected from WebSocket');
});

ws.on('error', function error(err) {
  console.error('WebSocket error:', err);
});
